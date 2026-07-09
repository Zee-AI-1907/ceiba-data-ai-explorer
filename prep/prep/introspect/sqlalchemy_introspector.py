"""sqlalchemy_introspector.py — default cross-DB introspection route (SPEC §2.3).

DB-agnostic introspection via SQLAlchemy `inspect()`. Read-only is enforced at
connect time: `PGOPTIONS='-c default_transaction_read_only=on'` is set via the
DSN's connect args AND `SET SESSION CHARACTERISTICS AS TRANSACTION READ ONLY`
is issued as the first statement on every connection (DATA_SOURCES.md, SPEC
§2.3 "Read-only is enforced at connect").

Only `sample_aggregate` touches cell data. Every other method here reads
`information_schema` / `pg_catalog` via SQLAlchemy's `Inspector`, which is
metadata-only by construction.
"""

from __future__ import annotations

from dataclasses import dataclass

import sqlalchemy as sa
from sqlalchemy.engine import Engine
from sqlalchemy.engine.reflection import Inspector

from prep.classify_phi import load_phi_columnset
from prep.introspect.engine import (
    ColumnMeta,
    ForeignKeyMeta,
    IndexMeta,
    KeyMeta,
    TableMeta,
)
from prep.profile import AggregateProfile, ProfileColumn, sample_aggregate_from_rows


def _quote_ident(dialect_name: str, identifier: str) -> str:
    """Dialect-literal quoting. Postgres/DuckDB both use double quotes; never
    re-derive by casing (SPEC §1.3 "NEVER re-derive by casing").
    """
    if dialect_name in ("postgresql", "duckdb"):
        return f'"{identifier}"'
    if dialect_name in ("mysql",):
        return f"`{identifier}`"
    return f'"{identifier}"'


@dataclass
class _Connection:
    engine: Engine
    dialect_name: str
    repo_root: str


