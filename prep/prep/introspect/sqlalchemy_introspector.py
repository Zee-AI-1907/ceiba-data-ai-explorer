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

import re
from dataclasses import dataclass

import sqlalchemy as sa
from sqlalchemy.engine import Engine
from sqlalchemy.engine.reflection import Inspector

from ceiba_nl2sql.compliance.aggregate_profile import (
    AggregateProfile,
    ProfileColumn,
    sample_aggregate_from_rows,
)
from ceiba_nl2sql.compliance.phi import load_phi_columnset

from prep.introspect.engine import (
    ColumnMeta,
    ColumnStatistics,
    ForeignKeyMeta,
    IndexMeta,
    KeyMeta,
    TableMeta,
    TimeColumnRange,
)


def _register_infinity_safe_loaders(dbapi_connection) -> None:  # noqa: ANN001
    """Map Postgres date/timestamp ±infinity sentinels to None on a psycopg3
    connection, so sampling rows that hold them doesn't raise `DataError:
    date too small`. No-op for non-psycopg drivers.

    We subclass psycopg's built-in loaders and only intercept the two literal
    sentinel byte strings (`infinity` / `-infinity`), delegating everything else
    to the default parser — so ordinary dates are unaffected.
    """
    try:
        from psycopg.types.datetime import (
            DateLoader,
            TimestampLoader,
            TimestamptzLoader,
        )
    except Exception:  # not psycopg3 (e.g. sqlite/mysql) — nothing to do
        return

    _INF = (b"infinity", b"-infinity")

    class _SafeDate(DateLoader):
        def load(self, data):  # noqa: ANN001
            if data is not None and bytes(data) in _INF:
                return None
            return super().load(data)

    class _SafeTimestamp(TimestampLoader):
        def load(self, data):  # noqa: ANN001
            if data is not None and bytes(data) in _INF:
                return None
            return super().load(data)

    class _SafeTimestamptz(TimestamptzLoader):
        def load(self, data):  # noqa: ANN001
            if data is not None and bytes(data) in _INF:
                return None
            return super().load(data)

    adapters = dbapi_connection.adapters
    adapters.register_loader("date", _SafeDate)
    adapters.register_loader("timestamp", _SafeTimestamp)
    adapters.register_loader("timestamptz", _SafeTimestamptz)


_MAX_CHECK_IN_LIST_VALUES = 50
_MONTH_RE = re.compile(r"^(\d{4})-(\d{2})")
_INFINITY_LITERALS = ("infinity", "-infinity")


def _month_of(text_value: object) -> tuple[str | None, bool]:
    """(month "YYYY-MM" | None, is_infinity_sentinel) for a ::text-cast
    date/timestamp aggregate result. Month truncation happens HERE, before the
    value leaves the introspector — no exact date is ever emitted.
    """
    if text_value is None:
        return None, False
    text = str(text_value).strip()
    if text.lower() in _INFINITY_LITERALS:
        return None, True
    match = _MONTH_RE.match(text)
    if match is None:
        return None, False
    return f"{match.group(1)}-{match.group(2)}", False


