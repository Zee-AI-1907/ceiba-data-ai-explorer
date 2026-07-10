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


async def run_cell(bundle_dir: str, strict_prompt: bool, model: str, runs: int, password: str) -> dict:
    """Run all 10 queries `runs` times against one (bundle, prompt, model) cell."""
    retriever, engine, llm = _build_stack(bundle_dir, model, password)
    sa_engine = sa.create_engine(_sa_dsn(password),
                                 connect_args={"options": "-c default_transaction_read_only=on"})
    options = GenerateOptions(strict_join_steering=strict_prompt)
    stats: list[QueryStats] = []
    for q in QUERIES:
        s = QueryStats(query_id=q.id)
        for _ in range(runs):
            s.runs += 1
            # reference result, same moment
            with sa_engine.connect() as c:
                ref_rows = c.exec_driver_sql(q.reference_sql).fetchall()
            try:
                t0 = time.monotonic()
                retriever.retrieve(q.question, RetrieveOptions(token_budget=2500, max_tables=6))
                s.retrieve_ms.append(int((time.monotonic() - t0) * 1000))
                tg = time.monotonic()
                resp = await generate_sql(question=q.question, engine=engine,
                                          retriever=retriever, llm=llm, options=options)
                s.gen_ms.append(int((time.monotonic() - tg) * 1000))
                u = resp.usage
                s.prompt_tok.append(getattr(u, "prompt_tokens", 0))
                s.completion_tok.append(getattr(u, "completion_tokens", 0))
                s.cost.append(getattr(u, "estimated_cost_usd", 0.0))
                s.llm_calls.append(getattr(u, "llm_calls", 0))
                te = time.monotonic()
                got_rows = engine.execute(resp.sql, ExecuteOptions(max_rows=1000)).rows
                s.execute_ms.append(int((time.monotonic() - te) * 1000))
                if compare(q.compare_mode, got_rows, ref_rows):
                    s.passes += 1
            except (GenerationError, Exception):  # noqa: BLE001 - a failed run is a non-pass, not fatal
                pass
        stats.append(s)
    engine.dispose()
    sa_engine.dispose()
    return {"model": model, "strict_prompt": strict_prompt, "bundle_dir": bundle_dir, "stats": stats}


def probe_model(model: str) -> bool:
    """True iff the configured key can call `model` (cheap 1-token probe)."""
    async def _probe():
        llm = OpenAiLlmClient(api_key=os.environ["OPENAI_API_KEY"], model=model)
        from ceiba_nl2sql.generation.llm import call_llm
        await call_llm(llm, "reply: ok", "schema-metadata")
    try:
        asyncio.run(_probe())
        return True
    except Exception:
        return False


async def run_matrix(base_bundle: str, enriched_bundle: str, runs: int, password: str,
                     models: list[str] | None = None) -> list[dict]:
    """Drive the full prompt × enrichment × model matrix. Probes each model
    first and SKIPS (logs) any cell whose model the key cannot call.
    """
    models = models or RUNTIME_MODELS
    available = [m for m in models if probe_model(m)]
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
