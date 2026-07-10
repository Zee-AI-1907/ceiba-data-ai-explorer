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
    ParentTimeBound,
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


def test_grouped_bounded_large_table_without_order_by_rejects():
    # Rollup-safety (latent-bug fix): a time-bounded large-table rollup with no
    # ORDER BY and no LIMIT must NOT get a silent LIMIT (which drops arbitrary
    # groups) — reject so the model adds an ORDER BY + top-N.
    sql = '''SELECT "DeviceId", count(*) FROM "MeasurementsMock"
        WHERE "RecordedAt" >= now() - INTERVAL '3 hours' GROUP BY "DeviceId"'''
    verdict = cardinality_guard(sql, large_tables=[LARGE_TABLE], required_time_column_by_table=REQUIRED_TIME_COLUMN)
    assert verdict.action == "reject"
    assert verdict.repaired_sql is None
    assert verdict.repair_hint and "ORDER BY" in verdict.repair_hint


def test_grouped_bounded_large_table_with_order_by_repairs_limit():
    # With an ORDER BY the top-N is deterministic, so appending a LIMIT is safe.
    sql = '''SELECT "DeviceId", count(*) AS c FROM "MeasurementsMock"
        WHERE "RecordedAt" >= now() - INTERVAL '3 hours' GROUP BY "DeviceId" ORDER BY c DESC'''
    verdict = cardinality_guard(sql, large_tables=[LARGE_TABLE], required_time_column_by_table=REQUIRED_TIME_COLUMN, default_limit=500)
    assert verdict.action == "repair"
    assert "LIMIT 500" in verdict.repaired_sql


def test_default_time_window_unset_rejects_with_generic_hint():
    # Unbounded large table, no default window configured -> today's behavior:
    # a plain reject whose hint does NOT name a specific window.
    sql = 'SELECT * FROM "MeasurementsMock"'
    verdict = cardinality_guard(sql, large_tables=[LARGE_TABLE], required_time_column_by_table=REQUIRED_TIME_COLUMN)
    assert verdict.action == "reject"
    assert "24 hours" not in (verdict.repair_hint or "")


def test_default_time_window_set_rejects_with_named_window_hint_and_never_injects():
    # With a default window configured, the reject HINT names it so the MODEL
    # writes it explicitly — the guard NEVER mutates the SQL (no repaired_sql),
    # so the clinical semantics change is always visible/auditable.
    sql = 'SELECT * FROM "MeasurementsMock"'
    verdict = cardinality_guard(
        sql, large_tables=[LARGE_TABLE], required_time_column_by_table=REQUIRED_TIME_COLUMN,
        default_time_window="24 hours",
    )
    assert verdict.action == "reject"
    assert verdict.repaired_sql is None  # never silently injects a window
    assert "24 hours" in (verdict.repair_hint or "")


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


# ── Fix C: strengthened selective-predicate policy ─────────────────────────
#
# A large table (e.g. a 271M-row VentilatorMeasurements analog) must have
# EITHER a time-bound predicate OR a selective equality/IN predicate on an
# indexed/FK/PK column — "a LIMIT after a full scan still scans".

VENTILATOR_TABLE = LargeTableSpec(
    table_name="VentilatorMeasurements",
    quoted_ref='"Shared"."VentilatorMeasurements"',
    selective_columns=["PatientId", "DeviceId"],
)


def test_reject_when_no_time_bound_and_no_selective_predicate_and_no_time_column_configured():
    """The exact failure case from the task: a bare COUNT/scan over a huge
    table with a LIMIT (or nothing) but NO selective filter at all -> reject,
    regardless of the LIMIT's presence.
    """
    sql = 'SELECT COUNT(*) FROM "VentilatorMeasurements" LIMIT 1000'
    verdict = cardinality_guard(sql, large_tables=[VENTILATOR_TABLE], required_time_column_by_table={})
    assert verdict.ok is False
    assert verdict.action == "reject"
    assert "selective" in (verdict.reason or "").lower()


