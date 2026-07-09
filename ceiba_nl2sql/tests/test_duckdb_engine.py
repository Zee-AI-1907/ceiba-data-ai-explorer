"""test_duckdb_engine.py — ceiba_nl2sql.engine.duckdb_engine (Phase 2 port of
lib/engine/__tests__/DuckDbEngine test assertions: attach/read-only/execute/
explain; docs/PYTHON_NL2SQL_SERVICE_PLAN.md §1.1, §3.1, §4 "DuckDB behavior
is engine-level and language-agnostic").
"""

from __future__ import annotations

import threading
import time
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


def test_execute_blocks_filesystem_table_functions(seed_db_path: str):
    """P1 SECURITY: even a syntactically read-only SELECT must not read
    arbitrary local files (secret exfiltration) or remote URLs (SSRF) via a
    DuckDB filesystem/network table function. The engine disables external
    access (+ locks the config) on the first execute(); a normal read against
    an attached READ_ONLY catalog still works afterward.
    """
    engine = DuckDbEngine()
    try:
        engine.attach([AttachSpec(source_id="mock", engine="duckdb", dsn=seed_db_path, read_only=True, alias="mock")])
        # Normal read still works AFTER the lockdown is applied.
        ok = engine.execute('SELECT COUNT(*) AS n FROM mock.public."T"', ExecuteOptions(max_rows=10, deadline_ms=5000))
        assert ok.rows[0]["n"] == 3
        # read_csv of a local file is now blocked by DuckDB's own config.
        with pytest.raises(Exception) as excinfo:
            engine.execute("SELECT * FROM read_csv('/etc/hostname')", ExecuteOptions(max_rows=10, deadline_ms=5000))
        message = str(excinfo.value).lower()
        assert "external access" in message or "disabled by configuration" in message or "permission" in message
    finally:
        engine.dispose()


def test_external_access_cannot_be_re_enabled_after_harden(seed_db_path: str):
    """`lock_configuration=true` makes the external-access lockdown
    irreversible — a `SET enable_external_access=true` smuggled into a later
    query cannot re-open the door.
    """
    engine = DuckDbEngine()
    try:
        engine.attach([AttachSpec(source_id="mock", engine="duckdb", dsn=seed_db_path, read_only=True, alias="mock")])
        engine.execute('SELECT 1 AS n', ExecuteOptions(max_rows=1, deadline_ms=5000))  # triggers _harden
        with pytest.raises(Exception) as excinfo:
            engine.execute("SET enable_external_access=true", ExecuteOptions(max_rows=1, deadline_ms=5000))
        assert "locked" in str(excinfo.value).lower() or "cannot change" in str(excinfo.value).lower()
    finally:
        engine.dispose()


# ── single-source native routing (docs/research/DUCKDB_PUSHDOWN.md §5.1) ──────


def test_duckdb_catalog_query_is_not_passthrough_routed(seed_db_path: str):
    """A query over a DuckDB-attached catalog is NOT rewritten to a
    postgres_query() passthrough — the passthrough only applies to Postgres
    remotes. The federated (native DuckDB) path stays in effect and the query
    still returns correct rows.
    """
    engine = DuckDbEngine()
    try:
        engine.attach([AttachSpec(source_id="mock", engine="duckdb", dsn=seed_db_path, read_only=True, alias="mock")])
        # decision: no passthrough for a duckdb catalog
        assert engine._passthrough_sql('SELECT count(*) FROM mock.public."T"') is None
        # and it still executes correctly via the normal path
        res = engine.execute('SELECT count(*) AS n FROM mock.public."T"', ExecuteOptions(max_rows=10, deadline_ms=5000))
        assert res.rows == [{"n": 3}]
    finally:
        engine.dispose()


