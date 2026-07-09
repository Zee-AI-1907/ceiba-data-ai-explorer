"""pipeline.py — the NL->SQL generation pipeline + self-repair loop (ports
lib/rag/generate.ts's `generateSql` verbatim; docs/PYTHON_NL2SQL_SERVICE_PLAN.md
§1.1, §2.2, §2.3, §2.5, §3.1 `generation/pipeline.py`).

── The pipeline (mirrors NL2SQL_SPEC.md §5.1) ────────────────────────────────
  question (untrusted)
    -> [A] retrieve          retriever.retrieve(question)         -> SchemaContext
    -> [B] assemble prompt    assemble_prompt(ctx, question, caps) (H25-delimited)
    -> [C] LLM                call_llm(llm, prompt, egress_class) -> candidate text
    -> [D] extract SQL        strip code fences / prose            -> sql
    -> [E] guard_sql          reject non-read / unsafe / multi-stmt
    -> [F] cardinality_guard  pass | repair (LIMIT) | reject (unbounded scan)
    -> [G] engine.explain     dry-run validate (NO rows egress)
    -> self-repair (<= 2 rounds) on any [E]/[F]/[G] failure that is repairable
  -> final read-only SQL (executed later by POST /nl2sql/execute, NOT here)

── EGRESS GATE ────────────────────────────────────────────────────────────────
The prompt the LLM receives contains SCHEMA / METADATA / GLOSSARY / EXEMPLARS
ONLY — never a raw patient-row value. Every LLM call goes through
`call_llm`, which takes an `egress_class` and enforces `assert_egress_allowed()`
for anything `patient-derived`. Today the only class used is
`schema-metadata` (always allowed).

── explain-not-execute ────────────────────────────────────────────────────────
The repair VALIDATOR is `engine.explain()`, never `engine.execute()` — zero
data rows ever cross this pipeline. `execute()` only ever runs later, on the
(re-guarded) returned SQL, at POST /nl2sql/execute.

── The generated SQL is UNTRUSTED ────────────────────────────────────────────
The returned `sql` is untrusted model output. This module's guard_sql /
cardinality_guard passes are a generation-time quality gate, not the
execution security boundary — `/nl2sql/execute` re-guards before running
anything (mirrors NL2SQL_SPEC.md invariant §8.6, plan §1.3).
"""

from __future__ import annotations

import json
import re
import time
from dataclasses import dataclass, field
from typing import Awaitable, Callable, TypeVar

_T = TypeVar("_T")

# An "offloader": runs a blocking callable and awaits its result. The default
# (`_direct_offload`) just calls it inline (used by prep + the hermetic tests,
# which have no event loop to protect). The FastAPI service injects one backed
# by Starlette's `run_in_threadpool`, so the pipeline's BLOCKING segments
# (retriever.retrieve — embed + BM25; engine.explain — DuckDB) do not stall the
# event loop and serialize every concurrent request (PYTHON_NL2SQL_SERVICE_PLAN
# §2.2 event-loop-blocking fix).
Offload = Callable[..., Awaitable]

from ceiba_nl2sql.engine.base import EngineCapabilities, ExecuteOptions, PlanError, PlanOk, QueryEngine, SqlDialect
from ceiba_nl2sql.generation.llm import DEFAULT_LLM_MODEL, LlmClient, TokenUsage, call_llm
from ceiba_nl2sql.generation.pricing import estimate_cost_usd
from ceiba_nl2sql.generation.prompt import assemble_prompt, assemble_repair_prompt
from ceiba_nl2sql.guard.cardinality import cardinality_guard_from_context
from ceiba_nl2sql.guard.explain_estimate import (
    ExplainRunner,
    LargeTableStat,
    evaluate_plan_estimate,
    pg_explain_estimate,
)
from ceiba_nl2sql.retrieval.retriever import HybridRetriever, RetrieveOptions, SchemaContext
from ceiba_nl2sql.sqltools.guard import TableAllowlistCheck, guard_sql

DEFAULT_TOKEN_BUDGET = 2500
DEFAULT_MAX_TABLES = 6
DEFAULT_MAX_REPAIR_ROUNDS = 2
DEFAULT_LIMIT = 1000

# Out-of-scope sentinel a model may return (unchanged legacy semantics).
_SCOPE_SENTINEL = re.compile(r'^\s*\{?\s*"?error"?\s*:?\s*"?scope"?\s*\}?\s*$', re.IGNORECASE)