def test_reject_when_no_time_bound_and_no_selective_predicate_at_all_no_limit():
    sql = 'SELECT COUNT(*) FROM "VentilatorMeasurements"'
    verdict = cardinality_guard(sql, large_tables=[VENTILATOR_TABLE], required_time_column_by_table={})
    assert verdict.ok is False
    assert verdict.action == "reject"


def test_pass_when_selective_equality_predicate_present_no_time_column_configured():
    """A selective equality filter on an indexed/FK column satisfies the
    policy even with no required_time_column configured at all.
    """
    sql = 'SELECT * FROM "VentilatorMeasurements" WHERE "PatientId" = 42 LIMIT 1000'
    verdict = cardinality_guard(sql, large_tables=[VENTILATOR_TABLE], required_time_column_by_table={})
    assert verdict.ok is True
    assert verdict.action == "pass"


def test_repair_when_selective_equality_predicate_present_but_missing_limit():
    sql = 'SELECT * FROM "VentilatorMeasurements" WHERE "PatientId" = 42'
    verdict = cardinality_guard(
        sql, large_tables=[VENTILATOR_TABLE], required_time_column_by_table={}, default_limit=250
    )
    assert verdict.ok is True
    assert verdict.action == "repair"
    assert "LIMIT 250" in (verdict.repaired_sql or "")


def test_pass_when_selective_in_predicate_present():
    sql = 'SELECT * FROM "VentilatorMeasurements" WHERE "DeviceId" IN (1, 2, 3) LIMIT 1000'
    verdict = cardinality_guard(sql, large_tables=[VENTILATOR_TABLE], required_time_column_by_table={})
    assert verdict.ok is True
    assert verdict.action == "pass"


def test_selective_predicate_on_non_selective_column_does_not_satisfy_policy():
    """Filtering on a column that is NOT in `selective_columns` (not indexed/
    FK/PK) does not satisfy the escape hatch — this is not a real selective
    filter as far as the guard can verify.
    """
    sql = 'SELECT * FROM "VentilatorMeasurements" WHERE "SomeUnindexedNote" = \'x\' LIMIT 1000'
    verdict = cardinality_guard(sql, large_tables=[VENTILATOR_TABLE], required_time_column_by_table={})
    assert verdict.ok is False
    assert verdict.action == "reject"


def test_selective_predicate_also_satisfies_policy_when_time_column_is_configured():
    """SQL wording: "EITHER a time-bound predicate... OR a selective
    equality/IN predicate" — the equality/IN alternative is accepted even
    when a required_time_column IS configured, as long as no valid time
    bound is present but a real selective filter is.
    """
    sql = 'SELECT * FROM "MeasurementsMock" WHERE "PatientId" = 42 LIMIT 1000'
    table = LargeTableSpec(
        table_name="MeasurementsMock", quoted_ref='"public"."MeasurementsMock"', selective_columns=["PatientId"]
    )
    verdict = cardinality_guard(sql, large_tables=[table], required_time_column_by_table=REQUIRED_TIME_COLUMN)
    assert verdict.ok is True
    assert verdict.action == "pass"


def test_existing_time_bound_behavior_unchanged_when_selective_columns_present():
    """Regression guard: a table that already satisfies the time-bound path
    behaves exactly as before, whether or not `selective_columns` is also
    populated — the new rule does not require BOTH.
    """
    sql = """SELECT * FROM "MeasurementsMock" WHERE "RecordedAt" >= now() - INTERVAL '3 hours' LIMIT 1000"""
    table = LargeTableSpec(
        table_name="MeasurementsMock", quoted_ref='"public"."MeasurementsMock"', selective_columns=["PatientId"]
    )
    verdict = cardinality_guard(sql, large_tables=[table], required_time_column_by_table=REQUIRED_TIME_COLUMN)
    assert verdict.ok is True
    assert verdict.action == "pass"


