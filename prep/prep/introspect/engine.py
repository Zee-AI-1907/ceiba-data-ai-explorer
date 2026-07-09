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


class Introspector(Protocol):
    """DB-agnostic. One implementation per route (SQLAlchemy default; DuckDB-attach; Trino later)."""

    def connect_read_only(self, source_id: str, dsn: str) -> None: ...
    def list_schemas(self, source_id: str) -> list[str]: ...
    def list_tables(self, source_id: str, schema: str) -> list[TableMeta]: ...
    def describe_table(self, table: TableMeta) -> tuple[list[ColumnMeta], KeyMeta, list[IndexMeta]]: ...
    def approx_row_count(self, table: TableMeta) -> int: ...  # pg_class.reltuples / equivalent
    def sample_aggregate(
        self, table: TableMeta, columns: list[ColumnMeta], sample_rows: int
    ) -> "AggregateProfile": ...  # ONLY data-touching method (§2.5)
