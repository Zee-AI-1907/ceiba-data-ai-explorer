"""test_explain_estimate.py — ceiba_nl2sql.guard.explain_estimate (Postgres-side
EXPLAIN cardinality guard; docs/research/EXPLAIN_CARDINALITY_GUARD.md).

Hermetic: NO live DB. Every test either parses a CAPTURED Postgres
`EXPLAIN (FORMAT JSON)` plan tree (feeding it through the injectable
`ExplainRunner`) or exercises the duckdb->postgres probe transpile directly.
Proves the guard reads the large-table SCAN node estimate (NOT the LIMIT-masked
top-level `Plan Rows`), rejects a huge estimate, passes a small one, catches
join fan-out at the root, and falls back (defer) on transpile/probe failure so
the pipeline defers to the syntactic guard (fail-closed).
"""

from __future__ import annotations

import sys
import types

import pytest

from ceiba_nl2sql.guard.explain_estimate import (
    JOIN_BLOWUP_REJECT_ROWS,
    LargeTableStat,
    ExplainVerdict,
    _default_psycopg_runner,
    evaluate_plan_estimate,
    parse_plan_estimate,
    pg_explain_estimate,
    transpile_duckdb_to_postgres_for_probe,
)

MONITOR_MEASUREMENTS = LargeTableStat(bare_name="MonitorMeasurements", reltuples=337_000_000.0)


# ── captured EXPLAIN (FORMAT JSON) plan fixtures ──────────────────────────────


def _limit_over_huge_seqscan_plan(scan_rows: int) -> list:
    """Mirrors the research §3 live finding: a `... LIMIT 1000` over a big table
    reports a small TOP-LEVEL `Plan Rows` (the LIMIT) but a HUGE inner Seq Scan
    `Plan Rows`. The guard MUST read the inner scan node, not the masked top.
    """
    return [
        {
            "Plan": {
                "Node Type": "Limit",
                "Plan Rows": 1000,
                "Plans": [
                    {
                        "Node Type": "Seq Scan",
                        "Relation Name": "MonitorMeasurements",
                        "Plan Rows": scan_rows,
                        "Total Cost": 12345.0,
                    }
                ],
            }
        }
    ]


def _bounded_index_scan_plan(scan_rows: int) -> list:
    """A selective time/equality filter chose an Index Scan with a small estimate
    (research §1c: 483 -> 42 time-bound)."""
    return [
        {
            "Plan": {
                "Node Type": "Limit",
                "Plan Rows": min(scan_rows, 1000),
                "Plans": [
                    {
                        "Node Type": "Index Scan",
                        "Relation Name": "MonitorMeasurements",
                        "Plan Rows": scan_rows,
                    }
                ],
            }
        }
    ]


def _cartesian_root_plan(leaf_rows: int, root_rows: int) -> list:
    """A Nested Loop whose ROOT estimate explodes (research §1c cartesian
    483^2 = 233,289) even though each leaf scan is bounded."""
    return [
        {
            "Plan": {
                "Node Type": "Nested Loop",
                "Plan Rows": root_rows,
                "Plans": [
                    {"Node Type": "Index Scan", "Relation Name": "MonitorMeasurements", "Plan Rows": leaf_rows},
                    {"Node Type": "Index Scan", "Relation Name": "Monitors", "Plan Rows": leaf_rows},
                ],
            }
        }
    ]


# ── parse: reads the large-table SCAN node, ignores the LIMIT-masked top ──────


def test_parse_reads_inner_scan_estimate_not_limit_masked_top():
    estimate = parse_plan_estimate(_limit_over_huge_seqscan_plan(337_000_000), [MONITOR_MEASUREMENTS])
    assert estimate.available is True
    # The authoritative signal is the inner scan node (337M), NOT the top-level
    # LIMIT of 1000.
    assert estimate.max_large_scan_rows == 337_000_000
    assert estimate.root_rows == 1000
    assert estimate.large_scan_by_table["monitormeasurements"] == 337_000_000


def test_parse_small_bounded_estimate():
    estimate = parse_plan_estimate(_bounded_index_scan_plan(42), [MONITOR_MEASUREMENTS])
    assert estimate.available is True
    assert estimate.max_large_scan_rows == 42


def test_parse_no_large_table_scan_yields_available_but_no_scan():
    plan = [{"Plan": {"Node Type": "Seq Scan", "Relation Name": "ICD10s", "Plan Rows": 20000}}]
    estimate = parse_plan_estimate(plan, [MONITOR_MEASUREMENTS])
    assert estimate.available is True
    assert estimate.max_large_scan_rows is None


