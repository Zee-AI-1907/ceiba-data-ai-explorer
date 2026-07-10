"""join_check.py — structural join validator: joins ⊆ declared FK edges.

Gate for the exemplar-generation pipeline (SEMANTIC_HINTS.md / exemplar
factory): an LLM- or template-generated SQL exemplar is only trustworthy if
every JOIN it emits is backed by a REAL edge in the bundle's join graph
(`joingraph.json`). Without this gate, an exemplar can silently invent a join
on a column-name coincidence that isn't actually an FK relationship — e.g.
`ON a."ExternalId" = b."ExternalId"` where both tables happen to have an
`ExternalId` column but no declared (or inferred) edge actually connects them.
This module is a pure function over a SQL string + the joingraph edges: no DB,
no network, safe to run at prep-build time on every candidate exemplar.

── Algorithm ─────────────────────────────────────────────────────────────
1. Parse `sql` with sqlglot (`dialect`, default "postgres").
2. Build an alias→bare-table-name map from every `exp.Table` in the query
   (covers the FROM source and every JOIN source): the key is whatever
   identifier is used to QUALIFY a column in the query (the alias if the
   table has one, else the table's own bare name); the value is the table's
   bare name (last segment, as written in the SQL — e.g. `"Acceptances"`,
   not `staging.Shared.Acceptances`).
3. Build the set of DECLARED unordered column pairs from `edges`: each edge's
   `from`/`to` ids are reduced to their bare (last-dot-segment) table name,
   and each `fromColumns[i]`/`toColumns[i]` pair (zipped positionally, so
   composite FKs are supported) becomes one declared pair
   `frozenset({(bareFrom, fromCol), (bareTo, toCol)})`, all lower-cased.
4. For every `exp.Join` node's ON condition, split top-level `AND`s into
   equality conjuncts. For each conjunct that is an `exp.EQ` between two
   `exp.Column` nodes: resolve each side's qualifier through the alias map to
   its bare table name, then check whether the unordered, lower-cased pair
   `{(tableA, colA), (tableB, colB)}` is a member of the declared set.
     - A conjunct that is NOT an equality (range join, function, `OR`, …) is
       ignored — it isn't asserting an FK-style join and isn't this
       validator's concern.
     - An equality where either side isn't a plain column (a literal, a
       computed expression, …) is ignored — it's a filter, not a join.
     - An equality where both sides resolve to the SAME table (self-column,
       e.g. a stray `a."Foo" = a."Bar"` tacked onto an ON clause) is ignored
       — it doesn't assert a cross-table relationship.
     - An equality where a side's table qualifier can't be resolved at all
       (empty qualifier, or an alias that doesn't match any FROM/JOIN source)
       is FAILED CLOSED as a violation: we can't verify it's a declared edge,
       so we don't give it the benefit of the doubt.
     - Everything else that doesn't match a declared pair is a violation.
5. Return `(len(violations) == 0, violations)`, where each violation is the
   offending equality conjunct's own SQL text (`predicate.sql()`) — NOT the
   whole (possibly multi-conjunct) ON clause.
"""

from __future__ import annotations

from collections.abc import Iterator

import sqlglot
from sqlglot import exp


def join_predicates_are_declared(
    sql: str, edges: list[dict], dialect: str = "postgres"
) -> tuple[bool, list[str]]:
    """Check that every equality JOIN predicate in `sql` is backed by a
    declared join-graph edge in `edges`.

    Returns `(ok, violating_predicate_strings)`: `ok` is True iff every
    equality JOIN predicate found matches some edge; `violating_predicate_strings`
    holds the SQL text of each offending predicate (empty when `ok`).
    """
    tree = sqlglot.parse_one(sql, dialect=dialect)
    alias_to_bare_table = _build_alias_map(tree)
    declared_column_pairs = _build_declared_pairs(edges)

    violations: list[str] = []
    for join in tree.find_all(exp.Join):
        on_condition = join.args.get("on")
        if on_condition is None:
            continue
        for conjunct in _flatten_and_conjuncts(on_condition):
            if not isinstance(conjunct, exp.EQ):
                continue  # non-equality ON condition — not this validator's concern
            left, right = conjunct.left, conjunct.right
            if not (isinstance(left, exp.Column) and isinstance(right, exp.Column)):
                continue  # equality involving a literal/expression — a filter, not a join

            left_table = alias_to_bare_table.get(left.table.lower()) if left.table else None
            right_table = (
                alias_to_bare_table.get(right.table.lower()) if right.table else None
            )
            if left_table is None or right_table is None:
                # Unresolvable qualifier: fail closed rather than silently accept.
                violations.append(conjunct.sql())
                continue
            if left_table.lower() == right_table.lower():
                continue  # self-column comparison — not a cross-table join

            predicate_pair = frozenset(
                {
                    (left_table.lower(), left.name.lower()),
                    (right_table.lower(), right.name.lower()),
                }
            )
            if predicate_pair not in declared_column_pairs:
                violations.append(conjunct.sql())

    return (len(violations) == 0, violations)


def _build_alias_map(tree: exp.Expression) -> dict[str, str]:
    """Map every identifier used to qualify a column (alias, or bare table
    name when unaliased) to that table's bare (last-segment) name."""
    alias_to_bare_table: dict[str, str] = {}
    for table in tree.find_all(exp.Table):
        bare_table_name = table.name
        qualifying_identifier = table.alias_or_name or bare_table_name
        if qualifying_identifier:
            alias_to_bare_table[qualifying_identifier.lower()] = bare_table_name
    return alias_to_bare_table


def _build_declared_pairs(edges: list[dict]) -> set[frozenset[tuple[str, str]]]:
    """Reduce joingraph edges to the set of declared unordered
    `{(bareTable, column), (bareTable, column)}` pairs, lower-cased."""
    declared_pairs: set[frozenset[tuple[str, str]]] = set()
    for edge in edges:
        bare_from_table = _bare_table_name(str(edge.get("from", "")))
        bare_to_table = _bare_table_name(str(edge.get("to", "")))
        from_columns = edge.get("fromColumns") or []
        to_columns = edge.get("toColumns") or []
        for from_column, to_column in zip(from_columns, to_columns):
            declared_pairs.add(
                frozenset(
                    {
                        (bare_from_table.lower(), str(from_column).lower()),
                        (bare_to_table.lower(), str(to_column).lower()),
                    }
                )
            )
    return declared_pairs


def _bare_table_name(full_table_id: str) -> str:
    """`"s.Shared.Acceptances"` -> `"Acceptances"` (last dot-segment)."""
    return full_table_id.rsplit(".", 1)[-1] if full_table_id else full_table_id


def _flatten_and_conjuncts(node: exp.Expression) -> Iterator[exp.Expression]:
    """Yield the leaf conjuncts of a top-level AND chain (does not descend
    through OR — an OR'd condition is treated as a single non-EQ leaf)."""
    if isinstance(node, exp.And):
        yield from _flatten_and_conjuncts(node.left)
        yield from _flatten_and_conjuncts(node.right)
    else:
        yield node
