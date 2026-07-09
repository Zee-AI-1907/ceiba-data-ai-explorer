"""duckdb_engine.py — default QueryEngine implementation (ports
lib/engine/DuckDbEngine.ts verbatim; docs/PYTHON_NL2SQL_SERVICE_PLAN.md §1.1,
§3.1 `engine/duckdb_engine.py`).

DuckDB-first federation: attaches Postgres (and, for hermetic tests, other
DuckDB catalogs) with `ATTACH ... READ_ONLY` and executes cross-catalog joins
natively. Loads the `postgres` extension (Postgres attach/scan) and the `vss`
extension (vector search — used by the retriever's bundle, not by this engine
directly, but loaded here so the runtime that owns the DuckDB instance has it
available, mirroring the TS engine's own init).

Mirrors the timeout/deadline posture of the TS engine: `execute()` enforces
both `opts.max_rows` (clamp + `truncated` flag) and `opts.deadline_ms`
(interrupt the connection when the budget elapses, via a background thread
+ `connection.interrupt()` — Python's duckdb binding exposes `interrupt()`
the same way the Node binding does).
"""

from __future__ import annotations

import threading
from typing import Iterable

import duckdb

from ceiba_nl2sql.engine.base import (
    AttachSpec,
    ColumnMeta,
    DescribeResult,
    EngineCapabilities,
    EngineColumn,
    EngineResult,
    ExecuteOptions,
    ForeignKeyMeta,
    PlanError,
    PlanOk,
    PlanOrError,
    SqlDialect,
    TableMeta,
)

# Catalogs that are part of the DuckDB runtime itself, never a real attached source.
_INTERNAL_CATALOGS = frozenset({"system", "temp"})


class NonReadOnlyAttachError(RuntimeError):
    """Thrown when an AttachSpec fails the hard read-only requirement
    (defense in depth). Mirrors lib/engine/DuckDbEngine.ts
    `NonReadOnlyAttachError`.
    """


class EngineDeadlineExceededError(RuntimeError):
    """Thrown when execute()'s wall-clock deadline elapses before the query
    finishes. Mirrors lib/engine/DuckDbEngine.ts `EngineDeadlineExceededError`.
    """


def _quote_ident(identifier: str) -> str:
    return '"' + identifier.replace('"', '""') + '"'


def _quote_literal(value: str) -> str:
    return "'" + value.replace("'", "''") + "'"