def test_repair_hint_mentions_both_time_bound_and_selective_filter_options():
    sql = 'SELECT * FROM "MeasurementsMock" LIMIT 1000'
    table = LargeTableSpec(
        table_name="MeasurementsMock", quoted_ref='"public"."MeasurementsMock"', selective_columns=["DeviceId"]
    )
    verdict = cardinality_guard(sql, large_tables=[table], required_time_column_by_table=REQUIRED_TIME_COLUMN)
    assert verdict.ok is False
    assert verdict.action == "reject"
    hint = verdict.repair_hint or ""
    assert "time-bound predicate" in hint
    assert "equality/IN filter" in hint


def test_build_cardinality_guard_options_derives_selective_columns_from_indexed_and_fk_columns():
    tables = [
        {
            "table_id": "staging.Shared.VentilatorMeasurements",
            "quoted_ref": '"Shared"."VentilatorMeasurements"',
            "is_large_time_series": True,
            "required_time_column": None,
            "columns": [
                {"name": "Id", "isPrimaryKey": True, "isIndexed": True},
                {"name": "PatientId", "is_indexed": False, "is_foreign_key_or_primary_key": True},
                {"name": "Value", "isIndexed": False, "isPrimaryKey": False},
            ],
        }
    ]
    large_tables, _ = build_cardinality_guard_options(tables)
    assert len(large_tables) == 1
    assert set(large_tables[0].selective_columns) == {"Id", "PatientId"}


def test_cardinality_guard_from_context_passes_with_selective_predicate_and_no_time_column():
    tables = [
        {
            "table_id": "staging.Shared.VentilatorMeasurements",
            "quoted_ref": '"Shared"."VentilatorMeasurements"',
            "is_large_time_series": True,
            "required_time_column": None,
            "columns": [
                {"name": "Id", "isPrimaryKey": True},
                {"name": "PatientId", "is_foreign_key_or_primary_key": True},
            ],
        }
    ]
    sql = 'SELECT * FROM "VentilatorMeasurements" WHERE "PatientId" = 7 LIMIT 1000'
    verdict = cardinality_guard_from_context(sql, tables)
    assert verdict.ok is True
    assert verdict.action == "pass"


def test_cardinality_guard_from_context_still_rejects_bare_scan_with_no_selective_filter():
    """This is the exact real-world regression the task describes: a
    'ventilator count' query timing out scanning a 271M-row table with a
    LIMIT (or an aggregate with no WHERE) but no selective filter.
    """
    tables = [
        {
            "table_id": "staging.Shared.VentilatorMeasurements",
            "quoted_ref": '"Shared"."VentilatorMeasurements"',
            "is_large_time_series": True,
            "required_time_column": None,
            "columns": [
                {"name": "Id", "isPrimaryKey": True},
                {"name": "PatientId", "is_foreign_key_or_primary_key": True},
            ],
        }
    ]
    sql = 'SELECT COUNT(*) FROM "VentilatorMeasurements" LIMIT 1000'
    verdict = cardinality_guard_from_context(sql, tables)
    assert verdict.ok is False
    assert verdict.action == "reject"


# ── Cardinality-guard remediation: HR multi-hop query false-negative ───────
#
# Root cause (verified against real staging data): MonitorMeasurements (344M
# rows) has NO own time column — its time dimension lives on the joined
# PARENT Monitors.MeasuredDate, one hop away via
# MonitorMeasurements.DeviceId -> Monitors.Id. The guard must credit a
# time-bound predicate on that PARENT's time column, reached via the exact
# FK join, as bounding the large table (branch (c) of the policy) — the
# minimal repro from the task:
#   ... JOIN Monitors m ... JOIN MonitorMeasurements mm ON mm.DeviceId=m.Id
#   WHERE m.MeasuredDate >= now()-INTERVAL '3' HOUR AND mm.MeasurementTypeId = 2