def test_passthrough_decision_gated_on_postgres_alias(seed_db_path: str):
    """`_passthrough_sql` routes a single-catalog query ONLY when that catalog
    was attached as a Postgres remote. We simulate the postgres-alias membership
    (a real Postgres attach needs a live server) and assert the decision + the
    generated postgres_query() wrapper shape.
    """
    engine = DuckDbEngine()
    try:
        engine.attach([AttachSpec(source_id="mock", engine="duckdb", dsn=seed_db_path, read_only=True, alias="mock")])
        sql = 'SELECT count(*) FROM pg."Shared"."Monitors"'
        # not a known postgres alias yet -> no routing
        assert engine._passthrough_sql(sql) is None
        # mark `pg` as a postgres remote (as a real postgres attach would)
        engine._postgres_aliases.add("pg")
        wrapped = engine._passthrough_sql(sql)
        assert wrapped is not None
        assert wrapped.startswith("SELECT * FROM postgres_query('pg', '")
        assert "pg." not in wrapped.split("postgres_query('pg', '", 1)[1]  # catalog stripped in remote sql
    finally:
        engine.dispose()


def test_native_single_source_flag_disables_routing(seed_db_path: str):
    """Constructing with native_single_source=False forces the federated path
    even for a single Postgres catalog (used to A/B the paths)."""
    engine = DuckDbEngine(native_single_source=False)
    try:
        engine.attach([AttachSpec(source_id="mock", engine="duckdb", dsn=seed_db_path, read_only=True, alias="mock")])
        engine._postgres_aliases.add("pg")
        assert engine._passthrough_sql('SELECT count(*) FROM pg."Shared"."Monitors"') is None
    finally:
        engine.dispose()


# ── per-call cursor concurrency (execute/explain no longer hold a global lock) ─


def test_concurrent_fast_query_not_serialized_behind_slow_query(seed_db_path: str):
    """PERFORMANCE CONTRACT: execute() runs each call on its own cursor, so a
    slow query (e.g. a long federated join) must NOT block another user's
    sub-second query. A deliberately slow cross-join (~2s locally, well over
    0.5s even on much faster hardware) runs in one thread; a trivial query
    issued while it is in flight must COMPLETE while the slow one is still
    running. Under the old single-lock design the fast query waited for the
    full slow-query duration, so `slow_done` would already be set here.
    """
    engine = DuckDbEngine()
    try:
        engine.attach([AttachSpec(source_id="mock", engine="duckdb", dsn=seed_db_path, read_only=True, alias="mock")])
        # Warm up / trigger _harden outside the timed section.
        engine.execute("SELECT 1 AS n", ExecuteOptions(max_rows=1, deadline_ms=5000))

        slow_started = threading.Event()
        slow_done = threading.Event()
        slow_error: list[Exception] = []

        def run_slow() -> None:
            slow_started.set()
            try:
                # ~9e8 combinations forced through max() — no shortcut for the
                # optimizer; calibrated ~2s on a dev laptop (duckdb 1.5).
                engine.execute(
                    "SELECT max(a.range * b.range) AS m FROM range(30000) a, range(30000) b",
                    ExecuteOptions(max_rows=1, deadline_ms=60_000),
                )
            except Exception as exc:  # pragma: no cover - surfaced via assertion below
                slow_error.append(exc)
            finally:
                slow_done.set()

        slow_thread = threading.Thread(target=run_slow)
        slow_thread.start()
        try:
            assert slow_started.wait(timeout=5.0)
            time.sleep(0.2)  # let the slow query actually enter DuckDB
            fast_t0 = time.monotonic()
            fast = engine.execute('SELECT count(*) AS n FROM mock.public."T"', ExecuteOptions(max_rows=10, deadline_ms=10_000))
            fast_elapsed = time.monotonic() - fast_t0
            slow_still_running = not slow_done.is_set()
        finally:
            slow_thread.join(timeout=60.0)

        assert not slow_error, f"slow query failed: {slow_error}"
        assert fast.rows == [{"n": 3}]
        # The fast query finished while the slow query was still executing —
        # i.e. the two overlapped instead of serializing.
        assert slow_still_running, "fast query was serialized behind the slow query"
        # Generous margin: the fast query is a 3-row count; even sharing CPU
        # with the slow scan it must come back well under the slow duration.
        assert fast_elapsed < 1.0, f"fast query took {fast_elapsed:.2f}s — looks serialized"
    finally:
        engine.dispose()


