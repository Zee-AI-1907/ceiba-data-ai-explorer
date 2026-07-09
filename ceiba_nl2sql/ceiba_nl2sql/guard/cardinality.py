"""cardinality.py — availability control against unbounded scans of large
time-series tables (ports lib/rag/cardinalityGuard.ts; upgraded from lexical
substring matching to `sqlglot`-AST detection per
docs/PYTHON_NL2SQL_SERVICE_PLAN.md §1.1, §1.3, §3.1, §3.2: "Upgraded from
lexical to sqlglot-AST detection of large-table scans").

── Policy (mirrors NL2SQL_SPEC.md §5.4 / lib/rag/cardinalityGuard.ts) ───────
For each configured large/time-series table referenced by the SQL, a
SELECTIVE predicate is required — ANY of:
  (a) a valid time-bound predicate on the table's OWN required_time_column
      (when one is configured);
  (b) a selective equality/IN predicate on one of the table's indexed/FK/PK
      columns (`selective_columns`) — an FK-equality is selective by
      definition (it picks one referenced entity), so this needs no time
      predicate at all;
  (c) a valid time-bound predicate on a DIRECTLY-JOINED PARENT table's time
      column, where the large table is joined to that parent via the exact
      FK columns recorded in `parent_time_bound` (e.g. MonitorMeasurements
      has no own time column, but is joined `mm."DeviceId" = m."Id"` to
      Monitors, and Monitors."MeasuredDate" is time-bounded in the WHERE
      clause) — the large table's scan IS bounded through that join, even
      though the predicate's column is textually on the parent alias, not
      the large table's own alias.
Concretely:
  - Missing LIMIT (anywhere in the statement) alone, with a selective
    predicate otherwise satisfied via (a)/(b)/(c) -> action='repair': append
    a LIMIT to the repaired SQL.
  - A table WITH a configured required_time_column and a valid time-bound
    predicate on it -> the policy is satisfied via (a); the other
    alternatives are not needed (existing behavior, UNCHANGED).
  - A table WITHOUT a valid (a) time bound now also checks (b) a selective
    equality/IN predicate, then (c) a parent-join time bound. If EITHER is
    found, the policy is satisfied the same way (a) would have been — pass,
    or repair for a missing LIMIT.
  - Only if NONE of (a), (b), (c) holds is the table "unbounded" -> action=
    'reject', not silently repairable (no safe repair is possible — the
    correct time window or filter is a business decision the guard cannot
    fabricate). This is the Fix C hardening: a bare COUNT(*)/full scan with a
    LIMIT but no selective filter at all (e.g. a 271M-row table scanned before
    the LIMIT even applies) is rejected regardless of whether a LIMIT is
    present — "a LIMIT after a full scan still scans".

── Why sqlglot instead of the TS lexical/regex approach ─────────────────────
`lib/rag/cardinalityGuard.ts`'s own header calls this a defense-in-depth
guard that "P5 may harden with a real SQL AST if false negatives are
observed" — this module IS that hardening. Table references are read from
the FROM/JOIN nodes of the parsed AST (not a `\\btableName\\b` regex, which
can false-positive on a comment/string or false-negative on an aliased
subquery), and predicate detection walks the WHOLE statement AST (not only
the WHERE clause — a bound in a JOIN ... ON / QUALIFY / CTE body counts too)
for a comparison node whose left/right side resolves to the required time
column, instead of a "column name followed within ~80 chars by an operator"
text-window regex.

── Fail-closed lexical fallbacks (kept AT LEAST as strict as the TS guard) ───
Two belt-and-suspenders lexical checks sit behind the AST walk so this guard
is never MORE permissive than lib/rag/cardinalityGuard.ts: (1) if the AST
surfaces zero large tables, a word-boundary scan of the raw SQL for a known
large-table name still triggers the bounding policy (catches an alias/CTE
name the exp.Table walk missed); and (2) only a NUMERIC `LIMIT n` counts as a
real bound — a `LIMIT $1` placeholder is treated as absent, matching the TS
`LIMIT\\s+\\d+` regex.
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from typing import Literal

import sqlglot
from sqlglot import expressions as exp
from sqlglot.errors import ParseError, TokenError

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
class ParentTimeBound:
    """Cardinality-guard remediation: describes how a large table with NO own
    time column can still be bounded — via a directly-joined PARENT table's
    time column, reached by an exact FK join. Mirrors catalog.json's `timeVia`
    hint (prep/prep/enrich/importance.py `apply_time_via_hints`):
    `parent_table_name` is the parent's bare table name, `parent_time_column`
    is the parent's bare time column name, and `from_columns`/`to_columns`
    are the FK join columns in `large_table.from_columns[i] =
    parent.to_columns[i]` order — the SAME shape a joingraph.json edge uses
    (FK-side -> PK-side).
    """

    parent_table_name: str
    parent_time_column: str
    from_columns: list[str]
    to_columns: list[str]


@dataclass(frozen=True)
class LargeTableSpec:
    """Bare table name as it appears in SQL, plus an optional display ref."""

    table_name: str
    quoted_ref: str | None = None
    # Fix C: indexed/FK/PK bare column names for this table — feeds the
    # selective equality/IN predicate escape hatch (see
    # `_has_selective_equality_or_in_predicate`).
    selective_columns: list[str] = field(default_factory=list)
    # Cardinality-guard remediation: set when this table has no own time
    # column but a declared FK reaches a parent table that does (see
    # ParentTimeBound / `_has_parent_join_time_bound`).
    parent_time_bound: ParentTimeBound | None = None


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


def _is_numeric_limit(limit_node: exp.Expression | None) -> bool:
    """True iff the LIMIT's operand is a numeric literal (`LIMIT 100`), matching
    the TS guard's `LIMIT\\s+\\d+` regex. A non-numeric LIMIT (`LIMIT $1`, a
    placeholder/parameter) is NOT counted as a real bound — the TS guard would
    treat it as absent and auto-repair, so the Python guard must do the same to
    stay AT LEAST as strict (P0-arch).
    """
    if limit_node is None:
        return False
    expression = limit_node.expression if isinstance(limit_node, exp.Limit) else None
    if expression is None:
        return False
    return isinstance(expression, exp.Literal) and expression.is_number


def _lexical_references_table(sql: str, table_name: str) -> bool:
    """Word-boundary, case-insensitive match of a bare table name in the raw
    SQL — mirrors lib/rag/cardinalityGuard.ts `identifierPattern` /
    `referencesTable`. Used only as a fail-closed fallback behind the AST walk
    (see cardinality_guard) so a large table the AST missed is still bounded.
    """
    pattern = re.compile(rf"\b{re.escape(table_name)}\b", re.IGNORECASE)
    return bool(pattern.search(sql))


def _has_limit_clause(root: exp.Expression) -> bool:
    # A `WITH ... SELECT` still exposes its own LIMIT via `.args.get("limit")`
    # on the outer Select node; walk defensively for any Limit node too. Only a
    # NUMERIC limit counts (see _is_numeric_limit) — a `LIMIT $1` placeholder is
    # treated as no limit, matching the TS `LIMIT\d+` regex.
    if isinstance(root, exp.Select) and _is_numeric_limit(root.args.get("limit")):
        return True
    return any(_is_numeric_limit(node) for node in root.find_all(exp.Limit))


def _has_time_bound_predicate(root: exp.Expression, time_column: str, *, table_aliases: set[str] | None = None) -> bool:
    """Walks every comparison/BETWEEN node ANYWHERE in the statement's AST
    (not only the WHERE clause — a bound expressed in a JOIN ... ON, a QUALIFY,
    or a CTE body counts too) looking for one whose operand resolves to
    `time_column` (bare or qualified, case-insensitive) — the AST equivalent
    of the TS regex `(?:\\w+\\.)?"?col"?\\s*(?:::type)?\\s*(op)`. Scanning the
    whole tree is intentional: it counts a legitimate bound wherever it
    appears, so a bounded query is not falsely rejected.

    `table_aliases`, when given (lowercase alias/bare-name set), restricts a
    match to a column operand explicitly qualified by one of those aliases
    (e.g. `m."MeasuredDate"` where `m` is Monitors' alias) — used by the
    parent-join bounding check (`_has_parent_join_time_bound`) so a same-named
    column on an unrelated table cannot masquerade as the parent's time bound.
    An UNQUALIFIED column operand never satisfies an alias-scoped check (it
    cannot be attributed to the parent with confidence).
    """
    target = time_column.lower()
    aliases = {a.lower() for a in table_aliases} if table_aliases else None
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
            if not (isinstance(probe, exp.Column) and probe.name.lower() == target):
                continue
            if aliases is None:
                return True
            table_qualifier = (probe.table or "").lower()
            if table_qualifier in aliases:
                return True
    return False


def _is_join_on_clause_predicate(node: exp.Expression) -> bool:
    """True iff `node`'s nearest Join/Where/Having/Qualify ancestor is a
    `exp.Join` — i.e. the predicate lives in a JOIN ... ON clause rather than
    a WHERE/HAVING/QUALIFY filter. A JOIN's ON-clause equality (e.g. `mm.
    "DeviceId" = m."Id"`) is STRUCTURAL (it defines how rows are matched
    across tables) and matches every row of the large table exactly once per
    parent row — it is not a selective FILTER that reduces the scanned row
    count, even when it happens to be written against an indexed/FK column.
    Crediting it as one would let a bare `... JOIN "MonitorMeasurements" mm ON
    mm."DeviceId" = m."Id"` with NO other predicate anywhere pass the guard —
    a full unbounded join-scan of the 337M-row table, exactly what this guard
    exists to catch.
    """
    ancestor = node.find_ancestor(exp.Join, exp.Where, exp.Having, exp.Qualify)
    return isinstance(ancestor, exp.Join)


def _has_selective_equality_or_in_predicate(root: exp.Expression, selective_columns: list[str]) -> bool:
    """Fix C: walks the WHOLE statement AST for an `exp.EQ` or `exp.In` node
    whose column operand (unwrapping a CAST, same as `_has_time_bound_predicate`)
    matches (case-insensitive) one of `selective_columns` (a large table's
    indexed/FK/PK bare column names). This is the escape-hatch selective
    predicate that lets a query pass without a time bound when it instead
    filters on a real selective (indexed/FK/PK) column — e.g. `WHERE
    "PatientId" = 42` on a table with no time column configured.

    A predicate living ONLY in a JOIN ... ON clause does not count (see
    `_is_join_on_clause_predicate`) — it is the structural join condition,
    not a row-reducing filter, so it must not let an otherwise-unfiltered
    scan through. A WHERE/HAVING/QUALIFY equality against the same column
    still counts, as does an EQ that also appears (redundantly) in a WHERE
    clause even if a same-shaped EQ exists in a JOIN ON elsewhere.
    """
    if not selective_columns:
        return False
    targets = {c.lower() for c in selective_columns}

    for node in root.walk():
        node = node[0] if isinstance(node, tuple) else node
        if isinstance(node, exp.EQ):
            operands = [node.this, node.expression]
        elif isinstance(node, exp.In):
            operands = [node.this]
        else:
            continue
        if _is_join_on_clause_predicate(node):
            continue
        for operand in operands:
            probe = operand
            if isinstance(probe, exp.Cast):
                probe = probe.this
            if isinstance(probe, exp.Column) and probe.name.lower() in targets:
                return True
    return False


def _table_aliases_by_bare_name(root: exp.Expression) -> dict[str, set[str]]:
    """Maps each bare table name (lowercase) referenced anywhere in the AST to
    every alias it is referenced under (lowercase), INCLUDING its own bare
    name (a table with no alias is referenced by its bare name, so `mm."Id"`
    and `"MonitorMeasurements"."Id"` both resolve). Multiple aliases for the
    same bare name (e.g. the table joined twice under different aliases) are
    all collected — the parent-join check treats any of them as a valid
    qualifier for that table.
    """
    by_bare_name: dict[str, set[str]] = {}
    for table in root.find_all(exp.Table):
        bare = table.name.lower()
        alias = table.alias_or_name.lower()  # falls back to bare name when unaliased
        by_bare_name.setdefault(bare, set()).add(alias)
        by_bare_name[bare].add(bare)
    return by_bare_name


def _join_connects_tables_on_columns(
    root: exp.Expression,
    large_table_aliases: set[str],
    parent_table_aliases: set[str],
    from_columns: list[str],
    to_columns: list[str],
) -> bool:
    """True iff the SQL contains a JOIN ... ON (or an equivalent WHERE-clause
    equality — some dialects/models express an old-style comma-join this way)
    whose equality predicate matches the large table's `from_columns[i]`
    against the parent's `to_columns[i]` for every i, in either operand order.
    Column-name matching is case-insensitive; alias matching uses the
    resolved alias set from `_table_aliases_by_bare_name` so `mm."DeviceId" =
    m."Id"` is recognized regardless of which side of `=` each column is on.
    """
    if not from_columns or len(from_columns) != len(to_columns):
        return False
    pairs = {(f.lower(), t.lower()) for f, t in zip(from_columns, to_columns)}

    def _side_matches(column: exp.Column, aliases: set[str], names: set[str]) -> str | None:
        qualifier = (column.table or "").lower()
        if qualifier and qualifier not in aliases:
            return None
        name = column.name.lower()
        return name if name in names else None

    from_names = {p[0] for p in pairs}
    to_names = {p[1] for p in pairs}

    # Collect every EQ node's column-pair anywhere in the AST (JOIN ... ON is
    # the common case; a comma-join's equivalent WHERE-clause equality is
    # covered for free since this walks the whole tree, same as the other
    # predicate detectors in this module).
    matched_pairs: set[tuple[str, str]] = set()
    for node in root.walk():
        node = node[0] if isinstance(node, tuple) else node
        if not isinstance(node, exp.EQ):
            continue
        left, right = node.this, node.expression
        if not (isinstance(left, exp.Column) and isinstance(right, exp.Column)):
            continue
        left_from = _side_matches(left, large_table_aliases, from_names)
        right_to = _side_matches(right, parent_table_aliases, to_names)
        if left_from and right_to and (left_from, right_to) in pairs:
            matched_pairs.add((left_from, right_to))
            continue
        right_from = _side_matches(right, large_table_aliases, from_names)
        left_to = _side_matches(left, parent_table_aliases, to_names)
        if right_from and left_to and (right_from, left_to) in pairs:
            matched_pairs.add((right_from, left_to))

    return pairs.issubset(matched_pairs)


def _has_parent_join_time_bound(
    root: exp.Expression,
    table_name: str,
    parent_time_bound: ParentTimeBound | None,
) -> bool:
    """Branch (c) of the bounding policy: a large table with no own time
    column (or whose own time bound is absent) is still considered bounded
    when (1) the SQL actually joins it to the configured parent table via the
    exact declared FK columns, AND (2) a time-bound predicate exists on that
    parent's time column, scoped to the parent's alias in THIS query (not
    merely a same-named column somewhere else). Both conditions must hold —
    a parent-table time bound with no matching join present does not bound
    THIS table, and a join with no time bound on the parent does not either.
    """
    if parent_time_bound is None:
        return False

    aliases = _table_aliases_by_bare_name(root)
    large_table_aliases = aliases.get(table_name.lower())
    parent_table_aliases = aliases.get(parent_time_bound.parent_table_name.lower())
    if not large_table_aliases or not parent_table_aliases:
        return False  # parent isn't even referenced in this query — cannot be bounded through it.

    joined = _join_connects_tables_on_columns(
        root,
        large_table_aliases,
        parent_table_aliases,
        parent_time_bound.from_columns,
        parent_time_bound.to_columns,
    )
    if not joined:
        return False

    return _has_time_bound_predicate(
        root, parent_time_bound.parent_time_column, table_aliases=parent_table_aliases
    )


def _repair_hint_for(table: LargeTableSpec, time_column: str | None) -> str:
    """Composes the reject-verdict repair hint for one unbounded table,
    listing every applicable bounding option: (a) its own time column, (b) an
    equality/IN filter on a selective column, and (c) a parent-join time
    bound, when configured. Replaces a former nested-ternary implementation
    with the same set of user-facing messages, plus the new (c) option.
    """
    options: list[str] = []
    if time_column:
        options.append(
            f"a time-bound predicate on {time_column} for {table.quoted_ref or table.table_name} "
            f"(e.g. WHERE {time_column} >= now() - INTERVAL '...')"
        )
    if table.parent_time_bound:
        ptb = table.parent_time_bound
        join_desc = ", ".join(f"{f}={t}" for f, t in zip(ptb.from_columns, ptb.to_columns))
        options.append(
            f"a time-bound predicate on {ptb.parent_table_name}.{ptb.parent_time_column} "
            f"(joined via {join_desc})"
        )
    if table.selective_columns:
        options.append(f"an equality/IN filter on an indexed column (e.g. {table.selective_columns[0]})")

    if not options:
        return (
            f"{table.quoted_ref or table.table_name} is a large table with no known time column configured; "
            "a bounding predicate is required before this query can run."
        )
    if not time_column:
        # Preserve the existing "no known time column configured" prefix wording
        # when there is no OWN time column, even though other options exist.
        prefix = f"{table.quoted_ref or table.table_name} is a large table with no known time column configured; "
        return prefix + ("add " + ", or ".join(options) + ".")
    return f"Add {', or '.join(options)}."


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
    except (ParseError, TokenError) as exc:
        # Fail closed: an unparseable statement cannot be verified bounded,
        # so treat it as a reject rather than silently passing it through —
        # guard_sql runs first in the pipeline and would already have
        # rejected most unparseable input, but this guard must not assume that.
        return CardinalityVerdict(
            ok=False, action="reject", reason=f"SQL failed to parse for cardinality analysis: {exc}"
        )

    referenced_names = _referenced_table_names(root)
    referenced_large_tables = [t for t in large_tables if t.table_name.lower() in referenced_names]

    # Belt-and-suspenders LEXICAL fallback (P0-arch parity): the AST reads table
    # names only from exp.Table FROM/JOIN nodes, so it can MISS a large-table
    # name that appears via an alias/CTE-name/string-literal path the AST does
    # not surface as a Table. The TS guard matches large-table names with a
    # word-boundary regex over stripped SQL, so if the AST found ZERO large
    # tables but the raw SQL word-boundary-matches a known large-table name,
    # treat it as referenced too — this keeps the Python guard AT LEAST as
    # strict as the TS one (enforcing time-bound + LIMIT rather than passing).
    if not referenced_large_tables:
        already = {t.table_name.lower() for t in referenced_large_tables}
        for spec in large_tables:
            if spec.table_name.lower() in already:
                continue
            if _lexical_references_table(sql, spec.table_name):
                referenced_large_tables.append(spec)
                already.add(spec.table_name.lower())

    if not referenced_large_tables:
        return CardinalityVerdict(ok=True, action="pass")

    # A table satisfies the SELECTIVE-predicate policy via ANY of (a) a valid
    # time-bound predicate on its OWN configured required_time_column, (b) a
    # selective equality/IN predicate on one of its indexed/FK/PK columns, or
    # (c) a valid time-bound predicate on a directly-joined PARENT table's
    # time column, reached via the exact FK columns in `parent_time_bound`
    # (large-table-with-no-own-time-column remediation — see module
    # docstring / ParentTimeBound). Only a table satisfying NONE of these is
    # "unbounded".
    unbounded_tables: list[LargeTableSpec] = []
    for table in referenced_large_tables:
        time_column = required_time_column_by_table.get(table.table_name)
        has_time_bound = bool(time_column) and _has_time_bound_predicate(root, time_column)
        if has_time_bound:
            continue
        has_selective_predicate = _has_selective_equality_or_in_predicate(root, table.selective_columns)
        if has_selective_predicate:
            continue
        has_parent_time_bound = _has_parent_join_time_bound(root, table.table_name, table.parent_time_bound)
        if has_parent_time_bound:
            continue
        unbounded_tables.append(table)

    if unbounded_tables:
        names = ", ".join(t.quoted_ref or t.table_name for t in unbounded_tables)
        hints = " ".join(
            _repair_hint_for(t, required_time_column_by_table.get(t.table_name)) for t in unbounded_tables
        )
        return CardinalityVerdict(
            ok=False,
            action="reject",
            reason=f"Unbounded scan of large table(s) {names}: missing a required selective predicate "
            "(a time-bound predicate on the configured time column, or an equality/IN filter on an indexed/FK column).",
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


def _selective_columns_of(table: dict) -> list[str]:
    """Fix C: derive a large table's selective (indexed/FK/PK) bare column
    names from its rendered columns. A column counts as selective when it is
    indexed (`is_indexed`/`isIndexed`), a primary/foreign key
    (`is_foreign_key_or_primary_key`/`isPrimaryKey`), or — for the raw
    camelCase bundle shape, which has no direct FK flag on the column —
    simply `isPrimaryKey`. This deliberately does not require a large
    dataclass rewrite: `RenderedColumn` already carries `is_indexed` +
    `is_foreign_key_or_primary_key` (see retriever.py), and the raw bundle
    column dict already carries `isIndexed`/`isPrimaryKey` from catalog.json.
    """
    selective: list[str] = []
    for col in table.get("columns", []):
        is_selective = (
            col.get("is_indexed")
            or col.get("isIndexed")
            or col.get("is_foreign_key_or_primary_key")
            or col.get("isPrimaryKey")
        )
        if not is_selective:
            continue
        name = col.get("name") or col.get("quoted_name") or col.get("quotedName")
        if name:
            selective.append(_bare_column_name_of(name))
    return selective


def _parent_time_bound_of(table: dict, tables_by_table_id: dict[str, dict]) -> ParentTimeBound | None:
    """Derives a `ParentTimeBound` from a table dict's `time_via`/`timeVia`
    hint (prep/prep/enrich/importance.py `apply_time_via_hints`,
    ceiba_nl2sql.retrieval.retriever's `RenderedTable.time_via`/`TimeVia`).
    Accepts either shape: a `TimeVia`-derived snake_case dict
    (`{"table_id", "column", "from_columns", "to_columns"}`) or the raw
    catalog.json camelCase hint (`{"table", "column", "fromColumns",
    "toColumns"}`). The parent's bare table name is resolved via
    `tables_by_table_id` (keyed by tableId) when the parent is itself among
    the retrieved/rendered tables; otherwise falls back to the tail
    dot-segment of the parent tableId (mirrors `_bare_table_name_of`'s
    tableId fallback) since a hint should still be usable even when the
    parent table wasn't itself recalled into this query's schema context.
    """
    time_via = table.get("time_via") or table.get("timeVia")
    if not time_via:
        return None
    parent_table_id = time_via.get("table_id") or time_via.get("table")
    parent_column = time_via.get("column")
    from_columns = time_via.get("from_columns") or time_via.get("fromColumns") or []
    to_columns = time_via.get("to_columns") or time_via.get("toColumns") or []
    if not parent_table_id or not parent_column or not from_columns or not to_columns:
        return None

    parent_table = tables_by_table_id.get(parent_table_id)
    parent_table_name = _bare_table_name_of(parent_table) if parent_table else parent_table_id.split(".")[-1]

    return ParentTimeBound(
        parent_table_name=parent_table_name,
        parent_time_column=_bare_column_name_of(parent_column),
        from_columns=[_bare_column_name_of(c) for c in from_columns],
        to_columns=[_bare_column_name_of(c) for c in to_columns],
    )


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
    tables_by_table_id = {(t.get("table_id") or t.get("tableId")): t for t in tables if t.get("table_id") or t.get("tableId")}
    for table in tables:
        is_large = table.get("is_large_time_series", table.get("isLargeTimeSeries", False))
        if not is_large:
            continue
        table_name = _bare_table_name_of(table)
        quoted_ref = table.get("quoted_ref") or table.get("quotedRef")
        selective_columns = _selective_columns_of(table)
        parent_time_bound = _parent_time_bound_of(table, tables_by_table_id)
        large_tables.append(
            LargeTableSpec(
                table_name=table_name,
                quoted_ref=quoted_ref,
                selective_columns=selective_columns,
                parent_time_bound=parent_time_bound,
            )
        )
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
