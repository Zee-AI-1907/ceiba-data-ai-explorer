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
from ceiba_nl2sql.generation.llm import (
    DEFAULT_LLM_MODEL,
    DEFAULT_MAX_TOOL_ROUNDS,
    LlmClient,
    TokenUsage,
    call_llm,
    call_llm_with_tools,
)
from ceiba_nl2sql.generation.pricing import estimate_cost_usd
from ceiba_nl2sql.generation.prompt import assemble_plan_prompt, assemble_prompt, assemble_repair_prompt
from ceiba_nl2sql.generation.tools import make_get_join_subgraph_tool
from ceiba_nl2sql.guard.cardinality import cardinality_guard_from_context
from ceiba_nl2sql.guard.limit import enforce_default_limit as _enforce_default_limit_guard
from ceiba_nl2sql.guard.explain_estimate import (
    ExplainRunner,
    LargeTableStat,
    evaluate_plan_estimate,
    pg_explain_estimate,
)
from ceiba_nl2sql.retrieval.retriever import (
    HybridRetriever,
    RetrieveOptions,
    SchemaContext,
    build_bridge_stub_tables,
)
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
    # Prompt-prefix cache hits (subset of prompt_tokens, billed at the
    # provider's discounted cached-input rate). Additive — 0 when the
    # provider reports no cache detail.
    cached_prompt_tokens: int = 0


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
    # Task 2 (opt-in, A/B benchmark flag): adds three imperative preamble
    # lines forbidding invented join predicates / unrequested filters. The
    # lines are constant strings (no per-question interpolation), so turning
    # this on does not affect R2 prompt-caching. Default off => unchanged
    # behavior for existing callers.
    strict_join_steering: bool = False
    # P2: universal default-LIMIT guard. When on (default), a candidate whose
    # OUTERMOST query has no LIMIT gets one appended (or is rejected if it is an
    # unordered GROUP BY, to avoid silently dropping groups) — closing the gap
    # where the cardinality guard only bounds large-time-series tables. Off =>
    # unchanged behavior for callers that manage limits themselves.
    enforce_default_limit: bool = True
    # P1 (opt-in, A/B): gated tool-calling planning phase. When on, the model
    # calls get_join_subgraph with the tables it declares and the returned FK
    # subgraph (edges + bridge paths) drives BOTH the initial and repair prompts
    # instead of the retriever-fed JOIN GRAPH. Skipped for single-table routes
    # and clients without complete_messages, so the flag-off / non-tool path is
    # byte-identical. max_tool_rounds bounds the plan loop.
    get_join_subgraph_tool: bool = False
    max_tool_rounds: int = DEFAULT_MAX_TOOL_ROUNDS
    # P2 Task 4 (opt-in, clinical): when set (e.g. "24 hours"), an unbounded
    # large-table query is REJECTED with a hint naming this window so the model
    # writes it explicitly — the guard never injects it silently. Off => today's
    # behavior (reject with a generic hint; the model must supply the bound).
    default_time_window: str | None = None


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
    enforce_default_limit: bool = True,
    default_time_window: str | None = None,
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
    card_verdict = cardinality_guard_from_context(
        candidate_sql, tables_as_dicts, default_limit, dialect=dialect, default_time_window=default_time_window
    )
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

    # ── Universal default-LIMIT guard (P2): bound any outer query the
    # cardinality guard did not (non-large tables), or reject an unordered
    # GROUP BY so the model repairs it into a deterministic top-N. Runs on the
    # possibly-cardinality-repaired SQL so the two guards compose (an already
    # numeric-LIMITed query no-ops here). Off => unchanged behavior.
    if enforce_default_limit:
        limit_verdict = _enforce_default_limit_guard(
            sql_for_explain, default_limit=default_limit, dialect=dialect
        )
        if limit_verdict.action == "reject":
            return (
                False,
                None,
                _AttemptFailure(
                    error=limit_verdict.reason or "Query would return an unbounded/ambiguous result set.",
                    hint=limit_verdict.repair_hint,
                    failed_sql=sql_for_explain,
                ),
            )
        if limit_verdict.action == "repair" and limit_verdict.repaired_sql:
            sql_for_explain = limit_verdict.repaired_sql

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


