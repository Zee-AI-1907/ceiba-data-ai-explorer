"""base.py — the swappable federation-engine Protocol (ports
lib/engine/QueryEngine.ts verbatim; docs/PYTHON_NL2SQL_SERVICE_PLAN.md §3.1
`engine/base.py`).

Two hard rules carried over from the TS interface:
  1. Every read goes through `execute`, which enforces the `max_rows`/
     `deadline_ms` budget.
  2. `explain` NEVER returns data rows — it is the self-repair loop's
     dry-run validator (NL2SQL_SPEC.md §5.5 "explain, never execute").
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Literal, Protocol

SqlDialect = Literal["duckdb", "postgres", "trino"]


@dataclass(frozen=True)
class EngineCapabilities:
    supports_cross_catalog_join: bool
    identifier_quote: Literal['"', "`"]
    interval_syntax: Literal["ansi", "postgres", "trino"]
    supports_explain: bool


@dataclass(frozen=True)
class AttachSpec:
    source_id: str
    engine: Literal["postgres", "duckdb"]
    dsn: str
    read_only: Literal[True]
    alias: str


@dataclass(frozen=True)
class ExecuteOptions:
    catalog: str | None = None
    schema: str | None = None
    max_rows: int = 1000
    deadline_ms: int = 55_000


@dataclass(frozen=True)
class EngineColumn:
    name: str
    type: str


@dataclass(frozen=True)
class EngineResult:
    columns: list[EngineColumn]
    rows: list[dict]
    row_count: int
    truncated: bool


@dataclass(frozen=True)
class PlanOk:
    ok: Literal[True]
    plan: str


@dataclass(frozen=True)
class PlanError:
    ok: Literal[False]
    error: str


PlanOrError = PlanOk | PlanError


@dataclass(frozen=True)
class TableMeta:
    source_id: str
    schema: str
    name: str
    quoted_ref: str


@dataclass(frozen=True)
class ColumnMeta:
    name: str
    quoted_name: str
    data_type: str
    nullable: bool
    is_primary_key: bool
    is_indexed: bool


@dataclass(frozen=True)
class ForeignKeyMeta:
    from_columns: list[str]
    to_table: str
    to_columns: list[str]


@dataclass(frozen=True)
class DescribeResult:
    columns: list[ColumnMeta]
    primary_key: list[str]
    foreign_keys: list[ForeignKeyMeta]


class QueryEngine(Protocol):
    """The engine abstraction every implementation (DuckDbEngine now, a
    TrinoEngine stub later) satisfies. Mirrors lib/engine/QueryEngine.ts's
    `QueryEngine` interface.
    """

    def attach(self, specs: list[AttachSpec]) -> None: ...
    def dispose(self) -> None: ...

    def execute(self, sql: str, opts: ExecuteOptions) -> EngineResult: ...
    def explain(self, sql: str, *, catalog: str | None = None, schema: str | None = None) -> PlanOrError: ...
    def dialect(self) -> SqlDialect: ...
    def capabilities(self) -> EngineCapabilities: ...

    def list_catalogs(self) -> list[str]: ...
    def list_schemas(self, catalog: str) -> list[str]: ...
    def list_tables(self, catalog: str, schema: str) -> list[TableMeta]: ...
    def describe_table(self, ref: TableMeta) -> DescribeResult: ...