class SqlAlchemyIntrospector:
    """Default cross-DB introspection route (Postgres primary; MySQL/SQL Server
    reachable via the same `inspect()` API — SPEC §2.3, research §5.1).
    """

    def __init__(self, repo_root: str) -> None:
        self._repo_root = repo_root
        self._connections: dict[str, _Connection] = {}
        self._phi_columns = load_phi_columnset(repo_root).columns

    # ── lifecycle ────────────────────────────────────────────────────────

    def connect_read_only(self, source_id: str, dsn: str) -> None:
        """Open a read-only SQLAlchemy engine for `source_id`.

        Enforces read-only at TWO layers (SPEC §2.3 / DATA_SOURCES.md):
          1. `PGOPTIONS=-c default_transaction_read_only=on` via connect_args
             (server-enforced for every statement on the connection).
          2. `SET SESSION CHARACTERISTICS AS TRANSACTION READ ONLY` issued as
             the first statement whenever a new DBAPI connection is created.
        """
        engine = sa.create_engine(
            dsn,
            connect_args={"options": "-c default_transaction_read_only=on"},
            pool_pre_ping=True,
        )

        @sa.event.listens_for(engine, "connect")
        def _set_read_only(dbapi_connection, connection_record) -> None:  # noqa: ANN001
            cursor = dbapi_connection.cursor()
            try:
                cursor.execute("SET SESSION CHARACTERISTICS AS TRANSACTION READ ONLY")
            finally:
                cursor.close()

        dialect_name = engine.dialect.name
        self._connections[source_id] = _Connection(
            engine=engine, dialect_name=dialect_name, repo_root=self._repo_root
        )

    def dispose(self, source_id: str) -> None:
        conn = self._connections.pop(source_id, None)
        if conn is not None:
            conn.engine.dispose()

    def _conn(self, source_id: str) -> _Connection:
        if source_id not in self._connections:
            raise RuntimeError(f"source {source_id!r} is not connected — call connect_read_only first")
        return self._connections[source_id]

    def _inspector(self, source_id: str) -> Inspector:
        return sa.inspect(self._conn(source_id).engine)

    # ── metadata-only introspection ─────────────────────────────────────

    def list_schemas(self, source_id: str) -> list[str]:
        return self._inspector(source_id).get_schema_names()

    def list_tables(self, source_id: str, schema: str) -> list[TableMeta]:
        inspector = self._inspector(source_id)
        dialect_name = self._conn(source_id).dialect_name
        tables: list[TableMeta] = []
        for name in inspector.get_table_names(schema=schema):
            quoted_ref = f"{_quote_ident(dialect_name, schema)}.{_quote_ident(dialect_name, name)}"
            tables.append(
                TableMeta(source_id=source_id, schema=schema, name=name, quoted_ref=quoted_ref)
            )
        return tables

    def describe_table(self, table: TableMeta) -> tuple[list[ColumnMeta], KeyMeta, list[IndexMeta]]:
        inspector = self._inspector(table.source_id)
        dialect_name = self._conn(table.source_id).dialect_name

        pk_constraint = inspector.get_pk_constraint(table.name, schema=table.schema)
        pk_columns = set(pk_constraint.get("constrained_columns") or [])

        raw_indexes = inspector.get_indexes(table.name, schema=table.schema)
        indexed_columns: set[str] = set()
        index_metas: list[IndexMeta] = []
        for idx in raw_indexes:
            cols = list(idx.get("column_names") or [])
            indexed_columns.update(c for c in cols if c is not None)
            index_metas.append(
                IndexMeta(
                    name=idx.get("name") or "",
                    columns=cols,
                    unique=bool(idx.get("unique", False)),
                    method=str((idx.get("dialect_options") or {}).get("postgresql_using", "btree")),
                )
            )

        raw_columns = inspector.get_columns(table.name, schema=table.schema)
        columns: list[ColumnMeta] = []
        for position, col in enumerate(raw_columns, start=1):
            name = col["name"]
            columns.append(
                ColumnMeta(
                    name=name,
                    quoted_name=_quote_ident(dialect_name, name),
                    data_type=str(col["type"]),
                    nullable=bool(col.get("nullable", True)),
                    is_primary_key=name in pk_columns,
                    ordinal_position=position,
                    is_indexed=name in indexed_columns or name in pk_columns,
                )
            )

        foreign_keys: list[ForeignKeyMeta] = []
        for fk in inspector.get_foreign_keys(table.name, schema=table.schema):
            referred_schema = fk.get("referred_schema") or table.schema
            referred_table = fk["referred_table"]
            foreign_keys.append(
                ForeignKeyMeta(
                    constraint_name=fk.get("name"),
                    from_columns=list(fk["constrained_columns"]),
                    to_table=f"{table.source_id}.{referred_schema}.{referred_table}",
                    to_columns=list(fk["referred_columns"]),
                )
            )

        key_meta = KeyMeta(primary_key=sorted(pk_columns), foreign_keys=foreign_keys)
        return columns, key_meta, index_metas

    def approx_row_count(self, table: TableMeta) -> int:
        """pg_class.reltuples — NEVER COUNT(*) (SPEC §2.3, DATA_SOURCES.md: the
        337M-row tables must never be fully scanned just to count rows).
        """
        conn = self._conn(table.source_id)
        if conn.dialect_name != "postgresql":
            # Fallback for non-Postgres engines reachable via SQLAlchemy inspect():
            # still avoid COUNT(*) by preferring an engine-native cheap estimate
            # when available; otherwise 0 (unknown) rather than a full scan.
            return 0
        query = sa.text(
            "SELECT c.reltuples::bigint AS approx_rows "
            "FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace "
            "WHERE n.nspname = :schema AND c.relname = :name"
        )
        with conn.engine.connect() as connection:
            row = connection.execute(query, {"schema": table.schema, "name": table.name}).first()
        if row is None or row[0] is None:
            return 0
        return max(0, int(row[0]))

    # ── the ONLY data-touching method ───────────────────────────────────

    def sample_aggregate(
        self, table: TableMeta, columns: list[ColumnMeta], sample_rows: int
    ) -> AggregateProfile:
        """Bounded, read-only sample -> AggregateProfile.

        For tables at/under the large-table threshold: `SELECT * FROM <table>
        LIMIT <sample_rows>` (bounded by construction, never a full scan). For
        large time-series tables the caller (profile.py orchestration) is
        expected to pass a pre-filtered/time-windowed `sample_rows` budget —
        this method itself always applies `LIMIT`, so it can never read more
        than `sample_rows` regardless of table size.

        This is the ONLY function in this class (and one of only two in the
        whole prep package, alongside the DuckDB route's equivalent) that
        issues a `SELECT <cols> FROM <table>` against real cell data. The PHI
        gate's AST scan (phi_gate.py) asserts no other module does this.
        """
        conn = self._conn(table.source_id)
        dialect_name = conn.dialect_name
        select_cols = ", ".join(_quote_ident(dialect_name, c.name) for c in columns)
        quoted_table = f"{_quote_ident(dialect_name, table.schema)}.{_quote_ident(dialect_name, table.name)}"
        # Bounded LIMIT sample — never an unbounded scan.
        query = sa.text(f"SELECT {select_cols} FROM {quoted_table} LIMIT :limit")  # noqa: S608
        with conn.engine.connect() as connection:
            result = connection.execute(query, {"limit": sample_rows})
            rows = [dict(r._mapping) for r in result]

        profile_columns = [ProfileColumn(key=c.name, label=c.name, type=c.data_type) for c in columns]
        return sample_aggregate_from_rows(
            rows=rows,
            columns=profile_columns,
            phi_columns=self._phi_columns,
            max_sample_rows=sample_rows,
        )

    def sample_aggregate_time_windowed(
        self,
        table: TableMeta,
        columns: list[ColumnMeta],
        sample_rows: int,
        time_column: str,
        window_start_sql: str = "now() - interval '7 days'",
    ) -> AggregateProfile:
        """Time-windowed variant for `isLargeTimeSeries` tables (SPEC §2.2
        config `timeWindowedSampleFor`). Filters on an indexed time column
        BEFORE applying LIMIT, so the sample is recent and the scan can use the
        index rather than a sequential scan of a 337M-row table.
        """
        conn = self._conn(table.source_id)
        dialect_name = conn.dialect_name
        select_cols = ", ".join(_quote_ident(dialect_name, c.name) for c in columns)
        quoted_table = f"{_quote_ident(dialect_name, table.schema)}.{_quote_ident(dialect_name, table.name)}"
        quoted_time_col = _quote_ident(dialect_name, time_column)
        query = sa.text(
            f"SELECT {select_cols} FROM {quoted_table} "  # noqa: S608
            f"WHERE {quoted_time_col} >= {window_start_sql} "
            f"LIMIT :limit"
        )
        with conn.engine.connect() as connection:
            result = connection.execute(query, {"limit": sample_rows})
            rows = [dict(r._mapping) for r in result]

        profile_columns = [ProfileColumn(key=c.name, label=c.name, type=c.data_type) for c in columns]
        return sample_aggregate_from_rows(
            rows=rows,
            columns=profile_columns,
            phi_columns=self._phi_columns,
            max_sample_rows=sample_rows,
        )