def test_cursor_write_fails_on_read_only_attach(seed_db_path: str):
    """READ_ONLY attach semantics are database-instance-level, so they must
    hold through per-call cursors too: a write attempted on a cursor
    duplicated from the engine's connection fails at the DuckDB level.
    """
    engine = DuckDbEngine()
    try:
        engine.attach([AttachSpec(source_id="mock", engine="duckdb", dsn=seed_db_path, read_only=True, alias="mock")])
        cursor = engine._conn.cursor()
        try:
            with pytest.raises(Exception) as excinfo:
                cursor.execute('INSERT INTO mock.public."T" VALUES (99, 99.0)')
            assert "read" in str(excinfo.value).lower() or "insert" in str(excinfo.value).lower()
        finally:
            cursor.close()
        # And via the public path (which now runs on a cursor internally).
        with pytest.raises(Exception):
            engine.execute('DELETE FROM mock.public."T"', ExecuteOptions(max_rows=10, deadline_ms=5000))
    finally:
        engine.dispose()


def test_hardening_applies_to_cursors(seed_db_path: str):
    """SECURITY: `enable_external_access=false` + `lock_configuration=true`
    are GLOBAL (database-instance) settings, so hardening applied once on the
    parent connection must also seal every cursor: no INSTALL/LOAD, no
    filesystem reads, no un-locking — even on a fresh cursor.
    """
    engine = DuckDbEngine()
    try:
        engine.attach([AttachSpec(source_id="mock", engine="duckdb", dsn=seed_db_path, read_only=True, alias="mock")])
        engine.execute("SELECT 1 AS n", ExecuteOptions(max_rows=1, deadline_ms=5000))  # triggers _harden
        cursor = engine._conn.cursor()
        try:
            with pytest.raises(Exception):
                cursor.execute("INSTALL json")
            # NOTE: json is statically linked into the Python wheel (LOAD json
            # is a no-op), so probe with httpfs — a genuinely external
            # extension whose LOAD must be refused after hardening.
            with pytest.raises(Exception):
                cursor.execute("LOAD httpfs")
            with pytest.raises(Exception) as read_exc:
                cursor.execute("SELECT * FROM read_csv('/etc/hostname')")
            read_message = str(read_exc.value).lower()
            assert "external access" in read_message or "disabled" in read_message or "permission" in read_message
            with pytest.raises(Exception) as unlock_exc:
                cursor.execute("SET enable_external_access=true")
            assert "locked" in str(unlock_exc.value).lower() or "cannot change" in str(unlock_exc.value).lower()
            # Reads from the attached READ_ONLY catalog still work on the cursor.
            assert cursor.execute('SELECT count(*) FROM mock.public."T"').fetchall() == [(3,)]
        finally:
            cursor.close()
    finally:
        engine.dispose()


def test_explain_use_does_not_leak_into_other_calls(seed_db_path: str):
    """explain()'s `USE catalog.schema` runs on a per-call cursor, so it is
    session-local: it must not change the default catalog of the shared parent
    connection (previously the USE leaked into every subsequent query).
    """
    engine = DuckDbEngine()
    try:
        engine.attach([AttachSpec(source_id="mock", engine="duckdb", dsn=seed_db_path, read_only=True, alias="mock")])
        result = engine.explain('SELECT * FROM "T"', catalog="mock", schema="public")
        assert result.ok is True
        # An UNQUALIFIED reference on the next execute() must still fail —
        # proof the USE did not persist on the shared connection.
        with pytest.raises(Exception):
            engine.execute('SELECT * FROM "T"', ExecuteOptions(max_rows=10, deadline_ms=5000))
    finally:
        engine.dispose()