MONITOR_MEASUREMENTS_TABLE = LargeTableSpec(
    table_name="MonitorMeasurements",
    quoted_ref='"Shared"."MonitorMeasurements"',
    selective_columns=["DeviceId", "MeasurementTypeId", "Id"],
    parent_time_bound=ParentTimeBound(
        parent_table_name="Monitors",
        parent_time_column="MeasuredDate",
        from_columns=["DeviceId"],
        to_columns=["Id"],
    ),
)
MONITORS_TABLE = LargeTableSpec(
    table_name="Monitors", quoted_ref='"Shared"."Monitors"', selective_columns=["Id"]
)
MONITORS_REQUIRED_TIME_COLUMN = {"Monitors": "MeasuredDate"}

PRIMARY_REPRO_SQL = """SELECT p."Id" FROM "Patients" p
JOIN "Acceptances" a ON a."PatientId" = p."Id"
JOIN "Monitors" m ON m."AcceptanceId" = a."Id"
JOIN "MonitorMeasurements" mm ON mm."DeviceId" = m."Id"
WHERE m."MeasuredDate" >= now() - INTERVAL '3' HOUR AND mm."MeasurementTypeId" = 2
LIMIT 1000
"""


def test_hr_multi_hop_repro_passes_via_parent_join_time_bound():
    """(a) FK-equality alone bounds it is exercised separately below; this is
    the exact reported false negative: a correct, bounded HR query rejected
    because the guard demanded a time bound on MonitorMeasurements' own
    (nonexistent) time column instead of crediting the parent-join bound.
    """
    verdict = cardinality_guard(
        PRIMARY_REPRO_SQL,
        large_tables=[MONITOR_MEASUREMENTS_TABLE, MONITORS_TABLE],
        required_time_column_by_table=MONITORS_REQUIRED_TIME_COLUMN,
        dialect="duckdb",
    )
    assert verdict.ok is True
    assert verdict.action == "pass"


def test_fk_equality_alone_bounds_monitor_measurements_with_no_time_bound_at_all():
    """(a) FK-equality alone bounds it -> PASS, per the task's required test list."""
    sql = 'SELECT mm."Value" FROM "MonitorMeasurements" mm WHERE mm."MeasurementTypeId" = 2 LIMIT 1000'
    verdict = cardinality_guard(
        sql, large_tables=[MONITOR_MEASUREMENTS_TABLE], required_time_column_by_table={}, dialect="duckdb"
    )
    assert verdict.ok is True
    assert verdict.action == "pass"


def test_parent_table_time_bound_via_join_bounds_the_large_table():
    """(b) parent-table time bound via join bounds it -> PASS, per the task's
    required test list. Isolated from the selective-columns escape hatch by
    using a large table with NO selective_columns configured at all.
    """
    table = LargeTableSpec(
        table_name="MonitorMeasurements",
        quoted_ref='"Shared"."MonitorMeasurements"',
        parent_time_bound=ParentTimeBound(
            parent_table_name="Monitors",
            parent_time_column="MeasuredDate",
            from_columns=["DeviceId"],
            to_columns=["Id"],
        ),
    )
    sql = """SELECT p."Id" FROM "Patients" p
    JOIN "Monitors" m ON m."PatientId" = p."Id"
    JOIN "MonitorMeasurements" mm ON mm."DeviceId" = m."Id"
    WHERE m."MeasuredDate" >= now() - INTERVAL '3' HOUR
    LIMIT 1000
    """
    verdict = cardinality_guard(sql, large_tables=[table], required_time_column_by_table={}, dialect="duckdb")
    assert verdict.ok is True
    assert verdict.action == "pass"


