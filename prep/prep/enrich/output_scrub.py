"""output_scrub.py — PHI scrubber for arbitrary query-result samples.

LOAD-BEARING SAFETY COMPONENT (HIPAA / KVKK). Given a generated SQL query and a
sample of its executed result rows, this module decides — per OUTPUT column —
whether each cell may be embedded and shipped to an EXTERNAL LLM, or must be
replaced with the sentinel string `"<suppressed>"`. A false-suppress is
harmless (the LLM just sees `<suppressed>`); a false-emit is a PHI leak. The
whole module therefore FAILS CLOSED: anything it cannot positively prove safe
is suppressed.

── phi_columns key format (the contract with Task 7 that builds it) ──────────
`phi_columns` maps a bare `"tablename.columnname"` (BOTH lowercased) to a
phiClass string, one of: "direct-identifier", "quasi-identifier", "free-text",
"non-phi". Only "non-phi" is emittable.

phi.json stores each column's identity as a fully-qualified `columnId`, e.g.
    "staging.Shared.Patients.Name"
Task 7 MUST reduce that to this module's key by taking the LAST TWO
dot-separated segments (the bare table name and the column name), lowercasing
BOTH, and joining with a single ".":
    "staging.Shared.Patients.Name"           -> "patients.name"
    "mock.public.MeasurementTypeRef.name"    -> "measurementtyperef.name"
This mirrors how column lineage is resolved here: sqlglot gives us a source
`(bare_table, column)` pair, which we lowercase and join the same way before
looking it up. A column whose key is ABSENT from `phi_columns` is treated as
UNKNOWN PROVENANCE and suppressed (fail-closed) — never emitted.

── Decision per OUTPUT column (in SELECT order) ──────────────────────────────
1. Parse `sql` with sqlglot (postgres). Any parse failure → suppress ALL cells.
2. Build an alias→bare-table map from every `exp.Table` (alias, or the table's
   own bare name when unaliased → its bare last-segment name). This is the
   authoritative resolver for QUALIFIED columns and does not depend on qualify.
3. Best-effort `qualify(expr, schema=schema)` to attach table qualifiers to
   UNQUALIFIED columns. If qualify raises (e.g. schema keyed by bare name but
   the query uses schema-qualified table refs, so an unqualified column can't
   be bound), we fall back to the un-qualified parse tree — under which an
   unqualified column has no table qualifier, resolves to nothing, and is
   suppressed. Either way, unresolved provenance → suppress.
4. If ANY projection is a bare `*` (`exp.Star`) — we don't know the output
   columns — suppress ALL cells.
5. For each projection expression, keyed to its row by `alias_or_name`:
   a. AGGREGATE handling (`exp.AggFunc` present anywhere in the projection):
        • A pure COUNT projection (every aggregate is `exp.Count` and no bare
          non-aggregated column leaks outside them) is ALWAYS safe: COUNT emits
          a cardinality, never a member cell value.
        • Any OTHER aggregate (min/max/sum/avg/array_agg/string_agg/…) is safe
          ONLY IF every `exp.Column` leaf in the projection resolves to a
          known non-phi source. This is a deliberate hardening over a naive
          "all aggregates are numeric" assumption: `min("Name")` / `max("Name")`
          return a REAL patient name (a member cell), which would be a PHI leak.
   b. NON-AGGREGATE handling: collect the projection's `exp.Column` leaves and
      resolve each to a source `(bare_table.lower(), column.lower())`. Safe iff
      there is EXACTLY ONE distinct fully-resolved source column AND its
      phiClass is exactly "non-phi". Every other case suppresses: ≥2 distinct
      source columns (e.g. `a + b`), zero resolvable sources, an unresolved
      column (unknown alias / unqualified), a PHI phiClass, or a source column
      missing from `phi_columns` (unknown provenance).
6. Match each projection to its row cell by `alias_or_name`. A row key not
   covered by a proven-safe projection is suppressed. When two projections
   share an output name with conflicting verdicts, SUPPRESS wins.

No DB, no network: a pure function over the SQL string, the row dicts, the
phiClass map, and the schema.
"""

from __future__ import annotations

import copy

import sqlglot
from sqlglot import exp
from sqlglot.optimizer.qualify import qualify

# The sentinel written into every suppressed cell. Kept as a module constant so
# callers and the PHI gate can reference the exact string rather than re-typing
# a literal that must stay in sync.
SUPPRESSED = "<suppressed>"

# phiClass values that are safe to emit. Only truly non-PHI cells may leave.
_EMITTABLE_PHI_CLASSES = frozenset({"non-phi"})


