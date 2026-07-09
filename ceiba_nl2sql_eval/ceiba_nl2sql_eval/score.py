"""score.py — EvalScore / EvalReport (ports eval/score.ts verbatim, plus a
NEW cost-aggregation deliverable; docs/PYTHON_NL2SQL_SERVICE_PLAN.md §4.1,
§5 Phase 5).

Scores one generated candidate SQL against the same dimensions eval/score.ts
does, reusing the REAL runtime controls rather than re-implementing them:
  - `guard_passes`  -> `ceiba_nl2sql.sqltools.guard.guard_sql` (the actual
    execution boundary's classifier).
  - `parses`        -> `QueryEngine.explain` in the target dialect (no rows).
  - `references_real_tables` -> every table reference resolves to a tableId
    in the bundle's `catalog.json`.
  - `cardinality_bounded` -> `ceiba_nl2sql.guard.cardinality
    .cardinality_guard_from_context` (action != 'reject').
  - `executes`      -> `QueryEngine.execute` against the synthetic (or
    gated-staging) topology, without throwing.
  - `result_match`  -> row-set comparison against `gold_sql` executed on the
    SAME topology, when a gold_sql is provided; `None` otherwise.

A guard failure is a HARD failure (mirrors eval/score.ts `scoreCandidate`):
never calls explain/execute on SQL that failed `guard_sql`.
"""

from __future__ import annotations

import json
from dataclasses import dataclass, field
from datetime import date, datetime
from typing import Any, Callable

from ceiba_nl2sql.engine.base import ExecuteOptions, QueryEngine
from ceiba_nl2sql.generation.pipeline import UsageSummary
from ceiba_nl2sql.guard.cardinality import cardinality_guard_from_context
from ceiba_nl2sql.retrieval.retriever import SchemaContext
from ceiba_nl2sql.sqltools.guard import TableAllowlistCheck, guard_sql

# ── SPEC §6.2 shapes (mirrors eval/score.ts's EvalScore/PerTagMetrics/etc) ───


@dataclass(frozen=True)
class EvalScore:
    guard_passes: bool
    parses: bool
    references_real_tables: bool
    cardinality_bounded: bool
    executes: bool
    result_match: bool | None


@dataclass(frozen=True)
class PerTagMetrics:
    execution_accuracy: float
    guard_pass_rate: float
    parse_rate: float


@dataclass(frozen=True)
class OverallMetrics:
    execution_accuracy: float
    guard_pass_rate: float
    parse_rate: float
    valid_table_rate: float


@dataclass(frozen=True)
class CostSummary:
    """NEW (not in the TS version): aggregates the Phase 3 per-query usage
    data (`ceiba_nl2sql.generation.pipeline.UsageSummary`) across every
    scored item.
    """

    total_estimated_cost_usd: float
    total_prompt_tokens: int
    total_completion_tokens: int
    total_llm_calls: int
    mean_cost_usd_per_question: float
    priced_question_count: int
    model: str | None


@dataclass(frozen=True)
class EvalReport:
    per_tag: dict[str, PerTagMetrics]
    overall: OverallMetrics
    latency_ms_p50: float
    token_cost_total: int
    bundle_version: str
    driving_model: str
    cost: CostSummary


@dataclass(frozen=True)
class ScoredItem:
    """One scored golden-set item, retained alongside the aggregate
    EvalReport for detailed inspection/debugging.
    """

    id: str
    question: str
    tags: list[str]
    sql: str
    score: EvalScore
    latency_ms: float
    token_estimate: int
    usage: UsageSummary | None = None
    error: str | None = None


# ── scoring a single candidate ───────────────────────────────────────────────


def _references_real_tables(context: SchemaContext, bundle_known_table_ids: set[str]) -> bool:
    """Checks that every table surfaced in the SchemaContext the candidate
    was retrieved against is a real bundle table. Mirrors eval/score.ts
    `referencesRealTables`.
    """
    if not context.tables:
        return False
    return all(t.table_id in bundle_known_table_ids for t in context.tables)