class GenerationError(RuntimeError):
    """Thrown when the pipeline cannot produce guard-passing, explain-clean
    SQL within the repair budget. Mirrors lib/rag/generate.ts `GenerationError`.
    """

    def __init__(
        self,
        message: str,
        *,
        rounds: int,
        last_error: str | None = None,
        usage: "UsageSummary | None" = None,
    ) -> None:
        super().__init__(message)
        self.rounds = rounds
        self.last_error = last_error
        # Usage metered up to the point generation gave up — so even a failed
        # generate request reports the tokens/cost it burned (Phase 3).
        self.usage = usage


@dataclass(frozen=True)
class RetrievalSummary:
    tables: list[str]
    exemplars_used: list[str]
    cardinality_warnings: list[str]


@dataclass(frozen=True)
class RepairInfo:
    rounds: int
    last_error: str | None = None


@dataclass(frozen=True)
class UsageSummary:
    """Per-request LLM cost/token metering (Phase 3 KEY deliverable). Sums the
    token usage across EVERY LLM call in a generate request — the initial call
    PLUS every self-repair round — and prices it in USD from the pricing table
    (generation/pricing.py). `llm_calls` is the total number of LLM calls
    (1 + repair rounds). `estimated_cost_usd` is 0.0 when the model has no
    price in the table (`priced=False`), so the number is never fabricated.
    """

    model: str
    prompt_tokens: int
    completion_tokens: int
    total_tokens: int
    llm_calls: int
    estimated_cost_usd: float
    latency_ms: int
    priced: bool = True


@dataclass(frozen=True)
class SqlGenerateResponse:
    """Mirrors lib/rag/generate.ts `SqlGenerateResponse` verbatim — this is
    the shape the FastAPI layer serializes back to the TS caller unchanged,
    plus an additive `usage` block (Phase 3 per-query cost metering).
    """

    sql: str
    description: str
    dialect: SqlDialect
    retrieval: RetrievalSummary
    cached: bool
    repair: RepairInfo | None = None
    error: str | None = None  # 'scope' iff out-of-clinical-scope
    usage: UsageSummary | None = None


@dataclass
class GenerateOptions:
    max_repair_rounds: int = DEFAULT_MAX_REPAIR_ROUNDS
    default_limit: int = DEFAULT_LIMIT
    token_budget: int = DEFAULT_TOKEN_BUDGET
    max_tables: int = DEFAULT_MAX_TABLES
    source_scope: list[str] | None = None
    recall_tables: int | None = None
    recall_columns: int | None = None
    exemplar_k: int | None = None
    table_allowlist: TableAllowlistCheck | None = None
    # Postgres-side EXPLAIN cardinality guard (docs/research/EXPLAIN_CARDINALITY_GUARD.md).
    # AUGMENTS the syntactic cardinality guard: when a probe is available it is the
    # AUTHORITATIVE selectivity signal; when it is not (no DSN/runner, transpile or
    # probe failure, timeout) the pipeline falls back to the syntactic verdict, which
    # fails closed on the large tables. Provide EITHER an injected `pg_explain_runner`
    # (hermetic tests / custom transport) OR `source_dsn` (a psycopg runner is built
    # for you). Leaving both None disables the EXPLAIN stage entirely (syntactic guard
    # remains the gate), so existing callers/tests are unaffected.
    source_dsn: str | None = None
    pg_explain_runner: ExplainRunner | None = None


def extract_sql(raw: str) -> tuple[str, str]:
    """Recovers a single SQL statement from the model's raw completion.
    Handles the common shapes a driving model emits: a fenced ```sql block, a
    JSON `{"sql": "...", "description": "..."}` object (the legacy
    contract), or bare SQL text. Returns `(sql, description)`. Mirrors
    lib/rag/generate.ts `extractSql` exactly.
    """
    text = raw.strip()

    if text.startswith("{"):
        try:
            parsed = json.loads(text)
            if isinstance(parsed, dict) and isinstance(parsed.get("sql"), str):
                description = parsed.get("description")
                return parsed["sql"].strip(), description if isinstance(description, str) else ""
        except (json.JSONDecodeError, ValueError):
            pass  # fall through to fenced/bare extraction

    fence = re.search(r"```(?:sql)?\s*([\s\S]*?)```", text, re.IGNORECASE)
    if fence and fence.group(1):
        return fence.group(1).strip(), ""

    return text, ""


