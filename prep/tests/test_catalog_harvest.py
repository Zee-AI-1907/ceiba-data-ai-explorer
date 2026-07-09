"""test_catalog_harvest.py — P1 prep catalog harvest (metadata-only ground
truth from Postgres system catalogs into catalog.json).

Covers the PURE pieces hermetically (no live DB):
  - parse_check_in_list: authored `IN (...)` form, Postgres-normalized
    `= ANY (ARRAY[...])` form, and fail-open on everything else.
  - _month_of: month truncation + ±infinity sentinel detection.
  - build_catalog_and_keys fold: description/allowedValues/nullFraction/
    distinctCountEstimate per column, description/timeRange per table, and the
    PHI gating of allowedValues.
  - phi_gate: pg_stats numeric fields are allowlisted, value-bearing pg_stats
    fields are a violation anywhere, and check_catalog_json rejects
    allowedValues on a PHI-classified column.
"""

from __future__ import annotations

from pathlib import Path

from prep.cli import _distinct_count_estimate, build_catalog_and_keys
from prep.introspect.engine import (
    ColumnMeta,
    ColumnStatistics,
    KeyMeta,
    TableMeta,
    TimeColumnRange,
)
from prep.introspect.sqlalchemy_introspector import _month_of, parse_check_in_list
from prep.phi_gate import check_catalog_json, scan_file_for_raw_select

REPO_ROOT = Path(__file__).resolve().parents[2]


# ── parse_check_in_list ──────────────────────────────────────────────────────


def test_check_parser_authored_in_list():
    assert parse_check_in_list("status IN ('active', 'closed', 'archived')") == (
        "status",
        ("active", "closed", "archived"),
    )


def test_check_parser_postgres_normalized_any_array():
    sqltext = (
        "((status)::text = ANY ((ARRAY['active'::character varying, "
        "'closed'::character varying])::text[]))"
    )
    assert parse_check_in_list(sqltext) == ("status", ("active", "closed"))


def test_check_parser_fails_open_on_ranges_and_garbage():
    assert parse_check_in_list("value > 0 AND value < 300") is None
    assert parse_check_in_list("length(code) = 4") is None
    assert parse_check_in_list("not sql at all ((((") is None
    assert parse_check_in_list("") is None


def test_check_parser_caps_value_count():
    values = ", ".join(f"'v{i}'" for i in range(60))
    assert parse_check_in_list(f"col IN ({values})") is None  # >50 -> vocabulary, not enum


# ── _month_of ────────────────────────────────────────────────────────────────


def test_month_of_truncates_to_month():
    assert _month_of("2019-03-17 14:22:31.5+03") == ("2019-03", False)
    assert _month_of("2026-07-01") == ("2026-07", False)


def test_month_of_detects_infinity_sentinels():
    assert _month_of("infinity") == (None, True)
    assert _month_of("-infinity") == (None, True)
    assert _month_of(None) == (None, False)
    assert _month_of("not a date") == (None, False)


# ── catalog fold ─────────────────────────────────────────────────────────────


def _model_with(columns: list[ColumnMeta], **table_extra) -> dict:
    table = TableMeta(source_id="src", schema="public", name="Things", quoted_ref='"public"."Things"')
    entry = {
        "table": table,
        "columns": columns,
        "keys": KeyMeta(primary_key=["Id"], foreign_keys=[]),
        "indexes": [],
        "approx_row_count": 1000,
        **table_extra,
    }
    return {"source_id": "src", "schemas": [{"schema": "public", "tables": [entry]}]}


def _col(name: str, **kw) -> ColumnMeta:
    defaults = dict(
        name=name,
        quoted_name=f'"{name}"',
        data_type="integer",
        nullable=True,
        is_primary_key=False,
        ordinal_position=1,
        is_indexed=False,
    )
    defaults.update(kw)
    return ColumnMeta(**defaults)


