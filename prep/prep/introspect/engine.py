"""engine.py — Introspector protocol (SPEC §2.3).

The dataclasses and Protocol below are copied VERBATIM from
docs/NL2SQL_SPEC.md §2.3 ("DB-agnostic introspection interface"). Do not add
fields or rename members here without updating the spec first — this is the
one seam every introspection route (SQLAlchemy, DuckDB-attach, later Trino)
implements identically so the bundle format never depends on which route
produced it.

Hard rule (mirrors research §1.4, SPEC §2.3): `sample_aggregate` is the ONLY
method on this Protocol that reads cell data. Every other method reads
information_schema / pg_catalog (or the DB-agnostic equivalent) — schema
metadata only, never a row value. `sample_aggregate` returns the same
PHI-suppressed `AggregateProfile` shape `lib/phiScrubber.ts.buildAggregateProfile`
defines (mirrored in Python by
`ceiba_nl2sql.compliance.aggregate_profile.AggregateProfile` — moved there
from `prep/prep/profile.py` in Phase 1 of
docs/PYTHON_NL2SQL_SERVICE_PLAN.md so it is shared with the future NL->SQL
service).
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import TYPE_CHECKING, Protocol

if TYPE_CHECKING:
    from ceiba_nl2sql.compliance.aggregate_profile import AggregateProfile


@dataclass(frozen=True)
class ColumnMeta:
    name: str
    quoted_name: str
    data_type: str
    nullable: bool
    is_primary_key: bool
    ordinal_position: int
    is_indexed: bool
    # Metadata-only enrichment (SPEC §2.3 additive fields; defaults keep every
    # existing constructor call valid). `comment` = pg_description column
    # comment; `enum_values` = the DECLARED labels of a Postgres ENUM type —
    # DDL metadata, never sampled cell data.
    comment: str | None = None
    enum_values: tuple[str, ...] | None = None


@dataclass(frozen=True)
class TableMeta:
    source_id: str
    schema: str
    name: str
    quoted_ref: str


@dataclass(frozen=True)
class KeyMeta:
    primary_key: list[str]
    foreign_keys: list["ForeignKeyMeta"]


@dataclass(frozen=True)
class ForeignKeyMeta:
    constraint_name: str | None
    from_columns: list[str]
    to_table: str
    to_columns: list[str]


@dataclass(frozen=True)
class IndexMeta:
    name: str
    columns: list[str]
    unique: bool
    method: str


@dataclass(frozen=True)
class ColumnStatistics:
    """Whole-table planner statistics for one column, read from `pg_stats`
    (or the engine-native equivalent). Numbers ONLY — `most_common_vals` and
    every other value-bearing pg_stats field are deliberately never read
    (they contain raw cell values; the PHI discipline forbids them outside
    `sample_aggregate*`).

    `n_distinct` keeps Postgres semantics: >= 0 is an absolute distinct
    count; < 0 is `-(distinct/row)` ratio (scale by row count to estimate).
    """

    null_frac: float | None = None
    n_distinct: float | None = None


@dataclass(frozen=True)
class TimeColumnRange:
    """Aggregate min/max of one time column, month-truncated ("YYYY-MM") so no
    individual-level date leaves the source (an exact earliest admission
    timestamp is an individual's date; a month is a cohort property).
    `uses_infinity_sentinels` records that the column holds Postgres
    ±infinity open-range sentinels — a convention the LLM must know about.
    When a sentinel IS the min/max, the corresponding month is None (unknown)
    and the flag is the signal.
    """

    column: str
    min_month: str | None
    max_month: str | None
    uses_infinity_sentinels: bool = False


class Introspector(Protocol):
    """DB-agnostic. One implementation per route (SQLAlchemy default; DuckDB-attach; Trino later).

    Additive catalog-harvest methods (all optional for a route to implement
    meaningfully — return None/{} when the engine has no equivalent):
      - `table_comment` / column `comment`s: pg_description documentation.
      - `column_statistics`: whole-table planner stats (pg_stats), NUMBERS ONLY.
      - `sample_aggregate_time_range`: the second sanctioned data-touching
        method alongside `sample_aggregate*` — an aggregate-only min/max of one
        time column, month-truncated before it leaves the introspector.
    """

    def connect_read_only(self, source_id: str, dsn: str) -> None: ...
    def list_schemas(self, source_id: str) -> list[str]: ...
    def list_tables(self, source_id: str, schema: str) -> list[TableMeta]: ...
    def describe_table(self, table: TableMeta) -> tuple[list[ColumnMeta], KeyMeta, list[IndexMeta]]: ...
    def approx_row_count(self, table: TableMeta) -> int: ...  # pg_class.reltuples / equivalent
    def table_comment(self, table: TableMeta) -> str | None: ...  # pg_description, metadata-only
    def column_statistics(self, table: TableMeta) -> dict[str, ColumnStatistics]: ...  # pg_stats numbers only
    def sample_aggregate(
        self, table: TableMeta, columns: list[ColumnMeta], sample_rows: int
    ) -> "AggregateProfile": ...  # data-touching (§2.5)
    def sample_aggregate_time_range(
        self, table: TableMeta, time_column: str
    ) -> TimeColumnRange | None: ...  # data-touching, aggregate-only (§2.5)