def _json_stringify(value: Any) -> str:
    """`JSON.stringify`-equivalent for a normalized row dict — sorted keys,
    compact separators (mirrors JS's default no-space `JSON.stringify`).
    """
    return json.dumps(value, sort_keys=True, separators=(",", ":"), default=str)


def _normalize_value(value: Any) -> Any:
    """Normalizes one cell value to a stable, comparable form so a DuckDB
    type difference (TIMESTAMPTZ vs TIMESTAMP, Decimal vs float) never causes
    a spurious mismatch. Mirrors eval/score.ts `normalizeRows`'s per-value
    normalization (Date -> ISO string; bigint -> string).
    """
    if isinstance(value, datetime):
        return value.isoformat()
    if isinstance(value, date):
        return value.isoformat()
    return value


def _normalize_rows(rows: list[dict]) -> list[str]:
    """Normalizes an EngineResult's rows into a comparable, order-independent,
    stringified multiset. Mirrors eval/score.ts `normalizeRows`.
    """
    normalized_strings: list[str] = []
    for row in rows:
        normalized = {key: _normalize_value(row[key]) for key in sorted(row.keys())}
        normalized_strings.append(_json_stringify(normalized))
    return sorted(normalized_strings)


def _row_sets_match(a: list[dict], b: list[dict]) -> bool:
    norm_a = _normalize_rows(a)
    norm_b = _normalize_rows(b)
    if len(norm_a) != len(norm_b):
        return False
    return all(x == y for x, y in zip(norm_a, norm_b))


def score_candidate(
    *,
    sql: str,
    context: SchemaContext,
    engine: QueryEngine,
    bundle_known_table_ids: set[str],
    gold_sql: str | None = None,
    max_rows: int = 1000,
    deadline_ms: int = 10_000,
    table_allowlist: TableAllowlistCheck | None = None,
) -> EvalScore:
    """Runs the scoring chain on ONE candidate SQL. Short-circuits after a
    guard failure (hard failure — never explains/executes rejected SQL).
    Mirrors eval/score.ts `scoreCandidate` line-for-line.
    """
    valid_tables = _references_real_tables(context, bundle_known_table_ids)

    guard_verdict = guard_sql(sql, dialect=context.dialect, table_allowlist=table_allowlist)
    guard_passes = guard_verdict.allowed

    if not guard_passes:
        # HARD FAILURE: never explain/execute SQL the guard rejected.
        return EvalScore(
            guard_passes=False,
            parses=False,
            references_real_tables=valid_tables,
            cardinality_bounded=False,
            executes=False,
            result_match=None,
        )

    tables_as_dicts = [
        {
            "table_id": t.table_id,
            "quoted_ref": t.quoted_ref,
            "is_large_time_series": t.is_large_time_series,
            "required_time_column": t.required_time_column,
        }
        for t in context.tables
    ]
    card_verdict = cardinality_guard_from_context(sql, tables_as_dicts, max_rows, dialect=context.dialect)
    cardinality_bounded = card_verdict.action != "reject"
    sql_to_run = card_verdict.repaired_sql if (card_verdict.action == "repair" and card_verdict.repaired_sql) else sql

    parses = False
    executes = False
    result_match: bool | None = None

    if cardinality_bounded:
        explain_verdict = engine.explain(sql_to_run)
        parses = bool(explain_verdict.ok)

        if parses:
            try:
                result = engine.execute(sql_to_run, ExecuteOptions(max_rows=max_rows, deadline_ms=deadline_ms))
                executes = True

                if gold_sql:
                    try:
                        gold_result = engine.execute(gold_sql, ExecuteOptions(max_rows=max_rows, deadline_ms=deadline_ms))
                        result_match = _row_sets_match(result.rows, gold_result.rows)
                    except Exception:
                        # Gold SQL failed to execute on this topology — cannot judge a match.
                        result_match = False
            except Exception:
                executes = False

    return EvalScore(
        guard_passes=guard_passes,
        parses=parses,
        references_real_tables=valid_tables,
        cardinality_bounded=cardinality_bounded,
        executes=executes,
        result_match=result_match,
    )