@dataclass
class _AttemptFailure:
    error: str
    failed_sql: str
    hint: str | None = None


def _large_table_stats(context: SchemaContext) -> list[LargeTableStat]:
    """Derives the EXPLAIN guard's large-table set from the retrieved context:
    every `is_large_time_series` survivor, keyed by its BARE table name (the
    form Postgres reports as `Relation Name` in the plan) with its
    `approx_row_count` as `reltuples` for the relative reject threshold. Reuses
    the SAME table set the syntactic guard already recognizes, so the two guards
    share configuration rather than duplicating it (research §7).
    """
    stats: list[LargeTableStat] = []
    for table in context.tables:
        if not table.is_large_time_series:
            continue
        bare_name = table.quoted_ref.split(".")[-1].strip('"') or table.table_id.split(".")[-1]
        stats.append(LargeTableStat(bare_name=bare_name, reltuples=float(table.approx_row_count)))
    return stats


def _validate_candidate(
    candidate_sql: str,
    context: SchemaContext,
    engine: QueryEngine,
    *,
    default_limit: int,
    table_allowlist: TableAllowlistCheck | None,
    dialect: SqlDialect,
    source_dsn: str | None = None,
    pg_explain_runner: ExplainRunner | None = None,
) -> tuple[bool, str | None, _AttemptFailure | None]:
    """Runs the guard_sql -> cardinality_guard -> EXPLAIN-estimate -> explain
    chain on one candidate SQL. Returns `(ok, accepted_sql, failure)`. Mirrors
    lib/rag/generate.ts `validateCandidate` plus the Postgres-side EXPLAIN
    cardinality guard (docs/research/EXPLAIN_CARDINALITY_GUARD.md). CRITICAL:
    uses `engine.explain` (NOT execute) — zero rows egress; the EXPLAIN-estimate
    probe likewise NEVER runs ANALYZE.
    """
    guard_verdict = guard_sql(candidate_sql, dialect=dialect, table_allowlist=table_allowlist)
    if not guard_verdict.allowed:
        return (
            False,
            None,
            _AttemptFailure(
                error=guard_verdict.reason or "SQL rejected by the read-only guard.",
                hint="Produce a single read-only SELECT (or WITH ... SELECT). No writes, DDL, or multiple statements.",
                failed_sql=candidate_sql,
            ),
        )

    tables_as_dicts = [
        {
            "table_id": t.table_id,
            "quoted_ref": t.quoted_ref,
            "is_large_time_series": t.is_large_time_series,
            "required_time_column": t.required_time_column,
            # Fix C / cardinality-guard remediation: `columns` and `time_via`
            # must be threaded through here so `build_cardinality_guard_options`
            # can derive `selective_columns` (the FK-equality escape hatch)
            # and `parent_time_bound` (the parent-join time-bound escape
            # hatch) — without these, BOTH escape hatches are silently dead
            # in production even though the guard's own unit tests exercise
            # them directly with hand-built dicts.
            "columns": [
                {
                    "name": c.name,
                    "is_indexed": c.is_indexed,
                    "is_foreign_key_or_primary_key": c.is_foreign_key_or_primary_key,
                }
                for c in t.columns
            ],
            "time_via": (
                {
                    "table_id": t.time_via.table_id,
                    "column": t.time_via.column,
                    "from_columns": t.time_via.from_columns,
                    "to_columns": t.time_via.to_columns,
                }
                if t.time_via
                else None
            ),
        }
        for t in context.tables
    ]
    card_verdict = cardinality_guard_from_context(candidate_sql, tables_as_dicts, default_limit, dialect=dialect)
    sql_for_explain = candidate_sql
    if card_verdict.action == "reject":
        return (
            False,
            None,
            _AttemptFailure(
                error=card_verdict.reason or "Query would scan a large table unbounded.",
                hint=card_verdict.repair_hint,
                failed_sql=candidate_sql,
            ),
        )
    if card_verdict.action == "repair" and card_verdict.repaired_sql:
        sql_for_explain = card_verdict.repaired_sql

    # ── Postgres-side EXPLAIN-estimate guard (AUTHORITATIVE when available) ──
    # AUGMENTS the syntactic guard above (which already passed/repaired this
    # candidate). Run only when a probe is configured AND the query touches a
    # large table — otherwise there is nothing for it to gate. The probe reads
    # the large-table SCAN node's `Plan Rows` from Postgres `pg_statistic`
    # (filter-aware, unlike DuckDB's page-count estimate) and can OVERTURN a
    # syntactic pass whose "selective" predicate turns out non-selective, or
    # catch a join fan-out the syntactic guard is blind to. If the probe is
    # UNAVAILABLE (no DSN/runner, transpile/probe failure, timeout) it returns
    # `action='defer'` and we KEEP the syntactic verdict — i.e. fail closed on
    # large tables via the syntactic guard that already ran. NEVER runs ANALYZE.
    large_stats = _large_table_stats(context)
    if (source_dsn or pg_explain_runner) and large_stats:
        estimate = pg_explain_estimate(
            sql_for_explain,
            large_stats,
            dsn=source_dsn,
            runner=pg_explain_runner,
            source_dialect=dialect,
        )
        explain_estimate_verdict = evaluate_plan_estimate(estimate, large_stats)
        if explain_estimate_verdict.action in ("reject", "repair"):
            # A huge estimate is confidently huge (research §2, Leis 2016) — a
            # reject is safe; a 'repair' here is not silently fixable (the guard
            # cannot fabricate a tighter window), so both feed the self-repair
            # loop as a failure with the estimate-derived hint.
            return (
                False,
                None,
                _AttemptFailure(
                    error=explain_estimate_verdict.reason or "Query is estimated to scan a large table unbounded.",
                    hint=explain_estimate_verdict.repair_hint,
                    failed_sql=sql_for_explain,
                ),
            )
        # action in ('pass', 'defer'): 'pass' means the estimate is bounded
        # (authoritative OK); 'defer' means unavailable -> we already have the
        # syntactic guard's pass/repair verdict, which fails closed on large
        # tables, so proceed with it.

    explain_verdict = engine.explain(sql_for_explain)
    if isinstance(explain_verdict, PlanError) or not explain_verdict.ok:
        error_message = explain_verdict.error if isinstance(explain_verdict, PlanError) else "SQL failed to explain."
        return (
            False,
            None,
            _AttemptFailure(
                error=error_message,
                hint="The SQL failed to parse/bind against the schema. Fix the table/column names or syntax for the stated dialect.",
                failed_sql=sql_for_explain,
            ),
        )

    return True, sql_for_explain, None


