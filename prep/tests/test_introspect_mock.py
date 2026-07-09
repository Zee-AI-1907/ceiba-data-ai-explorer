"""test_introspect_mock.py — Introspector against a real Postgres source.

SPEC §2.3 requires the SQLAlchemy route to work against the REAL staging
database's `Shared` schema (942 tables incl. views; 667 base tables — see
docs/DATA_SOURCES.md) as well as the OrbStack mock DB (P1, port 55433) when
reachable. Per CI ground rule #4 (docs/NL2SQL_PLAN.md §0), no test may REQUIRE
the SSH tunnel — every test here skips cleanly when its target DSN env var is
unset or the target is unreachable, so `pytest` is green with or without the
tunnel up.

These tests connect read-only (PGOPTIONS default_transaction_read_only=on +
SET SESSION CHARACTERISTICS AS TRANSACTION READ ONLY) and only ever call
introspection methods that read information_schema/pg_catalog, EXCEPT the
dedicated `sample_aggregate` test, which exercises the one legitimate
data-touching path and asserts its output shape never contains a raw PHI
value.
"""

from __future__ import annotations

import os

import pytest
import sqlalchemy as sa

from prep.introspect.sqlalchemy_introspector import SqlAlchemyIntrospector

REPO_ROOT_MARKER = "STAGING_DSN"


def _staging_dsn() -> str | None:
    return os.environ.get("STAGING_DSN")


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
def repo_root() -> str:
    from pathlib import Path

    return str(Path(__file__).resolve().parents[2])


@pytest.fixture(scope="module")
def staging_introspector(repo_root):
    dsn = _staging_dsn()
    if not dsn or not _reachable(dsn):
        pytest.skip("STAGING_DSN not set or staging unreachable (tunnel not required for CI)")
    introspector = SqlAlchemyIntrospector(repo_root=repo_root)
    introspector.connect_read_only("staging", dsn)
    yield introspector
    introspector.dispose("staging")


@pytest.fixture(scope="module")
def mock_introspector(repo_root):
    dsn = _mock_dsn()
    if not dsn or not _reachable(dsn):
        pytest.skip("MOCK_DSN not set or mock DB unreachable (P1 OrbStack container not required for this task)")
    introspector = SqlAlchemyIntrospector(repo_root=repo_root)
    introspector.connect_read_only("mock", dsn)
    yield introspector
    introspector.dispose("mock")


# ── read-only enforcement ────────────────────────────────────────────────────


def test_staging_connection_is_read_only(staging_introspector):
    """A write must be rejected by the server-enforced read-only transaction
    (DATA_SOURCES.md: verified `CREATE TEMP TABLE` -> read-only transaction
    error). This proves layer 1 of the read-only enforcement actually works,
    not just that we intended it to.
    """
    engine = staging_introspector._conn("staging").engine
    with pytest.raises(Exception) as exc_info:
        with engine.connect() as conn:
            conn.execute(sa.text("CREATE TEMP TABLE _prep_ro_probe (id int)"))
    assert "read-only" in str(exc_info.value).lower()


# ── schema/table/column introspection against real Shared schema ───────────


def test_list_schemas_includes_shared(staging_introspector):
    schemas = staging_introspector.list_schemas("staging")
    assert "Shared" in schemas


def test_list_tables_shared_matches_known_scale(staging_introspector):
    tables = staging_introspector.list_tables("staging", "Shared")
    # DATA_SOURCES.md: Shared has 942 relations total (667 base tables + 275
    # views); SQLAlchemy's get_table_names() returns base tables only.
    assert len(tables) > 600
    names = {t.name for t in tables}
    assert "Patients" in names
    assert "MonitorMeasurements" in names

    patients = next(t for t in tables if t.name == "Patients")
    assert patients.quoted_ref == '"Shared"."Patients"'
    assert patients.source_id == "staging"