# ── policy: huge -> reject, small -> pass, root fan-out -> reject ─────────────


def test_policy_huge_scan_rejects():
    estimate = parse_plan_estimate(_limit_over_huge_seqscan_plan(337_000_000), [MONITOR_MEASUREMENTS])
    verdict = evaluate_plan_estimate(estimate, [MONITOR_MEASUREMENTS])
    assert verdict.action == "reject"
    assert "MonitorMeasurements" in (verdict.reason or "")


def test_policy_small_scan_passes():
    estimate = parse_plan_estimate(_bounded_index_scan_plan(42), [MONITOR_MEASUREMENTS])
    verdict = evaluate_plan_estimate(estimate, [MONITOR_MEASUREMENTS])
    assert verdict.action == "pass"


def test_policy_mid_scan_repairs():
    # Between SCAN_WARN (1M) and the reject threshold (max(10M, 10% of 337M = 33.7M)).
    estimate = parse_plan_estimate(_bounded_index_scan_plan(5_000_000), [MONITOR_MEASUREMENTS])
    verdict = evaluate_plan_estimate(estimate, [MONITOR_MEASUREMENTS])
    assert verdict.action == "repair"
    assert "5,000,000" in (verdict.reason or "")


def test_policy_relative_threshold_scales_with_table_size():
    # 20M rows: below the 10M absolute? No — above 10M, but below 10% of 337M
    # (33.7M), so the RELATIVE threshold keeps it a 'repair', not a 'reject'.
    estimate = parse_plan_estimate(_bounded_index_scan_plan(20_000_000), [MONITOR_MEASUREMENTS])
    verdict = evaluate_plan_estimate(estimate, [MONITOR_MEASUREMENTS])
    assert verdict.action == "repair"
    # A small table with the SAME 20M estimate would reject (20M > max(10M, 10%*small)).
    small = LargeTableStat(bare_name="MonitorMeasurements", reltuples=50_000_000.0)
    verdict_small = evaluate_plan_estimate(
        parse_plan_estimate(_bounded_index_scan_plan(20_000_000), [small]), [small]
    )
    assert verdict_small.action == "reject"


def test_policy_root_join_fanout_rejects_even_with_bounded_leaves():
    root_rows = JOIN_BLOWUP_REJECT_ROWS + 1
    estimate = parse_plan_estimate(_cartesian_root_plan(leaf_rows=500, root_rows=root_rows), [MONITOR_MEASUREMENTS])
    verdict = evaluate_plan_estimate(estimate, [MONITOR_MEASUREMENTS])
    assert verdict.action == "reject"
    assert "fan-out" in (verdict.reason or "").lower()


# ── fail-closed: transpile/probe failure -> defer (fall back to syntactic) ────


def test_transpile_failure_yields_unavailable_estimate():
    estimate = pg_explain_estimate("SELECT ( bad sql (", [MONITOR_MEASUREMENTS], runner=lambda *_: None)
    assert estimate.available is False
    assert "transpile" in (estimate.unavailable_reason or "").lower()


def test_probe_runner_error_yields_unavailable_estimate():
    def _boom(_probe_sql: str, _timeout: int):
        raise RuntimeError("connection refused")

    estimate = pg_explain_estimate(
        'SELECT * FROM staging."Shared"."MonitorMeasurements" LIMIT 10',
        [MONITOR_MEASUREMENTS],
        runner=_boom,
    )
    assert estimate.available is False
    assert "connection refused" in (estimate.unavailable_reason or "")


def test_unavailable_estimate_defers_to_syntactic():
    estimate = pg_explain_estimate("SELECT ( bad", [MONITOR_MEASUREMENTS], runner=lambda *_: None)
    verdict = evaluate_plan_estimate(estimate, [MONITOR_MEASUREMENTS])
    assert verdict.action == "defer"


def test_no_dsn_and_no_runner_is_unavailable():
    estimate = pg_explain_estimate('SELECT 1', [MONITOR_MEASUREMENTS])
    assert estimate.available is False


# ── safety: EXPLAIN must never run ANALYZE ────────────────────────────────────


def test_actual_rows_in_plan_is_treated_as_analyze_and_discarded():
    # If a plan carries Actual Rows, an ANALYZE executed — the guard must refuse
    # to trust it and mark the estimate unavailable (fall back, do not pass).
    plan = [
        {
            "Plan": {
                "Node Type": "Seq Scan",
                "Relation Name": "MonitorMeasurements",
                "Plan Rows": 42,
                "Actual Rows": 42,
            }
        }
    ]
    estimate = pg_explain_estimate(
        'SELECT * FROM staging."Shared"."MonitorMeasurements" LIMIT 10',
        [MONITOR_MEASUREMENTS],
        runner=lambda *_: plan,
    )
    assert estimate.available is False
    assert "analyze" in (estimate.unavailable_reason or "").lower()


