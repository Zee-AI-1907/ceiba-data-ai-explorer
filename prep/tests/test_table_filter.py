"""test_table_filter.py — table-level includeTables/excludeTables filtering.

Covers the table-scoping extension to the schema-level includeSchemas/
excludeSchemas filter (config.py `IntrospectConfig.include_tables/
exclude_tables`, cli.py `filter_tables` + `introspect_source`):

  * pure `filter_tables` helper: include-only, exclude-wins-over-include,
    glob matching ("Shared.Monitor*"), schema-qualified matching (a pattern
    for one schema must not leak into another), empty-include = all-except-
    excluded (the backward-compatible default).
  * config.py: includeTables/excludeTables parse from YAML into
    IntrospectConfig, defaulting to [] when absent (existing configs with no
    table filter behave exactly as before).
  * an integration-style test against the mock DB (localhost:55433, P1
    OrbStack container) proving `introspect_source`'s includeTables actually
    limits the introspected table set — skips cleanly if MOCK_DSN is unset or
    the mock DB is unreachable, per CI ground rule #4 (no test may require a
    live DB).
"""

from __future__ import annotations

import os
from pathlib import Path

import pytest
import sqlalchemy as sa

from prep.cli import filter_tables, introspect_source
from prep.config import _parse_introspect
from prep.introspect.sqlalchemy_introspector import SqlAlchemyIntrospector

REPO_ROOT = Path(__file__).resolve().parents[2]


# ── pure filter_tables helper ────────────────────────────────────────────────


def test_filter_tables_no_filters_returns_all() -> None:
    names = ["Shared.Patients", "Shared.MonitorMeasurements", "ICU.Beds"]
    assert filter_tables(names, [], []) == names


def test_filter_tables_include_only_keeps_matching() -> None:
    names = ["Shared.Patients", "Shared.MonitorMeasurements", "ICU.Beds"]
    result = filter_tables(names, ["Shared.Patients"], [])
    assert result == ["Shared.Patients"]


def test_filter_tables_include_only_multiple_patterns() -> None:
    names = ["Shared.Patients", "Shared.MonitorMeasurements", "ICU.Beds"]
    result = filter_tables(names, ["Shared.Patients", "ICU.Beds"], [])
    assert result == ["Shared.Patients", "ICU.Beds"]


def test_filter_tables_exclude_wins_over_include() -> None:
    """A table matching BOTH an include and an exclude pattern must be
    dropped — exclude takes precedence, same rule as includeSchemas/
    excludeSchemas.
    """
    names = ["Shared.Patients", "Shared.MonitorMeasurements"]
    result = filter_tables(
        names,
        include_tables=["Shared.*"],
        exclude_tables=["Shared.Patients"],
    )
    assert result == ["Shared.MonitorMeasurements"]


def test_filter_tables_exclude_only_drops_matching_backward_compatible() -> None:
    """Empty include_tables = 'all tables' (of the already schema-filtered
    set) minus whatever exclude_tables removes — this is the backward
    compatible default (no includeTables configured).
    """
    names = ["Shared.Patients", "Shared.MonitorMeasurements", "ICU.Beds"]
    result = filter_tables(names, [], ["ICU.Beds"])
    assert result == ["Shared.Patients", "Shared.MonitorMeasurements"]


def test_filter_tables_glob_pattern_matches_prefix() -> None:
    names = [
        "Shared.Patients",
        "Shared.MonitorMeasurements",
        "Shared.MonitorMeasurementTypes",
        "Shared.Monitors",
    ]
    result = filter_tables(names, ["Shared.Monitor*"], [])
    assert set(result) == {
        "Shared.MonitorMeasurements",
        "Shared.MonitorMeasurementTypes",
        "Shared.Monitors",
    }
    assert "Shared.Patients" not in result


def test_filter_tables_glob_pattern_is_case_sensitive() -> None:
    """PascalCase identifiers matter: a lowercase pattern must NOT match a
    PascalCase table name (fnmatch.fnmatchcase, not fnmatch.fnmatch).
    """
    names = ["Shared.Patients"]
    assert filter_tables(names, ["shared.patients"], []) == []


def test_filter_tables_schema_qualified_pattern_does_not_leak_across_schemas() -> None:
    """A pattern scoped to one schema (e.g. "Shared.*") must not accidentally
    match a same-named table in a DIFFERENT schema — proves matching is on
    the full schema-qualified string, not the bare table name.
    """
    names = ["Shared.Monitors", "ICU.Monitors"]
    result = filter_tables(names, ["Shared.Monitors"], [])
    assert result == ["Shared.Monitors"]
    assert "ICU.Monitors" not in result


def test_filter_tables_wildcard_schema_pattern_scopes_to_schema_only() -> None:
    names = ["ICU.Beds", "ICU.Monitors", "Shared.Patients"]
    result = filter_tables(names, ["ICU.*"], [])
    assert set(result) == {"ICU.Beds", "ICU.Monitors"}


