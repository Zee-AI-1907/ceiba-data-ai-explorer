"""live_benchmark.py — the 2026-07 prompt × enrichment × model matrix, driven
against real staging with the real `generate_sql` pipeline.

12 cells = {baseline, strict} prompt × {non-enriched, enriched} bundle ×
{gpt-5.4-mini, gpt-5.4-nano, gpt-5.6-luna} runtime model. Each cell runs the 10
`live_bench_queries` N times, comparing the pipeline's executed result to the
reference result (both against the same staging data, same moment). Reports
per-cell pass-rate, per-step latency (retrieve/generate/execute), tokens, cost.

`compare()` is the hermetic, unit-tested core; `run_cell`/`main` need staging +
network and are exercised by the actual benchmark run, not the test suite.
"""
from __future__ import annotations
import asyncio
import os
import time
import urllib.parse
from dataclasses import dataclass, field

import sqlalchemy as sa
import sqlglot
from sqlglot import exp

from ceiba_nl2sql.engine.base import AttachSpec, ExecuteOptions
from ceiba_nl2sql.engine.duckdb_engine import DuckDbEngine
from ceiba_nl2sql.retrieval.retriever import HybridRetriever, RetrieveOptions
from ceiba_nl2sql.generation.pipeline import GenerateOptions, GenerationError, generate_sql
from ceiba_nl2sql.generation.llm import OpenAiLlmClient
from ceiba_nl2sql.embed.local_embedder import FastEmbedEmbedder
from ceiba_nl2sql_eval.live_bench_queries import QUERIES, BenchQuery

RUNTIME_MODELS = ["gpt-5.4-mini", "gpt-5.4-nano", "gpt-5.6-luna"]


# ── comparison core (hermetic; unit-tested in test_live_benchmark.py) ─────────

def _rows_to_tuples(rows) -> list[tuple]:
    """Normalize engine result rows (list[dict]) or DBAPI rows (tuples) to a
    list of value-tuples, so generated and reference results compare uniformly.
    """
    out: list[tuple] = []
    for r in rows:
        if isinstance(r, dict):
            out.append(tuple(r.values()))
        elif isinstance(r, (list, tuple)):
            out.append(tuple(r))
        else:
            out.append((r,))
    return out


def _first_scalar(rows: list[tuple]):
    if not rows or not rows[0]:
        return None
    return rows[0][0]


def _as_float(value):
    try:
        return float(value)
    except (TypeError, ValueError):
        return None


def compare(mode: str, got_rows, ref_rows, *, tol_frac: float = 0.02) -> bool:
    """True iff the pipeline's result matches the reference under `mode`.

    - scalar/value: the leading cell of the first row is equal within
      max(1, tol_frac*|ref|) (tolerance absorbs live-data time drift between the
      two executions). Non-numeric → exact equality.
    - group_top/topk_keys: the SET of column-0 keys is equal (order- and
      count-free) — the pipeline may order or alias differently.
    """
    got = _rows_to_tuples(got_rows)
    ref = _rows_to_tuples(ref_rows)
    if mode in ("scalar", "value"):
        g, r = _first_scalar(got), _first_scalar(ref)
        gf, rf = _as_float(g), _as_float(r)
        if gf is None or rf is None:
            return g == r
        return abs(gf - rf) <= max(1.0, tol_frac * abs(rf))
    if mode in ("group_top", "topk_keys"):
        gk = {row[0] for row in got if row}
        rk = {row[0] for row in ref if row}
        return gk == rk and len(gk) > 0
    raise ValueError(f"unknown compare mode: {mode!r}")


# ── coverage guard (hermetic; unit-tested) ────────────────────────────────────
# The sql_only scorer's `joins_ok` check is blind to UNDER-answering: a
# zero-join `SELECT count(*) FROM Patients` has no Join nodes, so it trivially
# satisfies "every join ⊆ declared edges" and scores as a PASS — the exact
# failure luna+strict exhibits. The coverage guard closes that blind spot by
# requiring the generated SQL's STRUCTURAL SHAPE to match or exceed the
# reference query's shape (join count / grouping / table count), derived
# automatically from `reference_sql` so there is no hand-maintained metadata to
# drift. It does NOT touch prep/join_check.py (whose "joins ⊆ declared" contract
# is correct and stays narrow) — this is a benchmark-scorer change only.