def scrub_output_sample(
    sql: str,
    rows: list[dict],
    phi_columns: dict[str, str],
    schema: dict[str, dict[str, str]],
    sample_rows: int = 5,
    dialect: str = "postgres",
) -> list[dict]:
    """Truncate `rows` to `sample_rows` and replace every cell that cannot be
    proven safe to emit with the string `SUPPRESSED` (`"<suppressed>"`).

    Args:
        sql: the executed query (dialect defaults to postgres).
        rows: executed result rows as dicts; each dict key is the OUTPUT column
            name the DB returned (each projection's alias-or-name).
        phi_columns: `{"table.column"(lowercased): phiClass}`; see the module
            docstring for the exact key format Task 7 must produce.
        schema: `{bareTable: {column: type}}`, for sqlglot `qualify`.
        sample_rows: max rows to return.
        dialect: sqlglot dialect for parsing/qualifying.

    Returns:
        A new list of new dicts (inputs are never mutated), truncated to
        `sample_rows`, with unsafe cells set to `SUPPRESSED`.
    """
    sampled_rows = rows[:sample_rows]

    safe_output_names = _compute_safe_output_names(sql, phi_columns, schema, dialect)

    scrubbed_rows: list[dict] = []
    for row in sampled_rows:
        scrubbed_rows.append(
            {
                output_name: (
                    cell_value
                    if output_name in safe_output_names
                    else SUPPRESSED
                )
                for output_name, cell_value in row.items()
            }
        )
    return scrubbed_rows


def _compute_safe_output_names(
    sql: str,
    phi_columns: dict[str, str],
    schema: dict[str, dict[str, str]],
    dialect: str,
) -> set[str]:
    """Return the set of OUTPUT column names (projection `alias_or_name`s) that
    are proven safe to emit. Everything not in this set is suppressed. On ANY
    doubt — parse failure, `SELECT *`, an unresolved column — a name is left
    out of the set (fail closed)."""
    try:
        parsed = sqlglot.parse_one(sql, dialect=dialect)
    except Exception:
        # Unparseable SQL: we cannot reason about provenance → suppress all.
        return set()
    if parsed is None:
        return set()

    alias_to_bare_table = _build_alias_map(parsed)

    # Best-effort qualification to bind unqualified columns. It may raise when
    # the schema (keyed by bare table name) can't be matched to schema-qualified
    # table refs; in that case we keep the un-qualified tree and let unqualified
    # columns resolve to nothing (→ suppressed).
    resolution_tree = parsed
    try:
        resolution_tree = qualify(copy.deepcopy(parsed), schema=schema, dialect=dialect)
    except Exception:
        resolution_tree = parsed

    select = resolution_tree.find(exp.Select)
    if select is None:
        return set()

    projections = select.expressions

    # A bare `SELECT *` / `SELECT t.*` means we don't know the output columns →
    # suppress all. (A `*` that is an aggregate ARGUMENT, e.g. `count(*)`, is
    # NOT a select-star and must not trip this guard.)
    for projection in projections:
        if _projection_is_select_star(projection):
            return set()

    safe_names: set[str] = set()
    suppressed_names: set[str] = set()
    for projection in projections:
        output_name = projection.alias_or_name
        if not output_name:
            # No usable output name to match against a row key → nothing to emit.
            continue
        if _projection_is_safe(projection, alias_to_bare_table, phi_columns):
            safe_names.add(output_name)
        else:
            suppressed_names.add(output_name)

    # SUPPRESS wins on any output-name collision between projections.
    return safe_names - suppressed_names


def _projection_is_safe(
    projection: exp.Expression,
    alias_to_bare_table: dict[str, str],
    phi_columns: dict[str, str],
) -> bool:
    """Decide whether a single SELECT projection may emit its real value."""
    aggregate_funcs = list(projection.find_all(exp.AggFunc))
    if aggregate_funcs:
        return _aggregate_projection_is_safe(
            projection, aggregate_funcs, alias_to_bare_table, phi_columns
        )

    # Non-aggregate: exactly one distinct, fully-resolved, non-phi source column.
    resolved_sources, any_unresolved = _resolve_source_columns(
        projection, alias_to_bare_table
    )
    if any_unresolved:
        return False
    if len(resolved_sources) != 1:
        return False
    (source_column,) = tuple(resolved_sources)
    return _phi_class_is_emittable(source_column, phi_columns)