def route_is_simple(context: SchemaContext) -> bool:
    """R1 model routing: evidence that this generation cannot involve a join —
    exactly ONE table survived retrieval, so there is no join for a small
    model to get wrong. Deliberately the STRONGEST simplicity signal only:
    the staging benchmarks showed the cheap tier silently mis-joining
    (Id=Id) on multi-hop questions, so anything that could join routes to
    the strong model. Conservative by design; widen only with benchmark
    evidence.
    """
    return len(context.tables) == 1


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
    simple_llm: LlmClient | None = None,
    escalation_llm: LlmClient | None = None,
) -> SqlGenerateResponse:
    """The SPEC §5.1 pipeline as an injectable, testable function. Retrieves
    schema context, prompts the (injected) LLM, guards + cardinality-checks +
    explains the candidate, and self-repairs (<= max_repair_rounds) on any
    repairable failure. Mirrors lib/rag/generate.ts `generateSql` line-for-line.

    R1 model routing (both optional; behavior is unchanged when absent):
      - `simple_llm`: used for the INITIAL call when retrieval proves the
        question join-free (`route_is_simple`) — the cheap tier is safe
        exactly when there is no join to get wrong.
      - `escalation_llm`: used for every REPAIR round instead of retrying the
        model that just failed (falls back to `llm` — so when the cheap tier's
        draft fails, the repair escalates to the strong model rather than
        burning a round on the same model). A same-model retry frequently
        re-fails; escalation converts two likely-failing calls into one
        likely-passing call — cheaper AND faster in expectation, never less
        accurate.

    Throws only on retrieval/LLM/egress infrastructure errors; a SQL that
    cannot be made safe within the repair budget raises `GenerationError`.
    """
    options = options or GenerateOptions()
    resolved_dialect: SqlDialect = dialect or engine.dialect()
    capabilities: EngineCapabilities = engine.capabilities()
    default_limit = options.default_limit
    max_repair_rounds = min(options.max_repair_rounds, 2)

    # ── cost/token metering accumulators (Phase 3 KEY deliverable) ──────────
    # One (model, usage) record per LLM call (initial + each repair round).
    # Priced PER CALL: with model routing a request can mix tiers, and pricing
    # the summed tokens at one model's rate would misprice the others.
    start_ns = time.monotonic_ns()
    metered_calls: list[tuple[str, TokenUsage]] = []

    def _build_usage() -> UsageSummary:
        latency_ms = int((time.monotonic_ns() - start_ns) / 1_000_000)
        total_usage = TokenUsage()
        total_cost = 0.0
        all_priced = True
        for call_model, call_usage in metered_calls:
            total_usage = total_usage + call_usage
            estimate = estimate_cost_usd(
                call_model,
                call_usage.prompt_tokens,
                call_usage.completion_tokens,
                cached_prompt_tokens=call_usage.cached_prompt_tokens,
            )
            total_cost += estimate.estimated_cost_usd
            all_priced = all_priced and estimate.priced
        # `model` reports the LAST call's resolved model (the one that produced
        # the returned SQL); per-call pricing above already accounted for any
        # earlier calls on a different tier.
        metering_model = metered_calls[-1][0] if metered_calls else DEFAULT_LLM_MODEL
        return UsageSummary(
            model=metering_model,
            prompt_tokens=total_usage.prompt_tokens,
            completion_tokens=total_usage.completion_tokens,
            total_tokens=total_usage.total_tokens,
            llm_calls=len(metered_calls),
            estimated_cost_usd=round(total_cost, 6),
            latency_ms=latency_ms,
            priced=all_priced if metered_calls else True,
            cached_prompt_tokens=total_usage.cached_prompt_tokens,
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

    # R1 routing: the cheap tier drives ONLY when retrieval proves the question
    # join-free; anything that could join uses the strong model. Computed here so
    # the P1 plan phase runs on the SAME client that will generate.
    initial_llm = simple_llm if (simple_llm is not None and route_is_simple(context)) else llm

    # ── P1 plan phase (gated) — let the model declare the tables it needs via
    # the get_join_subgraph tool; the returned FK subgraph (edges + bridge paths
    # + bridge stubs) then drives BOTH the initial and repair prompts instead of
    # the retriever-fed JOIN GRAPH. Skipped for single-table routes (no join to
    # reconnect) and clients without complete_messages (-> byte-identical
    # flag-off path). Egress stays schema-metadata: table/FK names only.
    plan_tables = context.tables
    plan_join_hints = context.join_hints
    plan_join_paths = context.join_paths
    if (
        options.get_join_subgraph_tool
        and not route_is_simple(context)
        and hasattr(initial_llm, "complete_messages")
    ):
        captured: dict = {}
        adjacency, known_table_ids, get_table_ref = retriever.join_subgraph_inputs()
        subgraph_tool = make_get_join_subgraph_tool(
            adjacency=adjacency,
            known_table_ids=known_table_ids,
            get_table_ref=get_table_ref,
            on_subgraph=lambda declared: captured.__setitem__("subgraph", declared),
        )
        plan_prompt = assemble_plan_prompt(context.tables, question, capabilities, resolved_dialect)
        plan_result = await call_llm_with_tools(
            initial_llm,
            [{"role": "user", "content": plan_prompt}],
            tools=[subgraph_tool.schema],
            handlers={subgraph_tool.name: subgraph_tool.handler},
            egress_class="schema-metadata",
            max_rounds=options.max_tool_rounds,
        )
        metered_calls.append((plan_result.model, plan_result.usage))
        subgraph = captured.get("subgraph")
        if subgraph is not None and (subgraph.join_hints or subgraph.join_paths):
            stubs = build_bridge_stub_tables(
                subgraph.bridge_nodes, adjacency=adjacency, get_table_ref=get_table_ref
            )
            existing_ids = {t.table_id for t in context.tables}
            plan_tables = list(context.tables) + [s for s in stubs if s.table_id not in existing_ids]
            plan_join_hints = subgraph.join_hints
            plan_join_paths = subgraph.join_paths

    # [B]+[C] assemble prompt + first LLM call. Egress class is
    # schema-metadata: the prompt is BAA-safe by construction (no
    # patient-row values) — never gated by OPENAI_BAA_SIGNED.
    initial_prompt = assemble_prompt(
        plan_tables,
        context.cardinality_warnings,
        question,
        capabilities,
        resolved_dialect,
        default_limit=default_limit,
        # CRITICAL: forward the join graph + semantic hints. Without these,
        # assemble_prompt silently omits the JOIN GRAPH and SEMANTIC HINTS
        # sections (they default to empty), so the model never sees the FK edges
        # (-> guesses wrong join columns like mm.Id=m.Id) or the coded value
        # mapping. plan_join_hints/plan_join_paths are the tool-declared subgraph
        # when the P1 plan phase ran, else the retriever-fed graph.
        join_hints=plan_join_hints,
        join_paths=plan_join_paths,
        glossary_hits=context.glossary_hits,
        token_budget=context.token_estimate or None,
        # R2: static context orders question-varying sections last so the
        # schema/join-graph prefix is byte-identical across questions.
        semantic_hints_last=getattr(context, "static_context", False),
        strict_join_steering=options.strict_join_steering,
        # Task 9: render the recalled few-shot exemplars (Q + SQL + scrubbed
        # sample) into the prompt tail. Previously context.exemplars was
        # recalled but never rendered — only its ids were logged as
        # `exemplars_used`, so the mechanism had zero effect on generation.
        exemplars=context.exemplars,
    )
    result = await call_llm(initial_llm, initial_prompt, "schema-metadata")
    metered_calls.append((result.model, result.usage))
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
        enforce_default_limit=options.enforce_default_limit,
        default_time_window=options.default_time_window,
    )

    while not ok and rounds < max_repair_rounds:
        rounds += 1
        assert failure is not None
        last_error = failure.error

        repair_prompt = assemble_repair_prompt(
            plan_tables,
            context.cardinality_warnings,
            question,
            capabilities,
            resolved_dialect,
            failed_sql=failure.failed_sql,
            error=failure.error,
            hint=failure.hint,
            default_limit=default_limit,
            # same as the initial prompt: the repair round MUST also carry the
            # join graph + semantic hints, or the model repairs blind. When the
            # P1 plan phase ran, this is the tool-declared subgraph (NOT the
            # survivor-fed graph) so repair does not silently revert.
            join_hints=plan_join_hints,
            join_paths=plan_join_paths,
            glossary_hits=context.glossary_hits,
            token_budget=context.token_estimate or None,
            semantic_hints_last=getattr(context, "static_context", False),
            strict_join_steering=options.strict_join_steering,
            # Task 9: mirror the initial round so a repair round still sees
            # the same few-shot exemplars.
            exemplars=context.exemplars,
        )
        # R1 escalation: never retry the model that just failed — repair
        # rounds run on the escalation model (or the strong default).
        repair_result = await call_llm(escalation_llm or llm, repair_prompt, "schema-metadata")
        metered_calls.append((repair_result.model, repair_result.usage))
        completion = repair_result.text
        extracted_sql, extracted_description = extract_sql(completion)
        candidate_sql = extracted_sql
        if extracted_description:
            description = extracted_description

        # CRITICAL: the repair-round validate must carry the SAME EXPLAIN-probe
        # configuration as the initial validate. Omitting source_dsn /
        # pg_explain_runner here silently downgraded every REPAIRED candidate to
        # the syntactic guard alone — a repair that satisfied a syntactic escape
        # hatch but was still estimated to scan a huge table slipped through.
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
            enforce_default_limit=options.enforce_default_limit,
            default_time_window=options.default_time_window,
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