def test_truly_unbounded_still_rejects_with_parent_time_bound_configured():
    """(c) truly unbounded still REJECTs -> per the task's required test list.
    Configuring `parent_time_bound` must not turn into a blanket pass —
    the parent must actually be JOINED and time-bounded in THIS query.
    """
    sql = 'SELECT COUNT(*) FROM "MonitorMeasurements" mm LIMIT 1000'
    verdict = cardinality_guard(
        sql, large_tables=[MONITOR_MEASUREMENTS_TABLE], required_time_column_by_table={}, dialect="duckdb"
    )
    assert verdict.ok is False
    assert verdict.action == "reject"


def test_existing_own_time_column_case_still_passes_with_parent_time_bound_configured():
    """(d) the existing own-time-column case still PASSes -> per the task's
    required test list. A table with BOTH its own required_time_column AND a
    (irrelevant here) parent_time_bound configured behaves exactly as before
    when its own time bound is satisfied.
    """
    sql = """SELECT * FROM "MeasurementsMock" WHERE "RecordedAt" >= now() - INTERVAL '3 hours' LIMIT 1000"""
    table = LargeTableSpec(
        table_name="MeasurementsMock",
        quoted_ref='"public"."MeasurementsMock"',
        parent_time_bound=ParentTimeBound(
            parent_table_name="SomeOtherParent",
            parent_time_column="SomeTime",
            from_columns=["X"],
            to_columns=["Y"],
        ),
    )
    verdict = cardinality_guard(sql, large_tables=[table], required_time_column_by_table=REQUIRED_TIME_COLUMN)
    assert verdict.ok is True
    assert verdict.action == "pass"


def test_parent_join_bound_rejected_when_join_uses_wrong_columns():
    """A time bound on the parent's time column does NOT bound the large
    table when the SQL joins them on the WRONG columns (not the declared FK
    pair) — crediting this would let an incidental/incorrect join through.
    """
    sql = """SELECT p."Id" FROM "Patients" p
    JOIN "Acceptances" a ON a."PatientId" = p."Id"
    JOIN "Monitors" m ON m."AcceptanceId" = a."Id"
    JOIN "MonitorMeasurements" mm ON mm."Id" = m."Id"
    WHERE m."MeasuredDate" >= now() - INTERVAL '3' HOUR
    LIMIT 1000
    """
    verdict = cardinality_guard(
        sql,
        large_tables=[MONITOR_MEASUREMENTS_TABLE, MONITORS_TABLE],
        required_time_column_by_table=MONITORS_REQUIRED_TIME_COLUMN,
        dialect="duckdb",
    )
    assert verdict.ok is False
    assert verdict.action == "reject"


def test_parent_join_bound_rejected_when_parent_table_not_referenced_at_all():
    """A `parent_time_bound` configured for a parent the SQL never even joins
    to must not spuriously bound the large table.
    """
    sql = 'SELECT * FROM "MonitorMeasurements" mm WHERE mm."Value" > 120 LIMIT 1000'
    verdict = cardinality_guard(
        sql, large_tables=[MONITOR_MEASUREMENTS_TABLE], required_time_column_by_table={}, dialect="duckdb"
    )
    assert verdict.ok is False
    assert verdict.action == "reject"


def test_repair_hint_mentions_parent_join_time_bound_option_when_configured():
    sql = 'SELECT * FROM "MonitorMeasurements" mm JOIN "Monitors" m ON mm."DeviceId" = m."Id" LIMIT 1000'
    table = LargeTableSpec(
        table_name="MonitorMeasurements",
        quoted_ref='"Shared"."MonitorMeasurements"',
        parent_time_bound=ParentTimeBound(
            parent_table_name="Monitors",
            parent_time_column="MeasuredDate",
            from_columns=["DeviceId"],
            to_columns=["Id"],
        ),
    )
    verdict = cardinality_guard(sql, large_tables=[table], required_time_column_by_table={}, dialect="duckdb")
    assert verdict.ok is False
    assert verdict.action == "reject"
    assert "Monitors.MeasuredDate" in (verdict.repair_hint or "")


