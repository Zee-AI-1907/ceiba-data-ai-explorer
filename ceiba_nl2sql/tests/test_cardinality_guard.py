"""test_cardinality_guard.py — ceiba_nl2sql.guard.cardinality (Phase 2 port of
lib/rag/__tests__/cardinalityGuard.test.ts's essential assertions;
docs/PYTHON_NL2SQL_SERVICE_PLAN.md §1.1, §3.1, §3.2 "Upgraded from lexical to
sqlglot-AST detection"). Proves the sqlglot-AST guard enforces the SAME
policy the TS lexical guard did, on the SAME canonical cases.
"""

from __future__ import annotations

import pytest

from ceiba_nl2sql.guard.cardinality import (
    LargeTableSpec,
    build_cardinality_guard_options,
    cardinality_guard,
    cardinality_guard_from_context,
)

LARGE_TABLE = LargeTableSpec(table_name="MeasurementsMock", quoted_ref='"public"."MeasurementsMock"')
REQUIRED_TIME_COLUMN = {"MeasurementsMock": "RecordedAt"}


def test_pass_when_no_large_table_referenced():
    sql = 'SELECT * FROM "VisitMock" LIMIT 10'
    verdict = cardinality_guard(sql, large_tables=[LARGE_TABLE], required_time_column_by_table=REQUIRED_TIME_COLUMN)
    assert verdict.ok is True
    assert verdict.action == "pass"


def test_pass_when_bounded_and_limited():
    sql = """SELECT * FROM "MeasurementsMock" WHERE "RecordedAt" >= now() - INTERVAL '3 hours' LIMIT 1000"""
    verdict = cardinality_guard(sql, large_tables=[LARGE_TABLE], required_time_column_by_table=REQUIRED_TIME_COLUMN)
    assert verdict.ok is True
    assert verdict.action == "pass"


def test_repair_appends_limit_when_time_bound_present_but_no_limit():
    sql = """SELECT * FROM "MeasurementsMock" WHERE "RecordedAt" >= now() - INTERVAL '3 hours'"""
    verdict = cardinality_guard(sql, large_tables=[LARGE_TABLE], required_time_column_by_table=REQUIRED_TIME_COLUMN, default_limit=500)
    assert verdict.ok is True
    assert verdict.action == "repair"
    assert verdict.repaired_sql is not None
    assert "LIMIT 500" in verdict.repaired_sql


def test_reject_when_wholly_unbounded_no_time_predicate_at_all():
    sql = 'SELECT * FROM "MeasurementsMock" WHERE "Value" > 120'
    verdict = cardinality_guard(sql, large_tables=[LARGE_TABLE], required_time_column_by_table=REQUIRED_TIME_COLUMN)
    assert verdict.ok is False
    assert verdict.action == "reject"
    assert "unbounded" in (verdict.reason or "").lower()


def test_reject_when_limit_present_but_no_time_bound():
    sql = 'SELECT * FROM "MeasurementsMock" WHERE "Value" > 120 LIMIT 1000'
    verdict = cardinality_guard(sql, large_tables=[LARGE_TABLE], required_time_column_by_table=REQUIRED_TIME_COLUMN)
    assert verdict.ok is False
    assert verdict.action == "reject"


def test_reject_when_large_table_has_no_configured_time_column():
    sql = 'SELECT * FROM "MeasurementsMock" LIMIT 1000'
    verdict = cardinality_guard(sql, large_tables=[LARGE_TABLE], required_time_column_by_table={})
    assert verdict.ok is False
    assert verdict.action == "reject"
    assert "no known time column" in (verdict.repair_hint or "")


def test_time_bound_with_between_is_detected():
    sql = """SELECT * FROM "MeasurementsMock" WHERE "RecordedAt" BETWEEN now() - INTERVAL '3 hours' AND now() LIMIT 1000"""
    verdict = cardinality_guard(sql, large_tables=[LARGE_TABLE], required_time_column_by_table=REQUIRED_TIME_COLUMN)
    assert verdict.ok is True
    assert verdict.action == "pass"


def test_time_bound_with_cast_is_detected():
    sql = """SELECT * FROM "MeasurementsMock" WHERE CAST("RecordedAt" AS TIMESTAMPTZ) >= now() - INTERVAL '3 hours' LIMIT 1000"""
    verdict = cardinality_guard(sql, large_tables=[LARGE_TABLE], required_time_column_by_table=REQUIRED_TIME_COLUMN)
    assert verdict.ok is True
    assert verdict.action == "pass"


