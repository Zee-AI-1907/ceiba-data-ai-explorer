"""duckdb_introspector.py — ATTACH READ_ONLY introspection + profiling route (SPEC §2.3).

Thinner alternative to `sqlalchemy_introspector.py`: attaches a Postgres source
into DuckDB via `ATTACH '<dsn>' AS <alias> (TYPE postgres, READ_ONLY)` and
introspects/profiles through DuckDB's Postgres scanner. This mirrors the TS
`DuckDbEngine` (SPEC §3.1) attach semantics so the Python prep tool and the TS
runtime agree on the same federation posture — DuckDB-first, `ATTACH
READ_ONLY` for cross-DB joins.

The SQLAlchemy route is primary for single-Postgres introspection (broadest
PK/FK/index coverage via `inspect()` — SPEC §2.3). This route exists for:
  (a) profiling/execution against an ATTACH'd catalog when a cross-source
      sample is needed, and
  (b) exercising the same attach path prep-side that the TS runtime uses
      at query time, catching attach/read-only regressions early.

Read-only is enforced by the DuckDB `ATTACH ... (READ_ONLY)` clause itself —
missing `READ_ONLY` is a hard error (never attach read-write).
"""

from __future__ import annotations

from dataclasses import dataclass

import duckdb

from ceiba_nl2sql.compliance.aggregate_profile import (
    AggregateProfile,
    ProfileColumn,
    sample_aggregate_from_rows,
)
from ceiba_nl2sql.compliance.phi import load_phi_columnset

from prep.introspect.engine import (
    ColumnMeta,
    ForeignKeyMeta,
    IndexMeta,
    KeyMeta,
    TableMeta,
)


class ReadOnlyAttachError(RuntimeError):
    """Raised if an attach is attempted without READ_ONLY — a hard error, never
    silently allowed (SPEC §3.1 "Missing READ_ONLY is a hard error").
    """


@dataclass
class _Attachment:
    alias: str
    dsn: str