# ── duckdb->postgres probe transpile: strips the ATTACH catalog alias ─────────


def test_transpile_strips_leading_source_catalog_alias():
    probe = transpile_duckdb_to_postgres_for_probe(
        'SELECT "Value" FROM staging."Shared"."MonitorMeasurements" WHERE "DeviceId" = 5',
        source_dialect="duckdb",
    )
    # The DuckDB ATTACH alias `staging` is stripped; native Postgres "Shared"."X".
    assert "staging" not in probe
    assert '"Shared"."MonitorMeasurements"' in probe


def test_transpile_never_emits_analyze():
    probe = transpile_duckdb_to_postgres_for_probe(
        'SELECT * FROM staging."Shared"."MonitorMeasurements" LIMIT 10', source_dialect="duckdb"
    )
    assert "ANALYZE" not in probe.upper()


# ── end-to-end probe wiring through the injectable runner ─────────────────────


# ── psycopg runner: SET-config path (regression: SET can't take a bind param) ─


class _FakeCursor:
    def __init__(self, statements: list[tuple], plan) -> None:
        self._statements = statements
        self._plan = plan

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False

    def execute(self, sql, params=None):
        self._statements.append((sql, params))

    def fetchone(self):
        return (self._plan,)


class _FakeConn:
    def __init__(self, statements: list[tuple], plan) -> None:
        self._statements = statements
        self._plan = plan

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False

    def cursor(self):
        return _FakeCursor(self._statements, self._plan)

    def rollback(self):
        self._statements.append(("ROLLBACK", None))


def test_default_runner_sets_statement_timeout_without_bind_param_in_set(monkeypatch):
    """Regression (found live): `SET LOCAL statement_timeout = %s` is a Postgres
    syntax error — SET does not accept a bind placeholder. The runner must set it
    via `set_config(...)` (which does), and force the transaction READ ONLY.
    """
    statements: list[tuple] = []
    plan = [{"Plan": {"Node Type": "Seq Scan", "Relation Name": "MonitorMeasurements", "Plan Rows": 42}}]

    fake_psycopg = types.SimpleNamespace(connect=lambda dsn, **kw: _FakeConn(statements, plan))
    monkeypatch.setitem(sys.modules, "psycopg", fake_psycopg)

    runner = _default_psycopg_runner("postgresql://ignored/db")
    result = runner('SELECT * FROM "Shared"."MonitorMeasurements" LIMIT 10', 2000)

    executed = [s for s, _ in statements]
    assert any(s == "SET TRANSACTION READ ONLY" for s in executed)
    # No `SET ... = %s` (would be a live syntax error); set_config carries the value.
    assert not any(s.upper().startswith("SET LOCAL STATEMENT_TIMEOUT = %S") for s in executed)
    assert any("set_config('statement_timeout'" in s for s in executed)
    assert any(s.startswith("EXPLAIN (FORMAT JSON") for s in executed)
    assert result is plan


def test_default_runner_refuses_analyze_probe(monkeypatch):
    fake_psycopg = types.SimpleNamespace(connect=lambda *a, **k: _FakeConn([], None))
    monkeypatch.setitem(sys.modules, "psycopg", fake_psycopg)
    runner = _default_psycopg_runner("postgresql://ignored/db")
    with pytest.raises(ValueError, match="ANALYZE"):
        runner("EXPLAIN ANALYZE SELECT 1", 2000)


def test_pg_explain_estimate_end_to_end_reads_scan_node():
    captured = {}

    def _runner(probe_sql: str, timeout_ms: int):
        captured["probe_sql"] = probe_sql
        captured["timeout_ms"] = timeout_ms
        return _limit_over_huge_seqscan_plan(337_000_000)

    estimate = pg_explain_estimate(
        'SELECT * FROM staging."Shared"."MonitorMeasurements" LIMIT 1000',
        [MONITOR_MEASUREMENTS],
        runner=_runner,
    )
    assert estimate.available is True
    assert estimate.max_large_scan_rows == 337_000_000
    # The runner received native-Postgres SQL (alias stripped), NOT the duckdb ref.
    assert "staging" not in captured["probe_sql"]
    verdict = evaluate_plan_estimate(estimate, [MONITOR_MEASUREMENTS])
    assert verdict.action == "reject"