def _aggregate_projection_is_safe(
    projection: exp.Expression,
    aggregate_funcs: list[exp.Expression],
    alias_to_bare_table: dict[str, str],
    phi_columns: dict[str, str],
) -> bool:
    """Aggregate projections. Columns are of two kinds:

      • COUNT arguments — `count(x)` reduces `x` to a cardinality and can never
        emit a member cell, so a COUNT's argument column is always safe (even
        `count("Name")` is just a number).
      • VALUE-EXPOSING columns — a column that is a bare projection member
        (alongside an aggregate, e.g. `count(*) || "Name"`) or an argument to a
        NON-COUNT aggregate (`min("Name")`, `max("Name")`, `array_agg("Name")`,
        `sum`, `avg`, …). These can surface a real member value derived from the
        column, so every one must resolve to a known non-phi source.

    Safe iff there are no unresolved value-exposing columns and every resolved
    value-exposing column is non-phi. (A pure `count(*)` has neither kind → safe.)
    """
    value_exposing_sources, any_unresolved = _resolve_value_exposing_columns(
        projection, alias_to_bare_table
    )
    if any_unresolved:
        return False
    return all(
        _phi_class_is_emittable(source, phi_columns)
        for source in value_exposing_sources
    )


def _resolve_value_exposing_columns(
    projection: exp.Expression,
    alias_to_bare_table: dict[str, str],
) -> tuple[set[tuple[str, str]], bool]:
    """Like `_resolve_source_columns`, but skips columns that are arguments to a
    COUNT aggregate (those only feed a cardinality and never expose a value).
    Returns `(resolved_value_exposing_sources, any_unresolved)`."""
    resolved_sources: set[tuple[str, str]] = set()
    any_unresolved = False
    for column in projection.find_all(exp.Column):
        if _column_is_inside_count(column, projection):
            continue
        qualifier = column.table
        bare_table = (
            alias_to_bare_table.get(qualifier.lower()) if qualifier else None
        )
        if bare_table is None:
            any_unresolved = True
            continue
        resolved_sources.add((bare_table.lower(), column.name.lower()))
    return resolved_sources, any_unresolved


def _column_is_inside_count(
    column: exp.Expression, projection_root: exp.Expression
) -> bool:
    """True if `column` sits inside a `COUNT(...)` somewhere between itself and
    the projection root — i.e. it is a COUNT argument, not a value-exposing
    column."""
    node = column.parent
    while node is not None:
        if isinstance(node, exp.Count):
            return True
        if node is projection_root:
            break
        node = node.parent
    return False


def _projection_is_select_star(projection: exp.Expression) -> bool:
    """True for a `SELECT *` (`exp.Star`) or a qualified `SELECT t.*`
    (`exp.Column` wrapping a `Star`). A `*` that is an aggregate argument such
    as `count(*)` is NOT a select-star (its Star is nested under the AggFunc)."""
    if isinstance(projection, exp.Star):
        return True
    if isinstance(projection, exp.Column) and isinstance(projection.this, exp.Star):
        return True
    return False


def _resolve_source_columns(
    projection: exp.Expression,
    alias_to_bare_table: dict[str, str],
) -> tuple[set[tuple[str, str]], bool]:
    """Resolve every `exp.Column` leaf of `projection` to a source
    `(bare_table.lower(), column.lower())`.

    Returns `(resolved_sources, any_unresolved)`. `any_unresolved` is True if
    any column leaf lacks a table qualifier or whose qualifier isn't a known
    FROM/JOIN source — i.e. we could not pin its provenance."""
    resolved_sources: set[tuple[str, str]] = set()
    any_unresolved = False
    for column in projection.find_all(exp.Column):
        qualifier = column.table
        bare_table = (
            alias_to_bare_table.get(qualifier.lower()) if qualifier else None
        )
        if bare_table is None:
            any_unresolved = True
            continue
        resolved_sources.add((bare_table.lower(), column.name.lower()))
    return resolved_sources, any_unresolved


def _phi_class_is_emittable(
    source_column: tuple[str, str],
    phi_columns: dict[str, str],
) -> bool:
    """A source `(bare_table, column)` is emittable iff it is present in
    `phi_columns` (known provenance) AND its phiClass is exactly "non-phi"."""
    bare_table, column_name = source_column
    key = f"{bare_table}.{column_name}"
    phi_class = phi_columns.get(key)
    if phi_class is None:
        # Unknown provenance → fail closed.
        return False
    return phi_class in _EMITTABLE_PHI_CLASSES


def _build_alias_map(tree: exp.Expression) -> dict[str, str]:
    """Map every identifier used to qualify a column (an alias, or the bare
    table name when the table is unaliased) to that table's bare last-segment
    name. Lowercased keys. Mirrors join_check._build_alias_map."""
    alias_to_bare_table: dict[str, str] = {}
    for table in tree.find_all(exp.Table):
        bare_table_name = table.name
        qualifying_identifier = table.alias_or_name or bare_table_name
        if qualifying_identifier:
            alias_to_bare_table[qualifying_identifier.lower()] = bare_table_name
    return alias_to_bare_table