class DuckDbEngine:
    """Default (in-process) DuckDB implementation of QueryEngine. One
    instance owns one DuckDB database (`:memory:` by default) plus whatever
    sources are ATTACHed into it. Mirrors lib/engine/DuckDbEngine.ts
    `DuckDbEngine` line-for-line.
    """

    def __init__(self, *, local_path: str = ":memory:") -> None:
        self._local_path = local_path
        self._attached_aliases: set[str] = set()
        self._conn: duckdb.DuckDBPyConnection = duckdb.connect(local_path)
        # Extensions MUST be INSTALL/LOAD'd here, while external access is still
        # enabled — once `enable_external_access=false` is set (see _harden),
        # DuckDB refuses to load ANY external extension ("Loading external
        # extensions is disabled through configuration"). ATTACH of a
        # file/postgres source likewise requires external access, so both the
        # extension load AND every attach() happen BEFORE the runtime is sealed.
        self._conn.execute("INSTALL postgres")
        self._conn.execute("LOAD postgres")
        self._conn.execute("INSTALL vss")
        self._conn.execute("LOAD vss")
        self._lock = threading.Lock()
        # Whether the read-path lockdown has been applied. External access
        # (arbitrary filesystem/HTTP table functions such as read_csv/
        # read_parquet('http://...')) stays enabled through construction +
        # attach, then is disabled+locked lazily the first time user SQL is run
        # (execute/explain). See _harden().
        self._hardened = False

    # ── lifecycle ────────────────────────────────────────────────────────────

    def attach(self, specs: Iterable[AttachSpec]) -> None:
        for spec in specs:
            if spec.read_only is not True:
                raise NonReadOnlyAttachError(
                    f'attach(): spec for sourceId="{spec.source_id}" (alias="{spec.alias}") is missing '
                    "read_only=True. A read-write attach is forbidden (NL2SQL_SPEC.md §3.1)."
                )
            if spec.alias in self._attached_aliases:
                continue  # idempotent per spec.attach() contract

            dsn_literal = _quote_literal(spec.dsn)
            alias = _quote_ident(spec.alias)
            type_clause = "TYPE postgres, " if spec.engine == "postgres" else ""
            self._conn.execute(f"ATTACH {dsn_literal} AS {alias} ({type_clause}READ_ONLY)")

            verify = self._conn.execute(
                f"SELECT readonly FROM duckdb_databases() WHERE database_name = {_quote_literal(spec.alias)}"
            ).fetchall()
            is_read_only = len(verify) > 0 and bool(verify[0][0])
            if not is_read_only:
                try:
                    self._conn.execute(f"DETACH {alias}")
                except Exception:
                    pass
                raise NonReadOnlyAttachError(
                    f'attach(): DuckDB did not report catalog "{spec.alias}" as READ_ONLY after ATTACH; '
                    "refusing to proceed with a potentially writable cross-source catalog."
                )

            self._attached_aliases.add(spec.alias)

    def dispose(self) -> None:
        self._conn.close()
        self._attached_aliases.clear()

    # ── external-access lockdown (defense in depth, security boundary) ────────

    def _harden(self) -> None:
        """Seal the DuckDB runtime against external filesystem/network access
        so that a "read-only SELECT" cannot exfiltrate secrets or SSRF via a
        table function like `read_csv('/proc/self/environ')` or
        `read_parquet('http://attacker/...')`.

        `enable_external_access=false` blocks ALL filesystem/HTTP table
        functions (read_csv/read_parquet/read_json/read_text/read_blob/glob/
        COPY ... TO a path, etc.) AND further ATTACHes; `lock_configuration=
        true` makes that irreversible for the life of the connection, so a
        later `SET enable_external_access=true` smuggled into a query cannot
        re-open the door. Both are one-way and idempotent-guarded by
        `self._hardened` because DuckDB errors on re-setting a locked option
        even to the same value.

        MUST run AFTER all extensions are loaded and all sources are ATTACHed
        (both need external access), which is why it is applied lazily on the
        first read rather than in the constructor. Reads from already-attached
        READ_ONLY catalogs continue to work after the lockdown.
        """
        if self._hardened:
            return
        self._conn.execute("SET enable_external_access=false")
        self._conn.execute("SET lock_configuration=true")
        self._hardened = True

    # ── runtime (read path) ───────────────────────────────────────────────────

    def execute(self, sql: str, opts: ExecuteOptions) -> EngineResult:
        # NOTE: `opts.catalog`/`opts.schema` are intentionally NOT applied as a
        # `USE` here — mirrors lib/engine/DuckDbEngine.ts `execute()`, which
        # also ignores them. `execute()` requires FULLY-QUALIFIED SQL
        # (`catalog.schema.table`); only `explain()` applies `USE` (for the
        # generation-time dry-run, where an unqualified probe is convenient).
        # The two are deliberately asymmetric and kept at TS parity.
        max_rows = opts.max_rows if opts.max_rows and opts.max_rows > 0 else 1000
        deadline_ms = opts.deadline_ms if opts.deadline_ms and opts.deadline_ms > 0 else 55_000

        deadline_hit = threading.Event()
        timer = threading.Timer(deadline_ms / 1000.0, self._on_deadline, args=(deadline_hit,))
        timer.start()
        try:
            with self._lock:
                # Seal external filesystem/network access before running ANY
                # user SQL (defense in depth against read_csv/read_parquet
                # exfiltration/SSRF); idempotent after the first call.
                self._harden()
                # Ask for one more row than the cap so a single extra row
                # proves more data existed beyond max_rows, mirroring the TS
                # engine's `runAndReadUntil(sql, maxRows + 1)`.
                cursor = self._conn.execute(sql)
                desc = cursor.description or []
                col_names = [d[0] for d in desc]
                engine_columns = [EngineColumn(name=d[0], type=str(d[1])) for d in desc]
                all_rows = cursor.fetchmany(max_rows + 1)
        except Exception:
            if deadline_hit.is_set():
                raise EngineDeadlineExceededError(f"execute(): exceeded deadlineMs budget of {deadline_ms}ms")
            raise
        finally:
            timer.cancel()

        if deadline_hit.is_set():
            raise EngineDeadlineExceededError(f"execute(): exceeded deadlineMs budget of {deadline_ms}ms")

        truncated = len(all_rows) > max_rows
        limited_rows = all_rows[:max_rows] if truncated else all_rows
        row_dicts = [dict(zip(col_names, row)) for row in limited_rows]

        return EngineResult(columns=engine_columns, rows=row_dicts, row_count=len(row_dicts), truncated=truncated)

    def _on_deadline(self, deadline_hit: threading.Event) -> None:
        deadline_hit.set()
        try:
            self._conn.interrupt()
        except Exception:
            pass

    def explain(self, sql: str, *, catalog: str | None = None, schema: str | None = None) -> PlanOrError:
        try:
            with self._lock:
                self._harden()
                if catalog:
                    use_clause = _quote_ident(catalog)
                    if schema:
                        use_clause += f".{_quote_ident(schema)}"
                    self._conn.execute(f"USE {use_clause}")
                rows = self._conn.execute(f"EXPLAIN {sql}").fetchall()
            # EXPLAIN never returns data rows to the caller — only the
            # textual plan, concatenated from every returned column value.
            plan = "\n".join("\n".join(str(v) for v in row) for row in rows)
            return PlanOk(ok=True, plan=plan)
        except Exception as exc:  # noqa: BLE001 - mirrors TS catch(err) -> {ok:false,error}
            return PlanError(ok=False, error=str(exc))

    def dialect(self) -> SqlDialect:
        return "duckdb"

    def capabilities(self) -> EngineCapabilities:
        return EngineCapabilities(
            supports_cross_catalog_join=True,
            identifier_quote='"',
            interval_syntax="ansi",
            supports_explain=True,
        )

    # ── introspection path (DB-agnostic) ──────────────────────────────────────

    def list_catalogs(self) -> list[str]:
        rows = self._conn.execute(
            "SELECT database_name FROM duckdb_databases() WHERE internal = false ORDER BY database_name"
        ).fetchall()
        return [r[0] for r in rows if r[0] not in _INTERNAL_CATALOGS]

    def list_schemas(self, catalog: str) -> list[str]:
        rows = self._conn.execute(
            f"SELECT DISTINCT schema_name FROM information_schema.schemata "
            f"WHERE catalog_name = {_quote_literal(catalog)} ORDER BY schema_name"
        ).fetchall()
        return [r[0] for r in rows]

    def list_tables(self, catalog: str, schema: str) -> list[TableMeta]:
        rows = self._conn.execute(
            f"SELECT table_name FROM information_schema.tables "
            f"WHERE table_catalog = {_quote_literal(catalog)} AND table_schema = {_quote_literal(schema)} "
            f"ORDER BY table_name"
        ).fetchall()
        return [
            TableMeta(
                source_id=catalog,
                schema=schema,
                name=r[0],
                quoted_ref=f"{_quote_ident(catalog)}.{_quote_ident(schema)}.{_quote_ident(r[0])}",
            )
            for r in rows
        ]

    def describe_table(self, ref: TableMeta) -> DescribeResult:
        col_rows = self._conn.execute(
            "SELECT column_name, data_type, is_nullable FROM information_schema.columns "
            f"WHERE table_catalog = {_quote_literal(ref.source_id)} AND table_schema = {_quote_literal(ref.schema)} "
            f"AND table_name = {_quote_literal(ref.name)} ORDER BY ordinal_position"
        ).fetchall()

        pk_rows = self._conn.execute(
            "SELECT constraint_column_names FROM duckdb_constraints() "
            f"WHERE database_name = {_quote_literal(ref.source_id)} AND schema_name = {_quote_literal(ref.schema)} "
            f"AND table_name = {_quote_literal(ref.name)} AND constraint_type = 'PRIMARY KEY'"
        ).fetchall()
        primary_key: list[str] = list(pk_rows[0][0]) if pk_rows and pk_rows[0][0] else []
        primary_key_set = set(primary_key)

        fk_rows = self._conn.execute(
            "SELECT constraint_column_names, referenced_table, referenced_column_names FROM duckdb_constraints() "
            f"WHERE database_name = {_quote_literal(ref.source_id)} AND schema_name = {_quote_literal(ref.schema)} "
            f"AND table_name = {_quote_literal(ref.name)} AND constraint_type = 'FOREIGN KEY'"
        ).fetchall()
        foreign_keys = [
            ForeignKeyMeta(
                from_columns=list(row[0]) if row[0] else [],
                to_table=str(row[1]) if row[1] else "",
                to_columns=list(row[2]) if row[2] else [],
            )
            for row in fk_rows
        ]

        idx_rows = self._conn.execute(
            "SELECT expressions FROM duckdb_indexes() "
            f"WHERE database_name = {_quote_literal(ref.source_id)} AND schema_name = {_quote_literal(ref.schema)} "
            f"AND table_name = {_quote_literal(ref.name)}"
        ).fetchall()
        indexed_columns: set[str] = set()
        import re

        for row in idx_rows:
            expr_text = str(row[0] or "")
            for match in re.finditer(r"[A-Za-z_][A-Za-z0-9_]*", expr_text):
                indexed_columns.add(match.group(0))

        columns = [
            ColumnMeta(
                name=row[0],
                quoted_name=_quote_ident(row[0]),
                data_type=row[1],
                nullable=row[2] == "YES",
                is_primary_key=row[0] in primary_key_set,
                is_indexed=row[0] in indexed_columns or row[0] in primary_key_set,
            )
            for row in col_rows
        ]

        return DescribeResult(columns=columns, primary_key=primary_key, foreign_keys=foreign_keys)
