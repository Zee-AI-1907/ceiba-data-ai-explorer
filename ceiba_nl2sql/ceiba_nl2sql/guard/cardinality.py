"""cardinality.py — availability control against unbounded scans of large
time-series tables (ports lib/rag/cardinalityGuard.ts; upgraded from lexical
substring matching to `sqlglot`-AST detection per
docs/PYTHON_NL2SQL_SERVICE_PLAN.md §1.1, §1.3, §3.1, §3.2: "Upgraded from
lexical to sqlglot-AST detection of large-table scans").

── Policy (mirrors NL2SQL_SPEC.md §5.4 / lib/rag/cardinalityGuard.ts) ───────
For each configured large/time-series table referenced by the SQL:
  - Missing LIMIT (anywhere in the statement) alone -> action='repair':
    append a LIMIT to the repaired SQL.
  - No predicate on the table's required_time_column -> action='reject' with
    a repair_hint describing which column to bound on, UNLESS the table has
    no required_time_column configured, in which case action='reject' too
    (no safe repair is possible — the correct time window is a business
    decision the guard cannot fabricate).
  - A wholly-unbounded scan (no time predicate at all on a table with a known
    required time column) is `reject`, not silently repairable. Only a "has
    a time bound, missing LIMIT" case is auto-repaired (safe,
    meaning-preserving).

── Why sqlglot instead of the TS lexical/regex approach ─────────────────────
`lib/rag/cardinalityGuard.ts`'s own header calls this a defense-in-depth
guard that "P5 may harden with a real SQL AST if false negatives are
observed" — this module IS that hardening. Table references are read from
the FROM/JOIN nodes of the parsed AST (not a `\\btableName\\b` regex, which
can false-positive on a comment/string or false-negative on an aliased
subquery), and predicate detection walks the WHERE tree for a comparison
node whose left/right side resolves to the required time column, instead of
a "column name followed within ~80 chars by an operator" text-window regex.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Literal

import sqlglot
from sqlglot import expressions as exp
from sqlglot.errors import ParseError

from ceiba_nl2sql.sqltools.dialect import normalize_dialect

_COMPARISON_TYPES: tuple[type, ...] = (
    exp.GT,
    exp.GTE,
    exp.LT,
    exp.LTE,
    exp.EQ,
    exp.NEQ,
    exp.Between,
)


@dataclass(frozen=True)
class LargeTableSpec:
    """Bare table name as it appears in SQL, plus an optional display ref."""

    table_name: str
    quoted_ref: str | None = None


@dataclass(frozen=True)
class CardinalityVerdict:
    ok: bool
    action: Literal["pass", "repair", "reject"]
    repaired_sql: str | None = None
    repair_hint: str | None = None
    reason: str | None = None


def _table_name_matches(node: exp.Table, table_name: str) -> bool:
    return node.name.lower() == table_name.lower()


def _referenced_table_names(root: exp.Expression) -> set[str]:
    """Collects the bare names of every table reference (FROM/JOIN, including
    inside CTEs/subqueries) in the parsed AST — an AST walk, not a text
    regex, so an aliased subquery or a table name inside a string literal
    cannot fool this the way a lexical `\\btableName\\b` match could.
    """
    names: set[str] = set()
    for table in root.find_all(exp.Table):
        names.add(table.name.lower())
    return names


def _has_limit_clause(root: exp.Expression) -> bool:
    # A `WITH ... SELECT` still exposes its own LIMIT via `.args.get("limit")`
    # on the outer Select node; walk defensively for any Limit node too.
    if isinstance(root, exp.Select) and root.args.get("limit"):
        return True
    return any(root.find_all(exp.Limit))


def _has_time_bound_predicate(root: exp.Expression, time_column: str) -> bool:
    """Walks every comparison/BETWEEN node in the WHERE tree (and anywhere
    else in the statement) looking for one whose operand resolves to
    `time_column` (bare or qualified, case-insensitive) — the AST equivalent
    of the TS regex `(?:\\w+\\.)?"?col"?\\s*(?:::type)?\\s*(op)`.
    """
    target = time_column.lower()
    for node in root.walk():
        # sqlglot's `.walk()` yields bare nodes on this version; guard
        # defensively in case a future/older sqlglot yields (node, parent, key).
        node = node[0] if isinstance(node, tuple) else node
        if not isinstance(node, _COMPARISON_TYPES):
            continue
        operands: list[exp.Expression] = []
        if isinstance(node, exp.Between):
            operands = [node.this]
        else:
            operands = [node.this, node.expression] if node.expression is not None else [node.this]
        for operand in operands:
            # Unwrap a CAST (e.g. `"RecordedAt"::timestamptz >= ...`).
            probe = operand
            if isinstance(probe, exp.Cast):
                probe = probe.this
            if isinstance(probe, exp.Column) and probe.name.lower() == target:
                return True
    return False


def _append_limit(sql: str, limit: int) -> str:
    trimmed = sql.rstrip()
    had_trailing_semicolon = trimmed.endswith(";")
    without_semicolon = trimmed[:-1].rstrip() if had_trailing_semicolon else trimmed
    return f"{without_semicolon} LIMIT {limit}{';' if had_trailing_semicolon else ''}"


def cardinality_guard(
    sql: str,
    *,
    large_tables: list[LargeTableSpec],
    required_time_column_by_table: dict[str, str],
    default_limit: int = 1000,
    dialect: str | None = None,
) -> CardinalityVerdict:
    """Checks a candidate SQL statement against the large-table bounding
    policy and either passes it, repairs it (LIMIT-only gap), or rejects it
    (missing/unknown time bound) with a reason/hint for the self-repair loop.
    Assumes `sql` is a single statement (guard_sql's multi-statement
    rejection runs upstream in the pipeline).
    """
    resolved_dialect = normalize_dialect(dialect)
    try:
        root = sqlglot.parse_one(sql, read=resolved_dialect)
    except ParseError as exc:
        # Fail closed: an unparseable statement cannot be verified bounded,
        # so treat it as a reject rather than silently passing it through —
        # guard_sql runs first in the pipeline and would already have
        # rejected most unparseable input, but this guard must not assume that.
        return CardinalityVerdict(
            ok=False, action="reject", reason=f"SQL failed to parse for cardinality analysis: {exc}"
        )

    referenced_names = _referenced_table_names(root)
    referenced_large_tables = [t for t in large_tables if t.table_name.lower() in referenced_names]

    if not referenced_large_tables:
        return CardinalityVerdict(ok=True, action="pass")

    missing_time_bound_tables: list[LargeTableSpec] = []
    for table in referenced_large_tables:
        time_column = required_time_column_by_table.get(table.table_name)
        if not time_column:
            missing_time_bound_tables.append(table)
            continue
        if not _has_time_bound_predicate(root, time_column):
            missing_time_bound_tables.append(table)

    if missing_time_bound_tables:
        names = ", ".join(t.quoted_ref or t.table_name for t in missing_time_bound_tables)
        hints = " ".join(
            (
                f"Add a time-bound predicate on {required_time_column_by_table[t.table_name]} for "
                f"{t.quoted_ref or t.table_name} (e.g. WHERE {required_time_column_by_table[t.table_name]} >= "
                "now() - INTERVAL '...')."
                if t.table_name in required_time_column_by_table
                else f"{t.quoted_ref or t.table_name} is a large table with no known time column configured; "
                "a bounding predicate is required before this query can run."
            )
            for t in missing_time_bound_tables
        )
        return CardinalityVerdict(
            ok=False,
            action="reject",
            reason=f"Unbounded scan of large table(s) {names}: missing a required time-bound predicate.",
            repair_hint=hints,
        )

    if not _has_limit_clause(root):
        repaired_sql = _append_limit(sql, default_limit)
        return CardinalityVerdict(
            ok=True,
            action="repair",
            repaired_sql=repaired_sql,
            repair_hint=f"Missing LIMIT; a LIMIT {default_limit} was appended automatically.",
            reason="Query was time-bounded but had no LIMIT; repaired by appending one.",
        )

    return CardinalityVerdict(ok=True, action="pass")


# ── SPEC §5.4 context-driven entry point ──────────────────────────────────


def _bare_table_name_of(table: dict) -> str:
    """Extracts the bare table name from a rendered table dict
    (`{"quotedRef": ..., "tableId": ...}`). Mirrors
    lib/rag/cardinalityGuard.ts `bareTableNameOf`.
    """
    import re

    quoted_ref = table.get("quoted_ref") or table.get("quotedRef") or ""
    segments = re.findall(r'"([^"]+)"', quoted_ref)
    if segments:
        return segments[-1]
    table_id = table.get("table_id") or table.get("tableId") or ""
    parts = table_id.split(".")
    return parts[-1] if parts else quoted_ref


def _bare_column_name_of(quoted_column: str) -> str:
    import re

    match = re.search(r'"([^"]+)"', quoted_column)
    return match.group(1) if match else quoted_column


def build_cardinality_guard_options(
    tables: list[dict], default_limit: int = 1000
) -> tuple[list[LargeTableSpec], dict[str, str]]:
    """Derive the large-table bounding policy directly from a retrieved
    SchemaContext's rendered tables (SPEC §5.4). Every survivor table flagged
    `is_large_time_series` becomes a `LargeTableSpec`, and its
    `required_time_column` becomes the bound the guard enforces. Mirrors
    lib/rag/cardinalityGuard.ts `buildCardinalityGuardOptions`.

    `tables` accepts either snake_case dataclass-derived dicts (from
    `ceiba_nl2sql.retrieval.retriever.RenderedTable`) or the raw camelCase
    bundle shape, for flexibility across callers.
    """
    large_tables: list[LargeTableSpec] = []
    required_time_column_by_table: dict[str, str] = {}
    for table in tables:
        is_large = table.get("is_large_time_series", table.get("isLargeTimeSeries", False))
        if not is_large:
            continue
        table_name = _bare_table_name_of(table)
        quoted_ref = table.get("quoted_ref") or table.get("quotedRef")
        large_tables.append(LargeTableSpec(table_name=table_name, quoted_ref=quoted_ref))
        required_time_column = table.get("required_time_column") or table.get("requiredTimeColumn")
        if required_time_column:
            required_time_column_by_table[table_name] = _bare_column_name_of(required_time_column)
    return large_tables, required_time_column_by_table


def cardinality_guard_from_context(
    sql: str, tables: list[dict], default_limit: int = 1000, *, dialect: str | None = None
) -> CardinalityVerdict:
    """The SPEC §5.4 signature `cardinalityGuard(sql, ctx)`. Thin adapter
    that derives the policy from the retrieved SchemaContext's tables and
    delegates to the core guard. Mirrors lib/rag/cardinalityGuard.ts
    `cardinalityGuardFromContext`.
    """
    large_tables, required_time_column_by_table = build_cardinality_guard_options(tables, default_limit)
    return cardinality_guard(
        sql,
        large_tables=large_tables,
        required_time_column_by_table=required_time_column_by_table,
        default_limit=default_limit,
        dialect=dialect,
    )