def test_fold_carries_description_allowed_values_and_stats():
    model = _model_with(
        [
            _col(
                "Status",
                data_type="text",
                comment="Lifecycle state of the record",
                enum_values=("active", "closed"),
            )
        ],
        table_comment="One row per tracked thing",
        column_stats={"Status": ColumnStatistics(null_frac=0.25, n_distinct=2.0)},
    )
    catalog, _keys = build_catalog_and_keys([model], large_table_row_threshold=10_000_000)
    table = catalog["tables"][0]
    col = table["columns"][0]

    assert table["description"] == "One row per tracked thing"
    assert col["description"] == "Lifecycle state of the record"
    assert col["allowedValues"] == ["active", "closed"]
    assert col["nullFraction"] == 0.25
    assert col["distinctCountEstimate"] == 2


def test_fold_carries_time_range():
    model = _model_with(
        [_col("CreatedAt", data_type="timestamp with time zone")],
        time_range=TimeColumnRange(
            column="CreatedAt", min_month="2019-03", max_month="2026-07", uses_infinity_sentinels=True
        ),
    )
    catalog, _keys = build_catalog_and_keys([model], large_table_row_threshold=10_000_000)
    assert catalog["tables"][0]["timeRange"] == {
        "column": "CreatedAt",
        "minMonth": "2019-03",
        "maxMonth": "2026-07",
        "usesInfinitySentinels": True,
    }


def test_fold_suppresses_allowed_values_for_phi_classified_column():
    # "Name" classifies as PHI by name; its declared values must be suppressed
    # when phi_columns gating is active.
    model = _model_with(
        [_col("Name", data_type="text", enum_values=("alice", "bob"))],
    )
    from ceiba_nl2sql.compliance.phi import load_phi_columnset

    phi_columns = load_phi_columnset(REPO_ROOT).columns
    catalog, _keys = build_catalog_and_keys(
        [model], large_table_row_threshold=10_000_000, phi_columns=phi_columns
    )
    assert catalog["tables"][0]["columns"][0]["allowedValues"] is None


def test_distinct_count_estimate_normalizes_pg_semantics():
    assert _distinct_count_estimate(42.0, 1000) == 42  # absolute
    assert _distinct_count_estimate(-0.5, 1000) == 500  # ratio of rows
    assert _distinct_count_estimate(None, 1000) is None
    assert _distinct_count_estimate(-0.5, 0) is None  # unknown row count


# ── phi_gate interaction ─────────────────────────────────────────────────────


def test_gate_allows_pg_stats_numeric_query_in_introspector():
    introspector_path = REPO_ROOT / "prep" / "prep" / "introspect" / "sqlalchemy_introspector.py"
    violations = scan_file_for_raw_select(introspector_path)
    assert violations == [], [v.to_json() for v in violations]


def test_gate_flags_value_bearing_pg_stats_fields(tmp_path: Path):
    bad = tmp_path / "bad_module.py"
    bad.write_text(
        'QUERY = "SELECT attname, most_common_' 'vals FROM pg_stats WHERE tablename = :t"\n',
        encoding="utf-8",
    )
    violations = scan_file_for_raw_select(bad)
    assert any("value-bearing" in v.message for v in violations)


def test_check_catalog_json_rejects_allowed_values_on_phi_column():
    phi_json = {"columns": [{"columnId": "src.public.T.Name", "phiClass": "direct-identifier"}]}
    catalog_json = {
        "tables": [
            {
                "tableId": "src.public.T",
                "columns": [{"columnId": "src.public.T.Name", "allowedValues": ["a", "b"]}],
            }
        ]
    }
    violations = check_catalog_json(phi_json, catalog_json)
    assert len(violations) == 1
    assert "allowedValues" in violations[0].message


def test_check_catalog_json_accepts_non_phi_allowed_values():
    phi_json = {"columns": [{"columnId": "src.public.T.Status", "phiClass": "non-phi"}]}
    catalog_json = {
        "tables": [
            {
                "tableId": "src.public.T",
                "columns": [{"columnId": "src.public.T.Status", "allowedValues": ["active"]}],
            }
        ]
    }
    assert check_catalog_json(phi_json, catalog_json) == []