def test_qualified_table_alias_still_matches_bare_table_name():
    """An AST walk of FROM/JOIN nodes recognizes `mock.public."MeasurementsMock" m`
    the same as a bare `"MeasurementsMock"` — the exact case a lexical regex
    substring match could miss if quoting/casing/aliasing varied.
    """
    sql = """SELECT m."Value" FROM mock.public."MeasurementsMock" m
    WHERE m."RecordedAt" >= now() - INTERVAL '3 hours' LIMIT 1000"""
    verdict = cardinality_guard(sql, large_tables=[LARGE_TABLE], required_time_column_by_table=REQUIRED_TIME_COLUMN)
    assert verdict.ok is True
    assert verdict.action == "pass"


def test_unparseable_sql_fails_closed_as_reject():
    verdict = cardinality_guard(
        "SELECT FROM WHERE (((", large_tables=[LARGE_TABLE], required_time_column_by_table=REQUIRED_TIME_COLUMN
    )
    assert verdict.ok is False
    assert verdict.action == "reject"


# ── build_cardinality_guard_options / cardinality_guard_from_context ────────


def test_build_cardinality_guard_options_from_rendered_table_dicts():
    tables = [
        {
            "table_id": "mock.public.MeasurementsMock",
            "quoted_ref": '"public"."MeasurementsMock"',
            "is_large_time_series": True,
            "required_time_column": '"RecordedAt"',
        },
        {
            "table_id": "mock.public.VisitMock",
            "quoted_ref": '"public"."VisitMock"',
            "is_large_time_series": False,
            "required_time_column": None,
        },
    ]
    large_tables, required_time_column_by_table = build_cardinality_guard_options(tables)
    assert len(large_tables) == 1
    assert large_tables[0].table_name == "MeasurementsMock"
    assert required_time_column_by_table["MeasurementsMock"] == "RecordedAt"


def test_cardinality_guard_from_context_end_to_end():
    tables = [
        {
            "table_id": "mock.public.MeasurementsMock",
            "quoted_ref": '"public"."MeasurementsMock"',
            "is_large_time_series": True,
            "required_time_column": '"RecordedAt"',
        }
    ]
    sql = 'SELECT * FROM "MeasurementsMock" WHERE "Value" > 120'
    verdict = cardinality_guard_from_context(sql, tables)
    assert verdict.ok is False
    assert verdict.action == "reject"


# ── P0-arch parity fixes ──────────────────────────────────────────────────────


def test_non_numeric_limit_is_treated_as_no_limit():
    """A `LIMIT $1` placeholder is NOT a real bound — the TS guard's
    `LIMIT\\s+\\d+` regex would miss it and auto-repair, so the Python guard
    must repair (append a numeric LIMIT) too, not pass.
    """
    sql = """SELECT * FROM "MeasurementsMock" WHERE "RecordedAt" >= now() - INTERVAL '3 hours' LIMIT $1"""
    verdict = cardinality_guard(
        sql, large_tables=[LARGE_TABLE], required_time_column_by_table=REQUIRED_TIME_COLUMN, default_limit=500
    )
    assert verdict.action == "repair"
    assert "LIMIT 500" in (verdict.repaired_sql or "")


def test_lexical_fallback_catches_large_table_the_ast_missed():
    """If the AST surfaces zero large tables but the raw SQL word-boundary
    matches a known large-table name, the guard still enforces the bounding
    policy (fail-closed lexical fallback matching the TS word-boundary regex).
    """
    import sqlglot

    from ceiba_nl2sql.guard.cardinality import _referenced_table_names

    # `FROM other_tbl AS MeasurementsMock` — the large-table name appears only
    # as an ALIAS, so the AST's exp.Table FROM walk surfaces only `other_tbl`
    # (a genuine AST miss). The lexical word-boundary fallback matches the alias
    # and enforces the bounding policy (reject: no time bound present).
    sql = "SELECT * FROM other_tbl AS MeasurementsMock LIMIT 10"
    assert "measurementsmock" not in _referenced_table_names(sqlglot.parse_one(sql, read="duckdb"))
    verdict = cardinality_guard(sql, large_tables=[LARGE_TABLE], required_time_column_by_table=REQUIRED_TIME_COLUMN)
    assert verdict.ok is False
    assert verdict.action == "reject"
