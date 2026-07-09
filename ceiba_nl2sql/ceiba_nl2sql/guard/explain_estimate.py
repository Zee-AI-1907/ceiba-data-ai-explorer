"""explain_estimate.py — Postgres-side EXPLAIN cardinality guard (AUGMENTS the
syntactic guard in `guard/cardinality.py`; design in
docs/research/EXPLAIN_CARDINALITY_GUARD.md).

── Why a NEW, Postgres-facing probe (not DuckDbEngine.explain) ────────────────
The generated SQL is planned on DuckDB, but the big tables
(`Shared.MonitorMeasurements` ~337M, `Shared.VentilatorMeasurements` ~271M,
`Shared.Monitors` ~60M) live in the attached Postgres and are scanned THROUGH
DuckDB's `postgres` scanner. DuckDB's `PostgresScanCardinality` is
`pages_approx × rows_per_page` — a FILTER-BLIND page-count estimate: it reports
~337M regardless of the `WHERE`. So a DuckDB-side EXPLAIN is useless as a
selectivity signal for exactly the tables this guard protects (research §1b).

The authoritative signal is `EXPLAIN (FORMAT JSON)` run DIRECTLY against the
Postgres source over the read-only DSN. Postgres:
  - NEVER executes the query when `ANALYZE` is omitted — it only plans (research
    §6; we additionally assert no `Actual Rows` key appears in the plan, which
    proves the executor never ran). Safe on 337M-row tables.
  - Produces per-node `Plan Rows` derived from `pg_statistic`, so it DOES
    reflect the pushed-down filter's selectivity (research §1c: 483 -> 13
    equality -> 42 time-bound, live-confirmed).
  - Its inner SCAN estimate correctly IGNORES an outer `LIMIT` (a `LIMIT` bounds
    OUTPUT rows, not SCANNED rows — research §3), so we read the large-table
    SCAN node's `Plan Rows`, NOT the LIMIT-masked top-level estimate.

── DuckDB-dialect -> native-Postgres transpile for the probe ──────────────────
The generated (executed) SQL is DuckDB dialect with catalog-qualified refs like
`staging."Shared"."MonitorMeasurements"`. Postgres has no `staging` catalog, so
before the probe we (1) transpile duckdb -> postgres via sqlglot and (2) strip
the leading source-alias catalog segment (`staging."Shared"."X"` ->
`"Shared"."X"`). If transpile OR the probe fails/times out, the caller FALLS
BACK to the syntactic guard (fail-closed on the large tables) — the EXPLAIN
probe is the authoritative signal only WHEN AVAILABLE (research §4).

── Safety ─────────────────────────────────────────────────────────────────────
`EXPLAIN` without `ANALYZE` never executes. We assert the probe SQL contains no
`ANALYZE` token, run it in a `default_transaction_read_only` transaction under a
short `statement_timeout` (so a pathological PLAN can't hang), and verify the
returned plan has no `Actual Rows` key (a positive proof no ANALYZE slipped in).
The candidate SQL handed to this module is already read-only-guarded upstream.
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from typing import Any, Callable, Literal

import sqlglot
from sqlglot import expressions as exp
from sqlglot.errors import OptimizeError, ParseError, TokenError

from ceiba_nl2sql.sqltools.dialect import normalize_dialect

# ── Threshold policy (research §3) — module-level constants, tunable ──────────
# Per large-table SCAN node: repair above SCAN_WARN, reject above SCAN_REJECT_ABS
# OR above REJECT_FRACTION of the table's own reltuples (auto-scales across the
# 337M -> 22K span). Root Plan Rows above JOIN_BLOWUP_REJECT catches multiplicative
# join/cartesian fan-out the per-scan check is blind to.
SCAN_WARN_ROWS = 1_000_000
SCAN_REJECT_ABS_ROWS = 10_000_000
REJECT_FRACTION_OF_TABLE = 0.10
JOIN_BLOWUP_REJECT_ROWS = 50_000_000

# statement_timeout for the planning probe (research §5). A slow PLAN fails
# closed rather than stalling the pipeline.
DEFAULT_PROBE_TIMEOUT_MS = 2_000

_ANALYZE_TOKEN = re.compile(r"\bANALYZE\b", re.IGNORECASE)


@dataclass(frozen=True)
class LargeTableStat:
    """A large table the EXPLAIN guard inspects. `bare_name` is the table name
    as it appears in the Postgres plan's `Relation Name` (unquoted). `reltuples`
    is the table's approximate row count (from the catalog / bundle) used for
    the relative reject threshold; `None` disables the relative check for this
    table (only the absolute floor applies).
    """

    bare_name: str
    reltuples: float | None = None


@dataclass(frozen=True)
class PlanEstimate:
    """Structured result of a Postgres-side EXPLAIN probe.

    `available` is False when the probe could not run (transpile failure,
    connection error, timeout, or a plan we could not parse) — the caller then
    FALLS BACK to the syntactic guard (fail-closed). When `available` is True,
    `max_large_scan_rows` is the MAX `Plan Rows` over every plan node that scans
    a configured large table (the authoritative selectivity signal, ignoring any
    outer LIMIT), `root_rows` is the top-level node's `Plan Rows` (join fan-out),
    and `large_scan_by_table` maps each large table's bare name to the max scan
    estimate observed for it.
    """

    available: bool
    max_large_scan_rows: float | None = None
    root_rows: float | None = None
    large_scan_by_table: dict[str, float] = field(default_factory=dict)
    probe_sql: str | None = None
    unavailable_reason: str | None = None
    # Statistics-staleness hook (see `StalenessInfo` / TODO below): populated by
    # a FUTURE step; None today. When present, a policy layer can gate estimate
    # trust on it.
    staleness: "StalenessInfo | None" = None


@dataclass(frozen=True)
class StalenessInfo:
    """HOOK (not yet populated) for a future statistics-staleness check. When a
    later step queries `pg_stat_user_tables` for each large table, it fills these
    so the policy can decide whether to TRUST an EXPLAIN estimate (fresh stats)
    or DEMOTE to the syntactic guard (stale stats can make Plan Rows meaningless).

    TODO(next-step): in `pg_explain_estimate`, after the EXPLAIN round-trip and
    within the SAME read-only transaction, run e.g.
        SELECT relname, last_analyze, last_autoanalyze, n_mod_since_analyze
        FROM pg_stat_user_tables WHERE relname = ANY(%s)
    for the configured large tables, build one `StalenessInfo` per table, and
    attach the worst (most stale) to `PlanEstimate.staleness`. The policy in
    `evaluate_plan_estimate` can then downgrade a "pass" to "defer to syntactic"
    when `n_mod_since_analyze` is a large fraction of `reltuples` or
    `last_analyze` is very old. Intentionally left unimplemented per the design
    (research §7 stats-freshness caveat) — this is the documented plug-in point.
    """

    table_name: str
    last_analyze: Any | None = None
    last_autoanalyze: Any | None = None
    n_mod_since_analyze: int | None = None


@dataclass(frozen=True)
class ExplainVerdict:
    """The EXPLAIN guard's policy decision. `action='defer'` means the probe was
    unavailable and the caller must fall back to the syntactic guard (fail-closed
    on large tables). `pass`/`repair`/`reject` mirror the syntactic guard's
    vocabulary so the pipeline handles them uniformly.
    """

    action: Literal["pass", "repair", "reject", "defer"]
    reason: str | None = None
    repair_hint: str | None = None
    estimate: PlanEstimate | None = None


# ── duckdb -> postgres transpile for the probe ─────────────────────────────────


def _strip_leading_catalog(node: exp.Table) -> None:
    """Drop the leading catalog segment of a 3-part `catalog.schema.table` ref
    (e.g. the DuckDB ATTACH alias `staging` in `staging."Shared"."X"`), leaving
    the native Postgres `"Shared"."X"`. A 2-part `schema.table` or bare `table`
    is left untouched. Mutates the node in place.
    """
    if node.args.get("catalog") and node.args.get("db"):
        node.set("catalog", None)


def transpile_duckdb_to_postgres_for_probe(sql: str, *, source_dialect: str | None = None) -> str:
    """Transpile a generated (DuckDB-dialect, catalog-qualified) candidate to a
    native-Postgres statement suitable for `EXPLAIN` against the source. Raises
    on parse/transpile failure so the caller can fall back to the syntactic
    guard. NEVER alters query semantics beyond dialect + catalog-alias stripping;
    the EXECUTED query still goes through DuckDB — this string is ONLY the
    estimate probe.
    """
    read_dialect = normalize_dialect(source_dialect)
    try:
        tree = sqlglot.parse_one(sql, read=read_dialect)
    except (ParseError, TokenError, OptimizeError) as exc:
        raise ValueError(f"probe transpile: parse failed: {exc}") from exc

    for table in tree.find_all(exp.Table):
        _strip_leading_catalog(table)

    return tree.sql(dialect="postgres")


# ── plan-tree walk ─────────────────────────────────────────────────────────────


def _iter_plan_nodes(plan: dict) -> list[dict]:
    """Flattens a Postgres EXPLAIN-JSON plan tree (each node's children live in
    the `Plans` list) into a pre-order list of node dicts.
    """
    out: list[dict] = []
    stack = [plan]
    while stack:
        node = stack.pop()
        out.append(node)
        children = node.get("Plans")
        if isinstance(children, list):
            # Reverse so pre-order is preserved when popping.
            stack.extend(reversed(children))
    return out


def _relation_name_of(node: dict) -> str | None:
    """The relation a scan node touches. Postgres populates `Relation Name` on
    Seq/Index/Bitmap/etc. scan nodes; return it lowercased for case-insensitive
    matching against the configured large-table names.
    """
    name = node.get("Relation Name")
    return name.lower() if isinstance(name, str) else None


def _assert_no_analyze_ran(plan_root: dict) -> None:
    """Positive safety proof: `EXPLAIN` without `ANALYZE` never populates
    `Actual Rows` / `Actual Total Time`. If ANY node carries them, an ANALYZE
    somehow ran — raise loudly rather than trust the numbers.
    """
    for node in _iter_plan_nodes(plan_root):
        if "Actual Rows" in node or "Actual Total Time" in node:
            raise AssertionError(
                "EXPLAIN plan contains 'Actual Rows'/'Actual Total Time' — ANALYZE ran "
                "and the query was executed. Refusing to trust this estimate."
            )


def parse_plan_estimate(
    explain_json: Any,
    large_tables: list[LargeTableStat],
    *,
    probe_sql: str | None = None,
) -> PlanEstimate:
    """Parse a Postgres `EXPLAIN (FORMAT JSON)` result into a `PlanEstimate`.

    `explain_json` is the JSON the driver returns — Postgres wraps the plan in a
    single-element list `[{"Plan": {...}}]`; a bare `{"Plan": {...}}` or a bare
    plan-node dict are also accepted for hermetic-test convenience. Reads the MAX
    `Plan Rows` over every SCAN node whose `Relation Name` matches a configured
    large table (NOT the LIMIT-masked top-level estimate — research §3), plus the
    root node's `Plan Rows` for join fan-out.
    """
    root_plan = _extract_root_plan(explain_json)
    if root_plan is None:
        return PlanEstimate(
            available=False,
            probe_sql=probe_sql,
            unavailable_reason="EXPLAIN JSON had no parseable Plan node.",
        )

    # Safety: prove no ANALYZE executed.
    _assert_no_analyze_ran(root_plan)

    large_by_bare = {t.bare_name.lower(): t for t in large_tables}
    large_scan_by_table: dict[str, float] = {}

    for node in _iter_plan_nodes(root_plan):
        relation = _relation_name_of(node)
        if relation is None or relation not in large_by_bare:
            continue
        plan_rows = node.get("Plan Rows")
        if not isinstance(plan_rows, (int, float)):
            continue
        prev = large_scan_by_table.get(relation)
        if prev is None or plan_rows > prev:
            large_scan_by_table[relation] = float(plan_rows)

    max_large_scan = max(large_scan_by_table.values(), default=None)
    root_rows_raw = root_plan.get("Plan Rows")
    root_rows = float(root_rows_raw) if isinstance(root_rows_raw, (int, float)) else None

    return PlanEstimate(
        available=True,
        max_large_scan_rows=max_large_scan,
        root_rows=root_rows,
        large_scan_by_table=large_scan_by_table,
        probe_sql=probe_sql,
    )


def _extract_root_plan(explain_json: Any) -> dict | None:
    """Unwrap the various shapes a driver / test fixture may hand us to the root
    plan-node dict: `[{"Plan": {...}}]`, `{"Plan": {...}}`, or a bare node dict.
    """
    candidate = explain_json
    if isinstance(candidate, list):
        if not candidate:
            return None
        candidate = candidate[0]
    if isinstance(candidate, str):
        import json

        try:
            candidate = json.loads(candidate)
        except (ValueError, TypeError):
            return None
        if isinstance(candidate, list):
            candidate = candidate[0] if candidate else None
    if not isinstance(candidate, dict):
        return None
    if isinstance(candidate.get("Plan"), dict):
        return candidate["Plan"]
    # Already a bare plan node?
    if "Node Type" in candidate or "Plan Rows" in candidate:
        return candidate
    return None


# ── policy ─────────────────────────────────────────────────────────────────────


def evaluate_plan_estimate(
    estimate: PlanEstimate,
    large_tables: list[LargeTableStat],
) -> ExplainVerdict:
    """Apply the research §3 threshold policy to a parsed estimate. When the
    estimate is unavailable, returns `action='defer'` so the caller falls back to
    the syntactic guard (fail-closed on large tables).
    """
    if not estimate.available:
        return ExplainVerdict(
            action="defer",
            reason=estimate.unavailable_reason or "EXPLAIN estimate unavailable.",
            estimate=estimate,
        )

    reltuples_by_bare = {t.bare_name.lower(): t.reltuples for t in large_tables}
    # Preserve original-cased names for human-facing messages (the plan's
    # Relation Name is matched case-insensitively, but the reason/hint should
    # echo the table as configured, e.g. "MonitorMeasurements").
    display_name_by_bare = {t.bare_name.lower(): t.bare_name for t in large_tables}

    # Root-estimate join/cartesian fan-out guard first — a bounded-per-scan query
    # whose join product explodes is still catastrophic.
    if estimate.root_rows is not None and estimate.root_rows > JOIN_BLOWUP_REJECT_ROWS:
        return ExplainVerdict(
            action="reject",
            reason=(
                f"Estimated join fan-out of {int(estimate.root_rows):,} result rows exceeds the "
                f"{JOIN_BLOWUP_REJECT_ROWS:,}-row cap (probable cartesian/multiplicative blow-up)."
            ),
            repair_hint="Add join predicates so tables are not cross-joined, and tighten filters to reduce the result size.",
            estimate=estimate,
        )

    # Per-large-table SCAN-node estimate — the authoritative selectivity signal.
    worst_table: str | None = None
    worst_rows = -1.0
    worst_reject_threshold = 0.0
    for bare_name, scan_rows in estimate.large_scan_by_table.items():
        reltuples = reltuples_by_bare.get(bare_name)
        reject_threshold = SCAN_REJECT_ABS_ROWS
        if reltuples is not None and reltuples > 0:
            reject_threshold = max(SCAN_REJECT_ABS_ROWS, REJECT_FRACTION_OF_TABLE * reltuples)
        if scan_rows > worst_rows:
            worst_rows = scan_rows
            worst_table = bare_name
            worst_reject_threshold = reject_threshold

    if worst_table is None:
        # No large-table scan in the plan at all — nothing for this guard to gate.
        return ExplainVerdict(action="pass", estimate=estimate)

    worst_display = display_name_by_bare.get(worst_table, worst_table)

    if worst_rows > worst_reject_threshold:
        return ExplainVerdict(
            action="reject",
            reason=(
                f"Estimated scan of large table {worst_display!r} is {int(worst_rows):,} rows, exceeding the "
                f"reject threshold of {int(worst_reject_threshold):,} (near-full/unbounded scan)."
            ),
            repair_hint=(
                f"Tighten the filter on {worst_display!r} (a narrower time window or a more selective equality/IN) "
                "so the optimizer estimates far fewer scanned rows."
            ),
            estimate=estimate,
        )

    if worst_rows > SCAN_WARN_ROWS:
        return ExplainVerdict(
            action="repair",
            reason=(
                f"Estimated scan of large table {worst_display!r} is {int(worst_rows):,} rows "
                f"(> warn threshold {SCAN_WARN_ROWS:,}); tighten the bound."
            ),
            repair_hint=(
                f"Your scan of {worst_display!r} is estimated at {int(worst_rows):,} rows. Add a tighter time "
                "bound or a more selective filter so far fewer rows are scanned."
            ),
            estimate=estimate,
        )

    return ExplainVerdict(action="pass", estimate=estimate)


# ── the probe (opens a read-only Postgres connection) ──────────────────────────

# Type of a callable that, given a native-Postgres SQL string + a timeout, runs
# `EXPLAIN (FORMAT JSON)` read-only and returns the parsed JSON. Injectable so
# unit tests can feed a captured plan with NO live DB.
ExplainRunner = Callable[[str, int], Any]


def _default_psycopg_runner(dsn: str) -> ExplainRunner:
    """Build an ExplainRunner backed by psycopg over `dsn`. Opens a fresh
    connection per probe, forces the session read-only, sets a `statement_timeout`
    so a pathological PLAN cannot hang, and runs `EXPLAIN (FORMAT JSON, VERBOSE,
    COSTS)` — NO ANALYZE. Imported lazily so the guard module has no hard psycopg
    dependency for callers that inject their own runner (or only parse fixtures).
    """

    def _run(probe_sql: str, timeout_ms: int) -> Any:
        import psycopg  # lazy import — optional dependency

        # Defense in depth: the candidate is already read-only-guarded upstream,
        # but assert no ANALYZE token can reach the server.
        if _ANALYZE_TOKEN.search(probe_sql):
            raise ValueError("probe SQL unexpectedly contains ANALYZE — refusing to run.")

        # `statement_timeout` is set via `set_config()` (a function that DOES take
        # a bind parameter) rather than `SET LOCAL statement_timeout = %s` —
        # Postgres' SET command syntax does not accept a bind placeholder
        # ("syntax error at or near $1"). Coerce to a validated non-negative int
        # so nothing but a number can reach the config string either way.
        safe_timeout_ms = max(0, int(timeout_ms))
        conn_kwargs: dict[str, Any] = {"autocommit": False}
        with psycopg.connect(dsn, **conn_kwargs) as conn:
            with conn.cursor() as cur:
                cur.execute("SET TRANSACTION READ ONLY")
                # set_config(name, value, is_local=true) — LOCAL to this tx.
                cur.execute("SELECT set_config('statement_timeout', %s, true)", (str(safe_timeout_ms),))
                cur.execute(f"EXPLAIN (FORMAT JSON, VERBOSE, COSTS) {probe_sql}")
                row = cur.fetchone()
            conn.rollback()  # never leave a transaction open; nothing was written anyway
        return row[0] if row else None

    return _run


def pg_explain_estimate(
    sql: str,
    large_tables: list[LargeTableStat],
    *,
    dsn: str | None = None,
    runner: ExplainRunner | None = None,
    source_dialect: str | None = None,
    timeout_ms: int = DEFAULT_PROBE_TIMEOUT_MS,
) -> PlanEstimate:
    """Run a Postgres-side `EXPLAIN (FORMAT JSON)` estimate for a generated
    (DuckDB-dialect) candidate and return a structured `PlanEstimate`.

    Steps: (1) transpile duckdb->postgres + strip the ATTACH catalog alias, (2)
    run `EXPLAIN (FORMAT JSON)` read-only under `statement_timeout` via `runner`
    (default: a psycopg runner over `dsn`), (3) parse the plan tree for the
    large-table SCAN-node estimates + the root estimate, asserting NO ANALYZE ran.

    NEVER executes the query. On ANY failure (transpile, connection, timeout,
    unparseable plan) returns `PlanEstimate(available=False, ...)` so the caller
    falls back to the syntactic guard (fail-closed) rather than passing blindly.

    Provide EITHER `runner` (hermetic tests / custom transport) OR `dsn` (a
    psycopg runner is built for you). Providing neither -> unavailable.
    """
    if runner is None:
        if not dsn:
            return PlanEstimate(
                available=False,
                unavailable_reason="No EXPLAIN runner and no DSN provided; cannot probe Postgres.",
            )
        runner = _default_psycopg_runner(dsn)

    try:
        probe_sql = transpile_duckdb_to_postgres_for_probe(sql, source_dialect=source_dialect)
    except ValueError as exc:
        return PlanEstimate(available=False, unavailable_reason=str(exc))

    # Safety assertion: EXPLAIN probe must never carry ANALYZE (research §6).
    if _ANALYZE_TOKEN.search(probe_sql):
        return PlanEstimate(
            available=False,
            probe_sql=probe_sql,
            unavailable_reason="Transpiled probe SQL contains ANALYZE; refusing to run (would execute).",
        )

    try:
        explain_json = runner(probe_sql, timeout_ms)
    except Exception as exc:  # noqa: BLE001 — any probe failure -> unavailable -> fall back to syntactic
        return PlanEstimate(
            available=False,
            probe_sql=probe_sql,
            unavailable_reason=f"EXPLAIN probe failed: {exc}",
        )

    try:
        return parse_plan_estimate(explain_json, large_tables, probe_sql=probe_sql)
    except AssertionError:
        # An ANALYZE somehow ran (Actual Rows present) — treat as unavailable and
        # fall back rather than trust executed numbers. Re-surfaced as a reason.
        return PlanEstimate(
            available=False,
            probe_sql=probe_sql,
            unavailable_reason="EXPLAIN plan contained Actual Rows (ANALYZE ran); estimate discarded.",
        )
    except Exception as exc:  # noqa: BLE001
        return PlanEstimate(
            available=False,
            probe_sql=probe_sql,
            unavailable_reason=f"Failed to parse EXPLAIN plan: {exc}",
        )