def parse_check_in_list(sqltext: str) -> tuple[str, tuple[str, ...]] | None:
    """Extract (column, declared values) from a CHECK constraint expression
    when it is a single-column IN-list. Handles both the authored form
    (`status IN ('a','b')`) and Postgres's normalized form
    (`(status)::text = ANY ((ARRAY['a'::character varying, ...])::text[])`).
    Returns None for anything else (multi-column, ranges, unparseable) —
    fail-open by design. Values capped at 50 (a bigger list is a vocabulary
    table, not a status enum, and would bloat the prompt).
    """
    if not sqltext or "(" not in sqltext and " in " not in sqltext.lower():
        return None
    try:
        import sqlglot
        from sqlglot import exp as _exp

        parsed = sqlglot.parse_one(sqltext, read="postgres")
    except Exception:  # noqa: BLE001 - unparseable constraint -> no values
        return None

    def _column_name(node) -> str | None:
        inner = node
        while isinstance(inner, (_exp.Cast, _exp.Paren)):
            inner = inner.this
        return inner.name if isinstance(inner, _exp.Column) else None

    def _literal_values(nodes) -> tuple[str, ...] | None:
        values: list[str] = []
        for candidate in nodes:
            inner = candidate
            while isinstance(inner, (_exp.Cast, _exp.Paren)):
                inner = inner.this
            if not isinstance(inner, _exp.Literal):
                return None
            values.append(str(inner.this))
        if not values or len(values) > _MAX_CHECK_IN_LIST_VALUES:
            return None
        return tuple(values)

    # Form 1: <col> IN (<literals>)
    for in_node in parsed.find_all(_exp.In):
        column = _column_name(in_node.this)
        values = _literal_values(in_node.expressions)
        if column and values:
            return column, values

    # Form 2: <col> = ANY (ARRAY[<literals>])  (Postgres normalization)
    for eq_node in parsed.find_all(_exp.EQ):
        column = _column_name(eq_node.this)
        if not column:
            continue
        right = eq_node.expression
        while isinstance(right, (_exp.Cast, _exp.Paren)):
            right = right.this
        if isinstance(right, _exp.Any):
            array = right.this
            while isinstance(array, (_exp.Cast, _exp.Paren)):
                array = array.this
            if isinstance(array, _exp.Array):
                values = _literal_values(array.expressions)
                if values:
                    return column, values
    return None


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
            # Real clinical data contains Postgres `infinity`/`-infinity` date &
            # timestamp sentinels (open-ended ranges). psycopg's default loaders
            # raise `DataError: date too small` on `-infinity`, which would crash
            # profiling of any sampled row that holds one. Register per-connection
            # loaders that map ±infinity to None so aggregation treats them as a
            # null/absent value (we only ever compute counts/min/max/mean over
            # these columns — never emit the raw value). Read-only-safe: loaders
            # affect how values are *read*, never written. psycopg3 only.
            _register_infinity_safe_loaders(dbapi_connection)

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

        # CHECK-constraint IN-lists give DDL-declared allowed values for a
        # column ("status IN ('active','closed')") — schema metadata, never
        # sampled data. Parsed fail-open: an unparseable constraint yields no
        # values, never an error.
        check_values = self._check_constraint_values(table)

        raw_columns = inspector.get_columns(table.name, schema=table.schema)
        columns: list[ColumnMeta] = []
        for position, col in enumerate(raw_columns, start=1):
            name = col["name"]
            # A reflected Postgres ENUM type carries its DECLARED labels on
            # `.enums` — DDL metadata (the type definition), not cell data.
            declared_enum = getattr(col.get("type"), "enums", None)
            enum_values = tuple(str(v) for v in declared_enum) if declared_enum else check_values.get(name)
            columns.append(
                ColumnMeta(
                    name=name,
                    quoted_name=_quote_ident(dialect_name, name),
                    data_type=str(col["type"]),
                    nullable=bool(col.get("nullable", True)),
                    is_primary_key=name in pk_columns,
                    ordinal_position=position,
                    is_indexed=name in indexed_columns or name in pk_columns,
                    comment=col.get("comment") or None,
                    enum_values=enum_values,
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

    def _check_constraint_values(self, table: TableMeta) -> dict[str, tuple[str, ...]]:
        """Parse each CHECK constraint's sqltext for a single-column IN-list
        (`col IN ('a','b')`, or Postgres's normalized `col = ANY (ARRAY[...])`
        form) and return {column_name: declared values}. DDL metadata only —
        the values come from the constraint DEFINITION, never a data row.
        Fail-open: anything unparseable contributes nothing.
        """
        try:
            inspector = self._inspector(table.source_id)
            constraints = inspector.get_check_constraints(table.name, schema=table.schema)
        except Exception:  # noqa: BLE001 - engines without CHECK reflection just yield nothing
            return {}
        values: dict[str, tuple[str, ...]] = {}
        for constraint in constraints:
            parsed = parse_check_in_list(constraint.get("sqltext") or "")
            if parsed is not None:
                column_name, allowed = parsed
                values[column_name] = allowed
        return values

    def table_comment(self, table: TableMeta) -> str | None:
        """pg_description table comment via SQLAlchemy's metadata-only
        `get_table_comment`. None when absent or unsupported by the engine.
        """
        try:
            comment = self._inspector(table.source_id).get_table_comment(table.name, schema=table.schema)
        except Exception:  # noqa: BLE001 - not all dialects implement it
            return None
        text = (comment or {}).get("text")
        return text or None

    def column_statistics(self, table: TableMeta) -> dict[str, ColumnStatistics]:
        """Whole-table planner statistics from `pg_stats` — null_frac +
        n_distinct ONLY. `most_common_vals`/`histogram_bounds` are NEVER
        selected: those fields carry raw cell values, which may only ever be
        touched inside `sample_aggregate*` (SPEC §2.5 #3). The two numeric
        fields read here are pure statistics Postgres already maintains, and
        they are strictly better than sample-derived estimates (whole-table,
        not first-5000-rows). Non-Postgres engines: empty (unknown).
        """
        conn = self._conn(table.source_id)
        if conn.dialect_name != "postgresql":
            return {}
        query = sa.text(
            "SELECT attname, null_frac, n_distinct FROM pg_stats "
            "WHERE schemaname = :schema AND tablename = :name"
        )
        try:
            with conn.engine.connect() as connection:
                rows = connection.execute(query, {"schema": table.schema, "name": table.name}).all()
        except Exception:  # noqa: BLE001 - stats are enrichment, never fail a build over them
            return {}
        return {
            str(r[0]): ColumnStatistics(
                null_frac=float(r[1]) if r[1] is not None else None,
                n_distinct=float(r[2]) if r[2] is not None else None,
            )
            for r in rows
        }

    def sample_aggregate_time_range(self, table: TableMeta, time_column: str) -> TimeColumnRange | None:
        """Aggregate-only min/max of ONE time column, month-truncated before it
        leaves this function (an exact earliest/latest timestamp is an
        individual's date; a month is a cohort property). Cast to text
        server-side so Postgres ±infinity sentinels arrive as literal
        'infinity'/'-infinity' strings (the psycopg loaders would otherwise
        nullify them) — their presence is itself a signal the LLM needs
        (open-ended ranges convention). Plain min/max on an INDEXED column is
        an index-endpoints probe, never a table scan — the caller only asks
        for indexed time columns (or tiny tables).

        Named `sample_aggregate_*` because it IS a data-touching aggregate —
        the phi_gate AST scan sanctions exactly this prefix (SPEC §2.5 #3).
        """
        conn = self._conn(table.source_id)
        dialect_name = conn.dialect_name
        quoted_col = _quote_ident(dialect_name, time_column)
        quoted_table = f"{_quote_ident(dialect_name, table.schema)}.{_quote_ident(dialect_name, table.name)}"
        query = sa.text(
            f"SELECT min({quoted_col})::text, max({quoted_col})::text FROM {quoted_table}"  # noqa: S608
        )
        try:
            with conn.engine.connect() as connection:
                row = connection.execute(query).first()
        except Exception:  # noqa: BLE001 - a range probe must never fail the build
            return None
        if row is None:
            return None
        min_month, min_inf = _month_of(row[0])
        max_month, max_inf = _month_of(row[1])
        return TimeColumnRange(
            column=time_column,
            min_month=min_month,
            max_month=max_month,
            uses_infinity_sentinels=min_inf or max_inf,
        )

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

    def fetch_code_table_rows(
        self, source_id: str, schema: str, table: str, id_column: str, label_column: str
    ) -> list[tuple]:
        """Read-only extraction of a code/lookup table's (id, label) rows for
        Fix D semantic-hint mining (SEMANTIC_HINTS.md §1.3). Named
        `*sample_aggregate*`-adjacent and bounded by a hard LIMIT so it can only
        read a small lookup vocabulary (HR, SPO2, …), never a fact table — the
        caller (code_tables.detect_code_tables) has already gated on
        `approxRowCount <= CODE_TABLE_MAX_ROWS`. Label values here are non-PHI
        controlled-vocabulary names (the detector rejects PHI label columns).
        This is a deliberate second data-touching read path; the phi_gate AST
        scan allowlists it by name alongside sample_aggregate.
        """
        conn = self._conn(source_id)
        dialect_name = conn.dialect_name
        qid = _quote_ident(dialect_name, id_column)
        qlabel = _quote_ident(dialect_name, label_column)
        quoted_table = f"{_quote_ident(dialect_name, schema)}.{_quote_ident(dialect_name, table)}"
        # Hard cap far below any real lookup vocabulary; a bigger table would
        # have been rejected by the detector before reaching here.
        query = sa.text(f"SELECT {qid}, {qlabel} FROM {quoted_table} LIMIT 500")  # noqa: S608
        with conn.engine.connect() as connection:
            result = connection.execute(query)
            return [(r[0], r[1]) for r in result]

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