def test_build_cardinality_guard_options_derives_parent_time_bound_from_time_via_hint():
    tables = [
        {
            "table_id": "staging.Shared.MonitorMeasurements",
            "quoted_ref": '"Shared"."MonitorMeasurements"',
            "is_large_time_series": True,
            "required_time_column": None,
            "columns": [],
            "time_via": {
                "table": "staging.Shared.Monitors",
                "column": "MeasuredDate",
                "fromColumns": ["DeviceId"],
                "toColumns": ["Id"],
            },
        },
        {
            "table_id": "staging.Shared.Monitors",
            "quoted_ref": '"Shared"."Monitors"',
            "is_large_time_series": True,
            "required_time_column": '"MeasuredDate"',
            "columns": [],
        },
    ]
    large_tables, _ = build_cardinality_guard_options(tables)
    mm = next(t for t in large_tables if t.table_name == "MonitorMeasurements")
    assert mm.parent_time_bound == ParentTimeBound(
        parent_table_name="Monitors", parent_time_column="MeasuredDate", from_columns=["DeviceId"], to_columns=["Id"]
    )


def test_build_cardinality_guard_options_time_via_falls_back_to_tableid_tail_when_parent_not_rendered():
    tables = [
        {
            "table_id": "staging.Shared.MonitorMeasurements",
            "quoted_ref": '"Shared"."MonitorMeasurements"',
            "is_large_time_series": True,
            "required_time_column": None,
            "columns": [],
            "time_via": {
                "table": "staging.Shared.Monitors",
                "column": "MeasuredDate",
                "fromColumns": ["DeviceId"],
                "toColumns": ["Id"],
            },
        },
    ]
    large_tables, _ = build_cardinality_guard_options(tables)
    assert large_tables[0].parent_time_bound.parent_table_name == "Monitors"


def test_build_cardinality_guard_options_no_parent_time_bound_when_time_via_absent():
    tables = [
        {
            "table_id": "mock.public.MeasurementsMock",
            "quoted_ref": '"public"."MeasurementsMock"',
            "is_large_time_series": True,
            "required_time_column": '"RecordedAt"',
            "columns": [],
        },
    ]
    large_tables, _ = build_cardinality_guard_options(tables)
    assert large_tables[0].parent_time_bound is None


# ── Pre-existing false-negative closed alongside this fix: a bare JOIN ... ON
# equality on an FK/indexed column is NOT a selective filter ────────────────


def test_bare_join_on_equality_alone_does_not_satisfy_selective_predicate_escape_hatch():
    """A JOIN ... ON condition is the STRUCTURAL join predicate, not a
    row-reducing filter — crediting it would let a full join-scan of the
    large table through with NO actual filter anywhere in the query.
    """
    table = LargeTableSpec(
        table_name="MonitorMeasurements", quoted_ref='"Shared"."MonitorMeasurements"', selective_columns=["DeviceId"]
    )
    sql = 'SELECT * FROM "Monitors" m JOIN "MonitorMeasurements" mm ON mm."DeviceId" = m."Id" LIMIT 1000'
    verdict = cardinality_guard(sql, large_tables=[table], required_time_column_by_table={}, dialect="duckdb")
    assert verdict.ok is False
    assert verdict.action == "reject"


def test_where_clause_equality_on_same_column_as_join_on_still_satisfies_escape_hatch():
    """The escape hatch still works when the SAME column is ALSO genuinely
    filtered in a WHERE clause, not just used as the join key.
    """
    table = LargeTableSpec(
        table_name="MonitorMeasurements", quoted_ref='"Shared"."MonitorMeasurements"', selective_columns=["DeviceId"]
    )
    sql = (
        'SELECT * FROM "Monitors" m JOIN "MonitorMeasurements" mm ON mm."DeviceId" = m."Id" '
        'WHERE mm."DeviceId" = 42 LIMIT 1000'
    )
    verdict = cardinality_guard(sql, large_tables=[table], required_time_column_by_table={}, dialect="duckdb")
    assert verdict.ok is True
    assert verdict.action == "pass"
