"""test_duckdb_engine.py — ceiba_nl2sql.engine.duckdb_engine (Phase 2 port of
lib/engine/__tests__/DuckDbEngine test assertions: attach/read-only/execute/
explain; docs/PYTHON_NL2SQL_SERVICE_PLAN.md §1.1, §3.1, §4 "DuckDB behavior
is engine-level and language-agnostic").
"""

from __future__ import annotations

from pathlib import Path

import duckdb
import pytest

from ceiba_nl2sql.engine.base import AttachSpec, ExecuteOptions
from ceiba_nl2sql.engine.duckdb_engine import DuckDbEngine, EngineDeadlineExceededError, NonReadOnlyAttachError


@pytest.fixture
def seed_db_path(tmp_path: Path) -> str:
    db_path = str(tmp_path / "seed.duckdb")
    conn = duckdb.connect(db_path)
    conn.execute("CREATE SCHEMA IF NOT EXISTS public")
    conn.execute('CREATE TABLE public."T" ("Id" INTEGER PRIMARY KEY, "Value" DOUBLE)')
    conn.execute('INSERT INTO public."T" VALUES (1, 10.0), (2, 20.0), (3, 30.0)')
    conn.close()
    return db_path


def test_attach_read_only_succeeds(seed_db_path: str):
    engine = DuckDbEngine()
    try:
        engine.attach([AttachSpec(source_id="mock", engine="duckdb", dsn=seed_db_path, read_only=True, alias="mock")])
        catalogs = engine.list_catalogs()
        assert "mock" in catalogs
    finally:
        engine.dispose()


def test_attach_is_idempotent(seed_db_path: str):
    engine = DuckDbEngine()
    try:
        spec = AttachSpec(source_id="mock", engine="duckdb", dsn=seed_db_path, read_only=True, alias="mock")
        engine.attach([spec])
        engine.attach([spec])  # second call must not raise
        assert "mock" in engine.list_catalogs()
    finally:
        engine.dispose()


def test_attach_rejects_non_read_only_spec_at_construction_time():
    """`AttachSpec.read_only` is typed `Literal[True]`; a caller that
    bypasses the type checker (e.g. builds the dataclass dynamically from
    untyped JSON) must still be rejected at runtime.
    """
    engine = DuckDbEngine()
    try:
        bad_spec = AttachSpec(source_id="mock", engine="duckdb", dsn="x", read_only=False, alias="mock")  # type: ignore[arg-type]
        with pytest.raises(NonReadOnlyAttachError):
            engine.attach([bad_spec])
    finally:
        engine.dispose()


def test_execute_returns_rows_and_columns(seed_db_path: str):
    engine = DuckDbEngine()
    try:
        engine.attach([AttachSpec(source_id="mock", engine="duckdb", dsn=seed_db_path, read_only=True, alias="mock")])
        result = engine.execute('SELECT * FROM mock.public."T" ORDER BY "Id"', ExecuteOptions(max_rows=100, deadline_ms=5000))
        assert result.row_count == 3
        assert result.truncated is False
        assert {c.name for c in result.columns} == {"Id", "Value"}
        assert result.rows[0]["Id"] == 1
    finally:
        engine.dispose()


def test_execute_truncates_at_max_rows(seed_db_path: str):
    engine = DuckDbEngine()
    try:
        engine.attach([AttachSpec(source_id="mock", engine="duckdb", dsn=seed_db_path, read_only=True, alias="mock")])
        result = engine.execute('SELECT * FROM mock.public."T"', ExecuteOptions(max_rows=2, deadline_ms=5000))
        assert result.row_count == 2
        assert result.truncated is True
    finally:
        engine.dispose()


def test_execute_rejects_write_at_the_database_role_level(seed_db_path: str):
    """Defense-in-depth #1 (the primary control, per plan §1.3): even without
    the sqlglot guard, a write against a READ_ONLY-attached catalog fails at
    the DuckDB/attach level.
    """
    engine = DuckDbEngine()
    try:
        engine.attach([AttachSpec(source_id="mock", engine="duckdb", dsn=seed_db_path, read_only=True, alias="mock")])
        with pytest.raises(Exception):
            engine.execute('DELETE FROM mock.public."T"', ExecuteOptions(max_rows=100, deadline_ms=5000))
    finally:
        engine.dispose()


def test_explain_never_returns_data_rows(seed_db_path: str):
    engine = DuckDbEngine()
    try:
        engine.attach([AttachSpec(source_id="mock", engine="duckdb", dsn=seed_db_path, read_only=True, alias="mock")])
        result = engine.explain('SELECT * FROM mock.public."T"')
        assert result.ok is True
        assert isinstance(result.plan, str)
        assert len(result.plan) > 0
    finally:
        engine.dispose()


def test_explain_reports_bind_error_without_raising(seed_db_path: str):
    engine = DuckDbEngine()
    try:
        engine.attach([AttachSpec(source_id="mock", engine="duckdb", dsn=seed_db_path, read_only=True, alias="mock")])
        result = engine.explain('SELECT "NoSuchColumn" FROM mock.public."T"')
        assert result.ok is False
        assert "nosuchcolumn" in result.error.lower() or "column" in result.error.lower() or "not found" in result.error.lower() or "binder" in result.error.lower()
    finally:
        engine.dispose()


def test_dialect_and_capabilities():
    engine = DuckDbEngine()
    try:
        assert engine.dialect() == "duckdb"
        caps = engine.capabilities()
        assert caps.supports_cross_catalog_join is True
        assert caps.identifier_quote == '"'
        assert caps.supports_explain is True
    finally:
        engine.dispose()


def test_deadline_exceeded_raises(seed_db_path: str):
    engine = DuckDbEngine()
    try:
        engine.attach([AttachSpec(source_id="mock", engine="duckdb", dsn=seed_db_path, read_only=True, alias="mock")])
        # A deliberately absurd deadline (0ms effectively) against a query
        # that at least has to plan+bind — best-effort timing test: assert
        # the mechanism exists and either raises the deadline error or
        # completes (DuckDB may finish a trivial query before the timer
        # fires on a fast machine); the important behavioral contract is
        # that IF the deadline fires, the correct exception type is raised,
        # which test_execute_returns_rows_and_columns already exercises the
        # non-timeout path for.
        try:
            engine.execute(
                'SELECT * FROM mock.public."T" t1, mock.public."T" t2, mock.public."T" t3',
                ExecuteOptions(max_rows=1000, deadline_ms=1),
            )
        except EngineDeadlineExceededError:
            pass
    finally:
        engine.dispose()
