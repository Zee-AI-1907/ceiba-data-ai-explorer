"""routing.py — single-source detection + native-passthrough rewrite for the
DuckDB federation engine (docs/research/DUCKDB_PUSHDOWN.md §5.1).

WHY THIS EXISTS
───────────────
DuckDB's `postgres` scanner (via ATTACH) pushes FILTER / PROJECTION / LIMIT down
to the remote Postgres but NOT aggregates or joins: each remote table is scanned
independently and the join/aggregate runs in DuckDB. On a multi-hop query over a
large table that streams tens of millions of rows across the wire and times out
(proven on staging: the canonical HR query >35s federated vs ~0.8s native).

The fix, for the common case where EVERY table in a query lives on ONE source:
ship the whole SQL verbatim to that source's Postgres via DuckDB's
`postgres_query(alias, 'SQL')` table function, which runs it under Postgres's own
optimizer (join reorder, index nested loops, aggregate pushdown) and streams back
ONLY the result. Genuine cross-source queries keep the federated path.

WHAT THIS MODULE DOES
─────────────────────
The runtime SQL is DuckDB dialect and catalog-qualified (`alias.schema.table`),
where `alias` == the ATTACH alias == the source. So:

  single-source  ⟺  every table reference shares ONE catalog (or is unqualified).

`analyze_single_source(sql, dialect)` returns a `SingleSourceRewrite` (the sole
catalog alias + the SQL rewritten for the remote: catalog qualifier stripped and
transpiled to the remote dialect) or `None` when the query spans >1 catalog (or
cannot be safely analyzed — fail closed to the federated path, never guess).

This is a QUALITY / PERFORMANCE routing decision, not a security boundary — the
read-only ATTACH + guard chain remain the boundary. If analysis fails for ANY
reason we return `None` and the caller runs the original SQL through the normal
(federated) path unchanged.
"""

from __future__ import annotations

from dataclasses import dataclass

import sqlglot
from sqlglot import exp
from sqlglot.errors import ParseError, TokenError

from ceiba_nl2sql.sqltools.dialect import normalize_dialect

# Remote dialect for each ATTACH engine type. Only postgres passthrough is
# supported today (the only real remote engine); a duckdb-attached catalog is a
# local file and needs no passthrough. Extend when a Trino remote lands.
_REMOTE_DIALECT_FOR_PASSTHROUGH = "postgres"


@dataclass(frozen=True)
class SingleSourceRewrite:
    """The result of a successful single-source analysis.

    `alias` is the sole catalog/ATTACH alias every table reference shares.
    `remote_sql` is the query rewritten to run natively ON that remote: the
    catalog qualifier is removed from every table (so `alias.schema.table`
    becomes `schema.table`) and the whole statement is transpiled to the remote
    dialect (`remote_dialect`).
    """

    alias: str
    remote_sql: str
    remote_dialect: str


def _catalogs_in(root: exp.Expression) -> set[str]:
    """Every distinct catalog part across all table references in the tree.

    A table with no catalog qualifier contributes the empty string. A query is
    single-source iff this set, after dropping the empty string, has at most one
    member — i.e. every qualified reference names the same catalog and any
    unqualified references are assumed to resolve within it.
    """
    catalogs: set[str] = set()
    for table in root.find_all(exp.Table):
        catalog = table.args.get("catalog")
        catalogs.add(catalog.name if isinstance(catalog, exp.Identifier) else (catalog or ""))
    return catalogs


def analyze_single_source(
    sql: str,
    *,
    dialect: str | None = None,
    remote_dialect: str = _REMOTE_DIALECT_FOR_PASSTHROUGH,
) -> SingleSourceRewrite | None:
    """Return a `SingleSourceRewrite` if `sql` references exactly one catalog
    (source), else `None`. Fails CLOSED to `None` on any parse/analysis error so
    the caller safely falls back to the federated execution path.

    `dialect` is the dialect `sql` is written in (the engine's dialect, default
    duckdb). `remote_dialect` is the dialect to emit for the remote passthrough
    (postgres today).
    """
    if not isinstance(sql, str) or not sql.strip():
        return None

    resolved_dialect = normalize_dialect(dialect)

    try:
        statements = sqlglot.parse(sql, read=resolved_dialect)
    except (ParseError, TokenError):
        return None
    except Exception:  # noqa: BLE001 - any sqlglot internal error -> fall back to federated
        return None

    real = [s for s in statements if s is not None and not isinstance(s, exp.Semicolon)]
    if len(real) != 1:
        # Multi-statement / empty: not our job to route; the guard rejects these
        # anyway. Fall back.
        return None
    root = real[0]

    catalogs = _catalogs_in(root)
    qualified = {c for c in catalogs if c}
    if len(qualified) != 1:
        # Zero qualified catalogs (nothing to strip / can't identify a source) or
        # more than one (genuine cross-source) -> federated path.
        return None
    alias = next(iter(qualified))

    # Rewrite a COPY of the tree: strip the catalog qualifier from every table so
    # the statement is valid on the remote (which has no notion of our attach
    # alias), then transpile to the remote dialect.
    try:
        rewritten = root.copy()
        for table in rewritten.find_all(exp.Table):
            if table.args.get("catalog"):
                table.set("catalog", None)
        remote_sql = rewritten.sql(dialect=remote_dialect)
    except Exception:  # noqa: BLE001 - if rewrite/transpile fails, fall back to federated
        return None

    if not remote_sql.strip():
        return None

    return SingleSourceRewrite(alias=alias, remote_sql=remote_sql, remote_dialect=remote_dialect)