def _sql_shape(sql: str, *, dialect: str) -> tuple[int, bool, int]:
    """(join_count, has_group_by, distinct_table_count) over the WHOLE parse
    tree, so joins/groups nested in subqueries or CTEs (the anti-join's NOT
    EXISTS, the avg-SpO2 wrapped aggregate) are counted too.
    """
    parsed = sqlglot.parse_one(sql, read=dialect)
    join_count = len(list(parsed.find_all(exp.Join)))
    has_group_by = parsed.find(exp.Group) is not None
    table_count = len({t.name.lower() for t in parsed.find_all(exp.Table) if t.name})
    return join_count, has_group_by, table_count


def sql_coverage_ok(gen_sql: str, ref_sql: str, *, dialect: str) -> bool:
    """True iff the generated SQL is structurally at least as complete as the
    reference: at least as many joins, a GROUP BY whenever the reference groups,
    and at least as many distinct base tables. Catches under-answering that
    `joins_ok` cannot see.
    """
    try:
        gen_joins, gen_group, gen_tables = _sql_shape(gen_sql, dialect=dialect)
    except sqlglot.errors.SqlglotError:
        # An unparseable generation cannot be confirmed structurally complete —
        # fail closed. (It has almost certainly already failed the EXPLAIN-binds
        # check too; this just guarantees we never raise out of the scorer.)
        return False
    ref_joins, ref_group, ref_tables = _sql_shape(ref_sql, dialect=dialect)
    return (
        gen_joins >= ref_joins
        and (gen_group or not ref_group)
        and gen_tables >= ref_tables
    )


# ── staging stack + cell runner (needs network/DB) ────────────────────────────

def _duckdb_dsn(password: str) -> str:
    enc = urllib.parse.quote(password, safe="")
    return f"postgresql://CeibaSa:{enc}@localhost:55432/CeibaHospitalDB"


def _sa_dsn(password: str) -> str:
    enc = urllib.parse.quote(password, safe="")
    return f"postgresql+psycopg://CeibaSa:{enc}@localhost:55432/CeibaHospitalDB"


@dataclass
class QueryStats:
    query_id: str
    passes: int = 0
    runs: int = 0
    gen_ms: list[int] = field(default_factory=list)
    retrieve_ms: list[int] = field(default_factory=list)
    execute_ms: list[int] = field(default_factory=list)
    prompt_tok: list[int] = field(default_factory=list)
    completion_tok: list[int] = field(default_factory=list)
    cost: list[float] = field(default_factory=list)
    llm_calls: list[int] = field(default_factory=list)
    # sql-only mode: per-run generated SQL + structural checks
    binds: list[bool] = field(default_factory=list)
    joins_ok: list[bool] = field(default_factory=list)
    # coverage guard: does the generated SQL's shape match/exceed the reference
    # (catches under-answering that joins_ok is blind to). gen_join_count is
    # kept alongside so the report can separate "invented join" (joins_ok False)
    # from "under-answered" (coverage_ok False).
    coverage_ok: list[bool] = field(default_factory=list)
    gen_join_count: list[int] = field(default_factory=list)
    sqls: list[str] = field(default_factory=list)

    @property
    def pass_rate(self) -> float:
        return self.passes / self.runs if self.runs else 0.0


def _build_stack(bundle_dir: str, model: str, password: str):
    embedder = FastEmbedEmbedder()
    retriever = HybridRetriever(
        embed_query=lambda t: embedder.embed_documents([t])[0],
        dialect="duckdb",
        expected_embedding_model_id="bge-small-en-v1.5",
    )
    retriever.load(bundle_dir)
    engine = DuckDbEngine()
    engine.attach([AttachSpec(source_id="staging", engine="postgres",
                              dsn=_duckdb_dsn(password), read_only=True, alias="staging")])
    llm = OpenAiLlmClient(api_key=os.environ["OPENAI_API_KEY"], model=model)
    return retriever, engine, llm


def _load_edges(bundle_dir: str) -> list[dict]:
    import json
    with open(f"{bundle_dir}/joingraph.json") as f:
        return json.load(f).get("edges", [])