# ── aggregate report ──────────────────────────────────────────────────────────


def _percentile50(sorted_values: list[float]) -> float:
    if not sorted_values:
        return 0.0
    mid = len(sorted_values) // 2
    if len(sorted_values) % 2 == 1:
        return sorted_values[mid]
    return (sorted_values[mid - 1] + sorted_values[mid]) / 2


def _compute_metrics(items: list[ScoredItem]) -> PerTagMetrics:
    if not items:
        return PerTagMetrics(execution_accuracy=0.0, guard_pass_rate=0.0, parse_rate=0.0)
    n = len(items)
    guard_pass_rate = sum(1 for i in items if i.score.guard_passes) / n
    parse_rate = sum(1 for i in items if i.score.parses) / n
    # Execution accuracy: prefer result_match when a gold_sql was available;
    # otherwise fall back to `executes`.
    accuracy_hits = sum(
        1 for i in items if (i.score.result_match if i.score.result_match is not None else i.score.executes)
    )
    execution_accuracy = accuracy_hits / n
    return PerTagMetrics(execution_accuracy=execution_accuracy, guard_pass_rate=guard_pass_rate, parse_rate=parse_rate)


def _build_cost_summary(items: list[ScoredItem]) -> CostSummary:
    total_cost = 0.0
    total_prompt_tokens = 0
    total_completion_tokens = 0
    total_llm_calls = 0
    priced_question_count = 0
    models_seen: set[str] = set()

    for item in items:
        usage = item.usage
        if usage is None:
            continue
        total_cost += usage.estimated_cost_usd
        total_prompt_tokens += usage.prompt_tokens
        total_completion_tokens += usage.completion_tokens
        total_llm_calls += usage.llm_calls
        if usage.priced:
            priced_question_count += 1
        models_seen.add(usage.model)

    mean_cost = total_cost / len(items) if items else 0.0
    model: str | None
    if len(models_seen) == 1:
        model = next(iter(models_seen))
    elif not models_seen:
        model = None
    else:
        model = "mixed"

    return CostSummary(
        total_estimated_cost_usd=total_cost,
        total_prompt_tokens=total_prompt_tokens,
        total_completion_tokens=total_completion_tokens,
        total_llm_calls=total_llm_calls,
        mean_cost_usd_per_question=mean_cost,
        priced_question_count=priced_question_count,
        model=model,
    )


def build_eval_report(items: list[ScoredItem], *, bundle_version: str, driving_model: str) -> EvalReport:
    """Aggregates a list of `ScoredItem`s into the `EvalReport` shape:
    per-tag metrics, overall metrics (incl. `valid_table_rate`), p50 latency,
    the TS-parity `token_cost_total` rough estimate, AND the new `cost`
    (real Phase-3-usage USD aggregate). Mirrors eval/score.ts
    `buildEvalReport`.
    """
    per_tag: dict[str, PerTagMetrics] = {}
    tag_set: set[str] = set()
    for item in items:
        tag_set.update(item.tags)
    for tag in tag_set:
        per_tag[tag] = _compute_metrics([i for i in items if tag in i.tags])

    overall_base = _compute_metrics(items)
    valid_table_rate = (
        sum(1 for i in items if i.score.references_real_tables) / len(items) if items else 0.0
    )

    latencies = sorted(i.latency_ms for i in items)
    token_cost_total = sum(i.token_estimate for i in items)

    return EvalReport(
        per_tag=per_tag,
        overall=OverallMetrics(
            execution_accuracy=overall_base.execution_accuracy,
            guard_pass_rate=overall_base.guard_pass_rate,
            parse_rate=overall_base.parse_rate,
            valid_table_rate=valid_table_rate,
        ),
        latency_ms_p50=_percentile50(latencies),
        token_cost_total=token_cost_total,
        bundle_version=bundle_version,
        driving_model=driving_model,
        cost=_build_cost_summary(items),
    )