def _retrieval_summary(context: SchemaContext) -> RetrievalSummary:
    return RetrievalSummary(
        tables=[t.table_id for t in context.tables],
        exemplars_used=[e.id for e in context.exemplars],
        cardinality_warnings=[w.message for w in context.cardinality_warnings],
    )


async def _direct_offload(func: Callable[..., _T], *args, **kwargs) -> _T:
    """Default offloader: call the blocking function inline. Used by prep and
    the hermetic tests (no event loop to protect). The FastAPI service injects
    a threadpool-backed offloader instead.
    """
    return func(*args, **kwargs)


async def generate_sql(
    *,
    question: str,
    engine: QueryEngine,
    retriever: HybridRetriever,
    llm: LlmClient,
    dialect: SqlDialect | None = None,
    options: GenerateOptions | None = None,
    cached: bool = False,
    offload: Offload = _direct_offload,
) -> SqlGenerateResponse:
    """The SPEC §5.1 pipeline as an injectable, testable function. Retrieves
    schema context, prompts the (injected) LLM, guards + cardinality-checks +
    explains the candidate, and self-repairs (<= max_repair_rounds) on any
    repairable failure. Mirrors lib/rag/generate.ts `generateSql` line-for-line.

    Throws only on retrieval/LLM/egress infrastructure errors; a SQL that
    cannot be made safe within the repair budget raises `GenerationError`.
    """
    options = options or GenerateOptions()
    resolved_dialect: SqlDialect = dialect or engine.dialect()
    capabilities: EngineCapabilities = engine.capabilities()
    default_limit = options.default_limit
    max_repair_rounds = min(options.max_repair_rounds, 2)

    # ── cost/token metering accumulators (Phase 3 KEY deliverable) ──────────
    # Summed across EVERY LLM call in this request (initial + each repair
    # round). `metering_model` is the model the LLM client reports (the real
    # OpenAI client echoes the resolved snapshot; the stub reports its
    # configured id) — used to price the summed tokens.
    start_ns = time.monotonic_ns()
    total_usage = TokenUsage()
    llm_calls = 0
    metering_model = DEFAULT_LLM_MODEL

    def _build_usage() -> UsageSummary:
        latency_ms = int((time.monotonic_ns() - start_ns) / 1_000_000)
        estimate = estimate_cost_usd(metering_model, total_usage.prompt_tokens, total_usage.completion_tokens)
        return UsageSummary(
            model=metering_model,
            prompt_tokens=total_usage.prompt_tokens,
            completion_tokens=total_usage.completion_tokens,
            total_tokens=total_usage.total_tokens,
            llm_calls=llm_calls,
            estimated_cost_usd=estimate.estimated_cost_usd,
            latency_ms=latency_ms,
            priced=estimate.priced,
        )

    retrieve_options = RetrieveOptions(
        token_budget=options.token_budget,
        max_tables=options.max_tables,
        source_scope=options.source_scope,
        recall_tables=options.recall_tables,
        recall_columns=options.recall_columns,
        exemplar_k=options.exemplar_k,
    )
    # BLOCKING (embed + BM25): offload so it does not stall the event loop.
    context = await offload(retriever.retrieve, question, retrieve_options)

    # [B]+[C] assemble prompt + first LLM call. Egress class is
    # schema-metadata: the prompt is BAA-safe by construction (no
    # patient-row values) — never gated by OPENAI_BAA_SIGNED.
    initial_prompt = assemble_prompt(
        context.tables, context.cardinality_warnings, question, capabilities, resolved_dialect, default_limit=default_limit
    )
    result = await call_llm(llm, initial_prompt, "schema-metadata")
    llm_calls += 1
    total_usage = total_usage + result.usage
    metering_model = result.model
    completion = result.text

    candidate_sql, description = extract_sql(completion)

    if _SCOPE_SENTINEL.match(completion.strip()) or _SCOPE_SENTINEL.match(candidate_sql):
        return SqlGenerateResponse(
            sql="",
            description="",
            dialect=resolved_dialect,
            retrieval=_retrieval_summary(context),
            cached=cached,
            error="scope",
            usage=_build_usage(),
        )

    rounds = 0
    last_error: str | None = None

    # BLOCKING (engine.explain — DuckDB): offload the whole validate step.
    ok, accepted_sql, failure = await offload(
        _validate_candidate,
        candidate_sql,
        context,
        engine,
        default_limit=default_limit,
        table_allowlist=options.table_allowlist,
        dialect=resolved_dialect,
        source_dsn=options.source_dsn,
        pg_explain_runner=options.pg_explain_runner,
    )

    while not ok and rounds < max_repair_rounds:
        rounds += 1
        assert failure is not None
        last_error = failure.error

        repair_prompt = assemble_repair_prompt(
            context.tables,
            context.cardinality_warnings,
            question,
            capabilities,
            resolved_dialect,
            failed_sql=failure.failed_sql,
            error=failure.error,
            hint=failure.hint,
            default_limit=default_limit,
        )
        repair_result = await call_llm(llm, repair_prompt, "schema-metadata")
        llm_calls += 1
        total_usage = total_usage + repair_result.usage
        metering_model = repair_result.model
        completion = repair_result.text
        extracted_sql, extracted_description = extract_sql(completion)
        candidate_sql = extracted_sql
        if extracted_description:
            description = extracted_description

        ok, accepted_sql, failure = await offload(
            _validate_candidate,
            candidate_sql,
            context,
            engine,
            default_limit=default_limit,
            table_allowlist=options.table_allowlist,
            dialect=resolved_dialect,
        )

    if not ok:
        assert failure is not None
        last_error = failure.error
        raise GenerationError(
            f"Could not produce safe, executable SQL within {max_repair_rounds} repair round(s).",
            rounds=rounds,
            last_error=last_error,
            usage=_build_usage(),
        )

    assert accepted_sql is not None
    return SqlGenerateResponse(
        sql=accepted_sql,
        description=description,
        dialect=resolved_dialect,
        retrieval=_retrieval_summary(context),
        repair=RepairInfo(rounds=rounds, last_error=last_error) if rounds > 0 else None,
        cached=cached,
        usage=_build_usage(),
    )