def test_filter_tables_empty_input_returns_empty() -> None:
    assert filter_tables([], ["Shared.*"], []) == []


def test_filter_tables_include_pattern_matching_nothing_yields_empty() -> None:
    names = ["Shared.Patients", "Shared.MonitorMeasurements"]
    assert filter_tables(names, ["NoSuchSchema.NoSuchTable"], []) == []


# ── config.py: includeTables/excludeTables parsing ──────────────────────────


def test_parse_introspect_defaults_to_empty_table_filters() -> None:
    """No includeTables/excludeTables key at all — the pre-existing shape of
    prep.config.yaml's `mock` source — must parse to empty lists, i.e. the
    exact backward-compatible default.
    """
    cfg = _parse_introspect({"includeSchemas": ["public"], "excludeSchemas": []}, "sources[mock]")
    assert cfg.include_tables == []
    assert cfg.exclude_tables == []


def test_parse_introspect_reads_include_and_exclude_tables() -> None:
    raw = {
        "includeSchemas": ["Shared"],
        "excludeSchemas": [],
        "includeTables": ["Shared.Patients", "Shared.Monitor*"],
        "excludeTables": ["Shared.MonitorMeasurementTypes"],
    }
    cfg = _parse_introspect(raw, "sources[staging]")
    assert cfg.include_tables == ["Shared.Patients", "Shared.Monitor*"]
    assert cfg.exclude_tables == ["Shared.MonitorMeasurementTypes"]


def test_parse_introspect_none_raw_still_defaults_table_filters() -> None:
    cfg = _parse_introspect(None, "sources[x]")
    assert cfg.include_tables == []
    assert cfg.exclude_tables == []


# ── integration: introspect_source against the mock DB (optional) ──────────


def _mock_dsn() -> str | None:
    return os.environ.get("MOCK_DSN")


def _reachable(dsn: str) -> bool:
    try:
        engine = sa.create_engine(dsn, connect_args={"options": "-c default_transaction_read_only=on"})
        with engine.connect() as conn:
            conn.execute(sa.text("SELECT 1"))
        engine.dispose()
        return True
    except Exception:
        return False


@pytest.fixture(scope="module")
def mock_dsn() -> str:
    dsn = _mock_dsn()
    if not dsn or not _reachable(dsn):
        pytest.skip("MOCK_DSN not set or mock DB unreachable (P1 OrbStack container not required for this task)")
    return dsn


def test_introspect_source_include_tables_limits_result_set(mock_dsn: str) -> None:
    """Baseline: introspect the mock DB's `public` schema with NO table
    filter, note its full table set, then introspect again with
    includeTables scoped to a single table and confirm the model contains
    ONLY that table.
    """
    introspector = SqlAlchemyIntrospector(repo_root=str(REPO_ROOT))
    baseline_model = introspect_source(
        introspector, "mock", mock_dsn, ["public"], [],
    )
    introspector.dispose("mock")

    baseline_names = {
        t["table"].name
        for schema_entry in baseline_model["schemas"]
        for t in schema_entry["tables"]
    }
    assert len(baseline_names) > 1, "expected more than one table in the mock public schema"
    target_table = sorted(baseline_names)[0]

    introspector = SqlAlchemyIntrospector(repo_root=str(REPO_ROOT))
    filtered_model = introspect_source(
        introspector,
        "mock",
        mock_dsn,
        ["public"],
        [],
        include_tables=[f"public.{target_table}"],
        exclude_tables=[],
    )
    introspector.dispose("mock")

    filtered_names = {
        t["table"].name
        for schema_entry in filtered_model["schemas"]
        for t in schema_entry["tables"]
    }
    assert filtered_names == {target_table}


def test_introspect_source_no_table_filter_is_unchanged(mock_dsn: str) -> None:
    """Backward compatibility: calling introspect_source without
    include_tables/exclude_tables args at all (positional call, matching how
    older call sites invoked it) must introspect every table in the selected
    schema — proving the new parameters are additive, not a behavior change.
    """
    introspector = SqlAlchemyIntrospector(repo_root=str(REPO_ROOT))
    model_without_new_args = introspect_source(introspector, "mock", mock_dsn, ["public"], [])
    introspector.dispose("mock")

    introspector = SqlAlchemyIntrospector(repo_root=str(REPO_ROOT))
    model_with_empty_table_filters = introspect_source(
        introspector, "mock", mock_dsn, ["public"], [], [], []
    )
    introspector.dispose("mock")

    names_a = {
        t["table"].name for s in model_without_new_args["schemas"] for t in s["tables"]
    }
    names_b = {
        t["table"].name for s in model_with_empty_table_filters["schemas"] for t in s["tables"]
    }
    assert names_a == names_b
    assert len(names_a) > 0
