"""limit.py — universal default-LIMIT guard (P2 Task 1/2).

The cardinality guard only appends a LIMIT for `is_large_time_series` tables it
already bounded; a full scan of any OTHER table can still return unbounded rows,
relying on the advisory prompt line the model may ignore. This guard closes that
gap deterministically: it runs on every candidate (after the cardinality guard,
before EXPLAIN) and appends a default LIMIT when the OUTERMOST query has none —
EXCEPT where doing so would be pointless or unsafe:

  - pure scalar aggregate (aggregate function(s), no GROUP BY -> provably <=1
    row): pass, a LIMIT is noise;
  - GROUP BY WITHOUT ORDER BY: **reject** -> self-repair. Appending a LIMIT to an
    unordered rollup returns an arbitrary subset of groups with no error — the
    worst failure class for a clinical tool. Forcing the model to add an ORDER BY
    yields a deterministic, intentional top-N instead.
  - GROUP BY WITH ORDER BY, or a plain non-aggregate SELECT: append the LIMIT.

Only the OUTERMOST query is inspected — a LIMIT (or GROUP BY) inside a CTE or
subquery does not bound/shape the outer result set, so subqueries are never
touched (protects NOT EXISTS, windowed subqueries, the scalar-over-grouped shape).
Returns a `CardinalityVerdict` so the pipeline consumes it exactly like the
cardinality guard's verdict.
"""
from __future__ import annotations

import sqlglot
from sqlglot import expressions as exp
from sqlglot.errors import ParseError, TokenError

from ceiba_nl2sql.guard.cardinality import CardinalityVerdict, _append_limit, _is_numeric_limit
from ceiba_nl2sql.sqltools.dialect import normalize_dialect


def _is_pure_scalar_aggregate(select: exp.Select) -> bool:
    """True iff the outer SELECT has an aggregate in its projection list and no
    GROUP BY — i.e. it returns exactly one row regardless of input size. Only
    the projection expressions are inspected (not FROM/WHERE), so an aggregate
    living in a scalar subquery does not misclassify the outer query.
    """
    if select.args.get("group") is not None:
        return False
    return any(projection.find(exp.AggFunc) is not None for projection in select.expressions)


def enforce_default_limit(
    sql: str, *, default_limit: int = 1000, dialect: str | None = None
) -> CardinalityVerdict:
    """Append a default LIMIT to an otherwise-unbounded outer query, or reject a
    LIMIT-less unordered GROUP BY so the model repairs it into a deterministic
    top-N. Never mutates subqueries. Defers (pass) on anything it cannot safely
    classify (parse error, non-SELECT root), leaving the authoritative EXPLAIN
    step to catch genuine problems.
    """
    resolved_dialect = normalize_dialect(dialect)
    try:
        root = sqlglot.parse_one(sql, read=resolved_dialect)
    except (ParseError, TokenError):
        return CardinalityVerdict(ok=True, action="pass")

    if not isinstance(root, exp.Select):
        # UNION/INTERSECT/etc. — no single outer GROUP BY/ORDER BY to reason
        # about; leave it to EXPLAIN + the cardinality guard.
        return CardinalityVerdict(ok=True, action="pass")

    if _is_numeric_limit(root.args.get("limit")):
        return CardinalityVerdict(ok=True, action="pass")

    if _is_pure_scalar_aggregate(root):
        return CardinalityVerdict(ok=True, action="pass")

    has_group_by = root.args.get("group") is not None
    has_order_by = root.args.get("order") is not None

    if has_group_by and not has_order_by:
        return CardinalityVerdict(
            ok=False,
            action="reject",
            reason="Grouped query has no ORDER BY and no LIMIT; appending a LIMIT would return an "
            "arbitrary subset of groups (silent wrong answer).",
            repair_hint="Add an ORDER BY expressing the ranking you want, then a LIMIT (e.g. the top-N "
            "groups); or, if you truly want every group, keep it unlimited and it will be capped at the "
            "execution layer.",
        )

    repaired_sql = _append_limit(sql, default_limit)
    return CardinalityVerdict(
        ok=True,
        action="repair",
        repaired_sql=repaired_sql,
        repair_hint=f"Missing LIMIT; a LIMIT {default_limit} was appended automatically.",
        reason="Query had no row limit; repaired by appending a default LIMIT.",
    )