class DuckDbIntrospector:
    """ATTACH READ_ONLY introspection route. One shared in-memory DuckDB
    connection with N attached Postgres catalogs (mirrors the TS
    `DuckDbEngine.attach()` topology — SPEC §3.2).
    """

    def __init__(self, repo_root: str) -> None:
        self._conn = duckdb.connect(database=":memory:")
        self._conn.execute("INSTALL postgres")
        self._conn.execute("LOAD postgres")
        self._attachments: dict[str, _Attachment] = {}
        self._phi_columns = load_phi_columnset(repo_root).columns

    # ── lifecycle ────────────────────────────────────────────────────────

    def connect_read_only(self, source_id: str, dsn: str) -> None:
        """ATTACH the Postgres DSN as `source_id`, READ_ONLY. A read-write
        attach is refused before any SQL is issued.
        """
        alias = source_id
        # DuckDB's postgres attach DSN is a libpq connection string; READ_ONLY
        # is a literal, non-negotiable clause — never conditionally omitted.
        self._conn.execute(f"ATTACH '{dsn}' AS {alias} (TYPE postgres, READ_ONLY)")
        self._attachments[source_id] = _Attachment(alias=alias, dsn=dsn)

    def dispose(self) -> None:
        for attachment in list(self._attachments.values()):
            try:
                self._conn.execute(f"DETACH {attachment.alias}")
            except duckdb.Error:
                pass
        self._attachments.clear()
        self._conn.close()

    def _require_attached(self, source_id: str) -> _Attachment:
        if source_id not in self._attachments:
            raise RuntimeError(f"source {source_id!r} is not attached — call connect_read_only first")
        return self._attachments[source_id]

    # ── metadata-only introspection (via duckdb's postgres_scanner catalog) ─

    def list_schemas(self, source_id: str) -> list[str]:
        attachment = self._require_attached(source_id)
        rows = self._conn.execute(
            "SELECT DISTINCT schema_name FROM information_schema.schemata "
            "WHERE catalog_name = ?",
            [attachment.alias],
        ).fetchall()
        return [r[0] for r in rows]

    def list_tables(self, source_id: str, schema: str) -> list[TableMeta]:
        attachment = self._require_attached(source_id)
        rows = self._conn.execute(
            "SELECT table_name FROM information_schema.tables "
            "WHERE table_catalog = ? AND table_schema = ? AND table_type = 'BASE TABLE'",
            [attachment.alias, schema],
        ).fetchall()
        tables: list[TableMeta] = []
        for (name,) in rows:
            quoted_ref = f'"{schema}"."{name}"'
            tables.append(TableMeta(source_id=source_id, schema=schema, name=name, quoted_ref=quoted_ref))
        return tables

    def describe_table(self, table: TableMeta) -> tuple[list[ColumnMeta], KeyMeta, list[IndexMeta]]:
        attachment = self._require_attached(table.source_id)
        rows = self._conn.execute(
            "SELECT column_name, data_type, is_nullable, ordinal_position "
            "FROM information_schema.columns "
            "WHERE table_catalog = ? AND table_schema = ? AND table_name = ? "
            "ORDER BY ordinal_position",
            [attachment.alias, table.schema, table.name],
        ).fetchall()

        pk_rows = self._conn.execute(
            "SELECT kcu.column_name "
            "FROM information_schema.table_constraints tc "
            "JOIN information_schema.key_column_usage kcu "
            "  ON tc.constraint_name = kcu.constraint_name AND tc.table_schema = kcu.table_schema "
            "WHERE tc.table_catalog = ? AND tc.table_schema = ? AND tc.table_name = ? "
            "  AND tc.constraint_type = 'PRIMARY KEY'",
            [attachment.alias, table.schema, table.name],
        ).fetchall()
        pk_columns = {r[0] for r in pk_rows}

        columns: list[ColumnMeta] = []
        for name, data_type, is_nullable, ordinal_position in rows:
            columns.append(
                ColumnMeta(
                    name=name,
                    quoted_name=f'"{name}"',
                    data_type=str(data_type),
                    nullable=(str(is_nullable).upper() == "YES"),
                    is_primary_key=name in pk_columns,
                    ordinal_position=int(ordinal_position),
                    is_indexed=name in pk_columns,  # index detail limited via this scanner path
                )
            )

        key_meta = KeyMeta(primary_key=sorted(pk_columns), foreign_keys=[])
        return columns, key_meta, []

    def approx_row_count(self, table: TableMeta) -> int:
        """pg_class.reltuples via the attached catalog — never COUNT(*).

        DuckDB's postgres_scanner does not universally expose `pg_class`
        identically across versions, so this falls back to DuckDB's own
        `duckdb_tables()` estimated-size pragma when available, else returns 0
        (unknown) — it never issues a `COUNT(*)`.
        """
        attachment = self._require_attached(table.source_id)
        try:
            result = self._conn.execute(
                f"SELECT estimated_size FROM duckdb_tables() "  # noqa: S608
                f"WHERE database_name = ? AND schema_name = ? AND table_name = ?",
                [attachment.alias, table.schema, table.name],
            ).fetchone()
            if result and result[0] is not None:
                return max(0, int(result[0]))
        except duckdb.Error:
            pass
        return 0

    # ── the ONLY data-touching method ───────────────────────────────────

    def sample_aggregate(
        self, table: TableMeta, columns: list[ColumnMeta], sample_rows: int
    ) -> AggregateProfile:
        """Bounded LIMIT sample through the attached catalog -> AggregateProfile.

        Like the SQLAlchemy route's `sample_aggregate`, this always applies
        `LIMIT` and is the only data-touching method on this class.
        """
        attachment = self._require_attached(table.source_id)
        select_cols = ", ".join(f'"{c.name}"' for c in columns)
        query = (
            f'SELECT {select_cols} FROM {attachment.alias}."{table.schema}"."{table.name}" '  # noqa: S608
            f"LIMIT {int(sample_rows)}"
        )
        result = self._conn.execute(query)
        column_names = [d[0] for d in result.description]
        rows = [dict(zip(column_names, r, strict=True)) for r in result.fetchall()]

        profile_columns = [ProfileColumn(key=c.name, label=c.name, type=c.data_type) for c in columns]
        return sample_aggregate_from_rows(
            rows=rows,
            columns=profile_columns,
            phi_columns=self._phi_columns,
            max_sample_rows=sample_rows,
        )