async def run_cell(bundle_dir: str, strict_prompt: bool, model: str, runs: int, password: str,
                   *, sql_only: bool = True) -> dict:
    """Run all 10 queries `runs` times against one (bundle, prompt, model) cell.

    sql_only=True (default, exploratory): score the GENERATED SQL without
    executing — pass = EXPLAIN binds AND every join predicate is a declared FK
    edge. Fast (no data scan) and captures the failure modes (invalid SQL /
    invented joins). The generated SQL is recorded for qualitative comparison.
    sql_only=False: execute the generated SQL and compare its result to the
    reference result (slower; needs bounded deadlines).
    """
    from prep.enrich.join_check import join_predicates_are_declared

    retriever, engine, llm = _build_stack(bundle_dir, model, password)
    edges = _load_edges(bundle_dir)
    dialect = engine.dialect()
    sa_engine = None
    if not sql_only:
        sa_engine = sa.create_engine(_sa_dsn(password),
                                     connect_args={"options": "-c default_transaction_read_only=on"})
    options = GenerateOptions(strict_join_steering=strict_prompt)
    stats: list[QueryStats] = []
    for q in QUERIES:
        s = QueryStats(query_id=q.id)
        for _ in range(runs):
            s.runs += 1
            try:
                t0 = time.monotonic()
                retriever.retrieve(q.question, RetrieveOptions(token_budget=2500, max_tables=6))
                s.retrieve_ms.append(int((time.monotonic() - t0) * 1000))
                tg = time.monotonic()
                resp = await asyncio.wait_for(
                    generate_sql(question=q.question, engine=engine,
                                 retriever=retriever, llm=llm, options=options),
                    timeout=90,
                )
                s.gen_ms.append(int((time.monotonic() - tg) * 1000))
                u = resp.usage
                s.prompt_tok.append(getattr(u, "prompt_tokens", 0))
                s.completion_tok.append(getattr(u, "completion_tokens", 0))
                s.cost.append(getattr(u, "estimated_cost_usd", 0.0))
                s.llm_calls.append(getattr(u, "llm_calls", 0))
                s.sqls.append(resp.sql)
                if sql_only:
                    binds = bool(getattr(engine.explain(resp.sql), "ok", False))
                    joins_ok = join_predicates_are_declared(resp.sql, edges, dialect=dialect)[0]
                    coverage = sql_coverage_ok(resp.sql, q.reference_sql, dialect=dialect)
                    s.binds.append(binds)
                    s.joins_ok.append(joins_ok)
                    s.coverage_ok.append(coverage)
                    try:
                        s.gen_join_count.append(_sql_shape(resp.sql, dialect=dialect)[0])
                    except sqlglot.errors.SqlglotError:
                        s.gen_join_count.append(0)
                    # coverage closes the joins_ok blind spot: a zero-join
                    # under-answer no longer scores as a pass.
                    if binds and joins_ok and coverage:
                        s.passes += 1
                else:
                    with sa_engine.connect() as c:
                        ref_rows = c.exec_driver_sql(q.reference_sql).fetchall()
                    te = time.monotonic()
                    got_rows = engine.execute(resp.sql, ExecuteOptions(max_rows=1000, deadline_ms=12_000)).rows
                    s.execute_ms.append(int((time.monotonic() - te) * 1000))
                    if compare(q.compare_mode, got_rows, ref_rows):
                        s.passes += 1
            except (GenerationError, Exception):  # noqa: BLE001 - a failed run is a non-pass, not fatal
                pass
        stats.append(s)
    engine.dispose()
    if sa_engine is not None:
        sa_engine.dispose()
    return {"model": model, "strict_prompt": strict_prompt, "bundle_dir": bundle_dir, "stats": stats}


async def probe_model_async(model: str) -> bool:
    """True iff the configured key can call `model` (cheap 1-token probe).
    Async so it can be awaited from inside `run_matrix`'s event loop (calling
    `asyncio.run` there would raise 'cannot be called from a running loop')."""
    from ceiba_nl2sql.generation.llm import call_llm
    try:
        llm = OpenAiLlmClient(api_key=os.environ["OPENAI_API_KEY"], model=model)
        await call_llm(llm, "reply: ok", "schema-metadata")
        return True
    except Exception:
        return False


def probe_model(model: str) -> bool:
    """Synchronous wrapper for standalone use (NOT from within an event loop)."""
    return asyncio.run(probe_model_async(model))


async def run_matrix(base_bundle: str, enriched_bundle: str, runs: int, password: str,
                     models: list[str] | None = None) -> list[dict]:
    """Drive the full prompt × enrichment × model matrix. Probes each model
    first and SKIPS (logs) any cell whose model the key cannot call.
    """
    models = models or RUNTIME_MODELS
    available = [m for m in models if await probe_model_async(m)]
    skipped = [m for m in models if m not in available]
    if skipped:
        print(f"[skip] models not callable by this key: {skipped}")
    cells: list[dict] = []
    bundles = [("non_enriched", base_bundle), ("enriched", enriched_bundle)]
    for model in available:
        for enrich_label, bundle in bundles:
            for strict in (False, True):
                label = f"{model} | {enrich_label} | prompt={'strict' if strict else 'baseline'}"
                print(f"[run] {label}")
                cell = await run_cell(bundle, strict, model, runs, password)
                cell["enrich_label"] = enrich_label
                cell["label"] = label
                cells.append(cell)
    return cells