def test_describe_patients_table_finds_phi_columns_and_pk(staging_introspector):
    tables = staging_introspector.list_tables("staging", "Shared")
    patients = next(t for t in tables if t.name == "Patients")

    columns, key_meta, indexes = staging_introspector.describe_table(patients)
    column_names = {c.name for c in columns}

    # Real staging schema shape per docs/DATA_SOURCES.md.
    for expected in ("IdentificationNumber", "Name", "LastName", "Address", "BirthDate", "FatherName"):
        assert expected in column_names, f"expected column {expected} on Shared.Patients"

    assert "Id" in key_meta.primary_key
    id_col = next(c for c in columns if c.name == "Id")
    assert id_col.is_primary_key is True


def test_describe_monitor_measurements_finds_foreign_keys_or_columns(staging_introspector):
    tables = staging_introspector.list_tables("staging", "Shared")
    monitor_measurements = next(t for t in tables if t.name == "MonitorMeasurements")

    columns, key_meta, indexes = staging_introspector.describe_table(monitor_measurements)
    assert len(columns) > 0
    # Whether or not this specific table declares FKs, describe_table must not
    # raise and must return a well-typed KeyMeta.
    assert isinstance(key_meta.foreign_keys, list)


def test_approx_row_count_uses_reltuples_not_count_star(staging_introspector):
    tables = staging_introspector.list_tables("staging", "Shared")
    monitor_measurements = next(t for t in tables if t.name == "MonitorMeasurements")

    approx = staging_introspector.approx_row_count(monitor_measurements)
    # docs/DATA_SOURCES.md: ~337M rows. A COUNT(*) on this table would be a
    # multi-minute sequential scan; pg_class.reltuples returns instantly.
    assert approx > 100_000_000


def test_foreign_keys_present_across_shared_schema(staging_introspector):
    tables = staging_introspector.list_tables("staging", "Shared")
    total_fks = 0
    # Sample a bounded subset of tables (not all 667) to keep the test fast;
    # this is metadata-only introspection, never a data scan.
    for table in tables[:50]:
        _, key_meta, _ = staging_introspector.describe_table(table)
        total_fks += len(key_meta.foreign_keys)
    assert total_fks > 0, "expected at least one FK across a 50-table sample of Shared"


# ── sample_aggregate: the one legitimate data-touching path ────────────────


def test_sample_aggregate_on_patients_suppresses_phi(staging_introspector):
    tables = staging_introspector.list_tables("staging", "Shared")
    patients = next(t for t in tables if t.name == "Patients")
    columns, _, _ = staging_introspector.describe_table(patients)

    name_col = next(c for c in columns if c.name == "Name")
    id_col = next(c for c in columns if c.name == "Id")

    profile = staging_introspector.sample_aggregate(patients, [name_col, id_col], sample_rows=50)

    name_aggregate = next(c for c in profile.columns if c.key == "Name")
    assert name_aggregate.kind == "phi-suppressed"
    assert name_aggregate.top_categories is None
    assert name_aggregate.min is None

    # Structural guarantee: serialize and confirm no raw name string leaks.
    serialized = str(name_aggregate.to_json())
    assert "value" not in name_aggregate.to_json()
    assert set(name_aggregate.to_json().keys()) == {
        "key",
        "label",
        "type",
        "kind",
        "nonNullCount",
        "distinctCount",
    }


def test_sample_aggregate_is_bounded_never_full_scan(staging_introspector):
    tables = staging_introspector.list_tables("staging", "Shared")
    monitor_measurements = next(t for t in tables if t.name == "MonitorMeasurements")
    columns, _, _ = staging_introspector.describe_table(monitor_measurements)

    profile = staging_introspector.sample_aggregate(monitor_measurements, columns[:3], sample_rows=200)
    # Even though the table has ~337M rows, sampled_rows must be bounded by
    # the requested sample size — never anywhere close to the full table.
    assert profile.sampled_rows <= 200


# ── mock DB (P1) — optional, skips cleanly if not reachable ─────────────────


def test_mock_db_list_tables_if_reachable(mock_introspector):
    schemas = mock_introspector.list_schemas("mock")
    assert isinstance(schemas, list)
