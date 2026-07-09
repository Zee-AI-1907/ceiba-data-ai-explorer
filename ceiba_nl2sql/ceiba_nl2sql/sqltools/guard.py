"""guard.py — sqlglot-based, dialect-aware, read-only SQL guard (NEW module;
docs/PYTHON_NL2SQL_SERVICE_PLAN.md §1.3, §3.1 `sqltools/guard.py`, §3.2).

This is the Python counterpart the plan recommends as the AUTHORITATIVE
generation-time guard, replacing `lib/sqlGuard.ts`'s hand-written character
tokenizer with a real, dialect-aware SQL parser (`sqlglot`, which — unlike
the parser TS considered and rejected — supports duckdb/postgres/trino). It
is intended to be shared by:

  - the future NL->SQL service's self-repair loop (the `[E] guardSql` step
    `lib/rag/generate.ts` runs today),
  - prep's own exemplar validation (`prep/prep/exemplars.py`, which marks
    exemplars `validated: true`),
  - the eval scorer (once ported, plan §4.1).

`lib/sqlGuard.ts` and its TS `/api/query` re-guard call STAY as-is (plan
§1.3) — this module does not replace that execution-time boundary layer, it
adds a stronger generation-time layer ahead of it. Read-only enforcement
after this module exists is: DB read-only role (primary) -> this guard
(generation-time, sqlglot AST) -> TS tokenizer guard (execution-time
re-guard, unchanged) -> bundle known-tables allowlist.

── SEMANTICS MIRRORED FROM lib/sqlGuard.ts ──────────────────────────────────
  * Allowed leading statement types: SELECT, WITH, EXPLAIN (incl. ANALYZE),
    SHOW, DESCRIBE/DESC.
  * Multiple statements (any non-trailing `;`) are rejected.
  * A `WITH` must resolve to a SELECT and must not contain a write/DDL verb
    ANYWHERE in its body — including inside a CTE (`WITH x AS (DELETE ...)
    SELECT * FROM x`), which a leading-keyword-only classifier would miss.
    sqlglot gives us a real AST to walk for this, which is strictly stronger
    than the TS tokenizer's regex-over-text check for the same case.
  * Comments (line `--` and block `/* */`) never affect classification (a
    leading comment before DELETE must not smuggle it past the guard — this
    was the literal B1 bypass `lib/sqlGuard.ts`'s docstring documents).
  * A string literal containing `;` or comment-like text must not be treated
    as a statement separator or comment.

── WHY A REAL PARSER HERE (UNLIKE lib/sqlGuard.ts) ──────────────────────────
`lib/sqlGuard.ts`'s docstring explains TS avoided a real parser because
node-sql-parser has no Trino dialect and would false-reject valid Trino
constructs. `sqlglot` DOES support `duckdb`, `postgres`, AND `trino`
dialects natively, so that objection does not apply here — real dialect-aware
parsing is strictly stronger than leading-keyword classification (SPEC
document plan §1.3, §3.2).
"""

from __future__ import annotations

import logging
from dataclasses import dataclass

import sqlglot
from sqlglot import expressions as exp
from sqlglot.errors import ParseError

from ceiba_nl2sql.sqltools.dialect import normalize_dialect

# sqlglot logs a WARNING ("... contains unsupported syntax. Falling back to
# parsing as a 'Command'.") whenever a statement it cannot build a typed node
# for falls back to the generic `Command` passthrough — which is the EXPECTED
# and explicitly handled path here for EXPLAIN/SHOW/CALL/EXECUTE on
# postgres/trino (see `_root_type_name_for_reporting` / `guard_sql` below).
# This is not an error condition for this module, so the noisy default
# warning is silenced at import time rather than on every `guard_sql` call.
logging.getLogger("sqlglot").setLevel(logging.ERROR)

# ── allow / deny vocabularies ────────────────────────────────────────────────

# Leading statement types permitted to reach the engine. All are read-only.
# Keys are the upper-cased "statement type" this guard reports in
# `GuardResult.statement_type` — chosen to line up 1:1 with
# lib/sqlGuard.ts's `ALLOWED_STATEMENT_TYPES` strings.
_ALLOWED_STATEMENT_TYPES = frozenset({"SELECT", "WITH", "EXPLAIN", "SHOW", "DESCRIBE", "DESC"})

# Precise, auditable reason strings for the common dangerous verbs — mirrors
# lib/sqlGuard.ts `KNOWN_WRITE_TYPES`, expressed as sqlglot AST node types
# instead of leading keywords so a write verb buried inside a CTE body (not
# just at the statement root) is caught by the same walk.
_WRITE_OR_DDL_EXPRESSION_TYPES: tuple[type, ...] = (
    exp.Insert,
    exp.Update,
    exp.Delete,
    exp.Merge,
    exp.Drop,
    exp.Alter,
    exp.Create,
    exp.TruncateTable,
    exp.Grant,
)

# `Command`-keyword denylist: statements sqlglot cannot parse into a typed
# node at all (CALL, EXECUTE, PREPARE, DEALLOCATE, SET, USE, transaction
# control, REVOKE on some dialects, COMMENT, ANALYZE/REFRESH as DDL-ish
# maintenance ops) — these surface as `Command`/other passthrough nodes whose
# leading keyword we still classify explicitly, matching lib/sqlGuard.ts
# `KNOWN_WRITE_TYPES` verbatim so the reason string names the actual verb.
_KNOWN_WRITE_COMMAND_KEYWORDS = frozenset(
    {
        "INSERT",
        "UPDATE",
        "DELETE",
        "MERGE",
        "DROP",
        "ALTER",
        "CREATE",
        "TRUNCATE",
        "RENAME",
        "CALL",
        "EXECUTE",
        "PREPARE",
        "DEALLOCATE",
        "GRANT",
        "REVOKE",
        "DENY",
        "SET",
        "RESET",
        "USE",
        "START",
        "BEGIN",
        "COMMIT",
        "ROLLBACK",
        "SAVEPOINT",
        "COMMENT",
        "ANALYZE",
        "REFRESH",
    }
)

# Root node types that are unambiguously write/DDL/transaction-control even
# when sqlglot gives them a proper typed node (not a generic Command) —
# folded into the same reporting path as the keyword denylist above.
_WRITE_ROOT_TYPE_TO_KEYWORD: dict[type, str] = {
    exp.Insert: "INSERT",
    exp.Update: "UPDATE",
    exp.Delete: "DELETE",
    exp.Merge: "MERGE",
    exp.Drop: "DROP",
    exp.Alter: "ALTER",
    exp.Create: "CREATE",
    exp.TruncateTable: "TRUNCATE",
    exp.Grant: "GRANT",
    exp.Revoke: "REVOKE",
    exp.Set: "SET",
    exp.Transaction: "BEGIN",
    exp.Commit: "COMMIT",
    exp.Rollback: "ROLLBACK",
}


@dataclass(frozen=True)
class GuardResult:
    """Result of classifying a SQL string. CHECK `allowed` first. Mirrors the
    shape of lib/sqlGuard.ts's `SqlGuardResult`.
    """

    allowed: bool
    reason: str | None = None
    statement_type: str | None = None


TableAllowlistCheck = "Callable[[str, str | None, str | None], tuple[bool, str | None]]"


def _default_table_allowlist(sql: str, catalog: str | None, schema: str | None) -> tuple[bool, str | None]:
    """Default table-allowlist policy: allow everything (permissive seam,
    mirrors lib/sqlGuard.ts `allowAllTables`).
    """
    return True, None


def _root_type_name_for_reporting(node: exp.Expression) -> str | None:
    """Best-effort leading-keyword string for a parsed root node, used only
    for the `statement_type` field / error messages — mirrors the strings
    lib/sqlGuard.ts's `leadingKeyword` would have produced.
    """
    if isinstance(node, exp.Command):
        token = node.this
        return str(token).upper() if token else None
    if isinstance(node, exp.Describe):
        return "DESCRIBE"
    if isinstance(node, exp.Show):
        return "SHOW"
    if isinstance(node, (exp.Select, exp.Union, exp.Subquery)):
        # A `WITH ... SELECT` parses with `.this`/ctes on the Select node
        # itself in sqlglot (no separate top-level With wrapper node), so we
        # detect "WITH" by presence of a `with_` clause rather than node type.
        if node.args.get("with"):
            return "WITH"
        return "SELECT"
    for root_type, keyword in _WRITE_ROOT_TYPE_TO_KEYWORD.items():
        if isinstance(node, root_type):
            return keyword
    return type(node).__name__.upper()


def _contains_write_or_ddl(node: exp.Expression) -> str | None:
    """Walk the full AST of `node` and return the first write/DDL/DML verb
    found ANYWHERE in the tree (not just at the root) — this is what makes a
    `WITH x AS (DELETE FROM t RETURNING *) SELECT * FROM x` rejected even
    though sqlglot's top-level node for the whole statement is a `Select`.
    Returns `None` if no write/DDL node is found.
    """
    for sub_node in node.walk():
        if isinstance(sub_node, _WRITE_OR_DDL_EXPRESSION_TYPES):
            keyword = _WRITE_ROOT_TYPE_TO_KEYWORD.get(type(sub_node))
            if keyword:
                return keyword
            for base_type, kw in _WRITE_ROOT_TYPE_TO_KEYWORD.items():
                if isinstance(sub_node, base_type):
                    return kw
            return type(sub_node).__name__.upper()
        if isinstance(sub_node, exp.Command):
            token = sub_node.this
            keyword = str(token).upper() if token else None
            if keyword in _KNOWN_WRITE_COMMAND_KEYWORDS:
                return keyword
    return None


def guard_sql(
    sql: str,
    *,
    dialect: str | None = None,
    catalog: str | None = None,
    schema: str | None = None,
    table_allowlist: "TableAllowlistCheck | None" = None,
) -> GuardResult:
    """Classify `sql` and decide whether it is a single read-only statement
    safe to forward to the target engine.

    Order of checks (mirrors lib/sqlGuard.ts `guardSql`):
      1. Non-empty after trimming.
      2. Parse with sqlglot in `dialect` (default: duckdb); a hard parse
         failure is treated as a rejection (fail closed — an unparseable
         statement is never assumed safe).
      3. Exactly one non-empty top-level statement (reject multi-statement).
      4. The statement's leading type is in the read-only allowlist
         (SELECT/WITH/EXPLAIN/SHOW/DESCRIBE/DESC).
      5. If WITH: the body resolves to a SELECT AND no write/DDL verb
         appears anywhere in the statement's AST (catches writes nested
         inside a CTE, not just a top-level write).
      6. (Optional) table-allowlist hook passes (H25 seam, mirrors
         lib/sqlGuard.ts's `tableAllowlist` option). Defaults to permissive.

    This is a QUALITY / GENERATION-TIME gate feeding a self-repair loop, not
    the execution security boundary — the DB-side read-only role is the
    primary control, and the TS `/api/query` re-guard (`lib/sqlGuard.ts`)
    remains the execution-time boundary re-guard (plan §1.3). Both facts are
    intentional and mirror the TS guard's own documented posture.
    """
    if not isinstance(sql, str) or sql.strip() == "":
        return GuardResult(allowed=False, reason="No SQL provided.")

    resolved_dialect = normalize_dialect(dialect)

    try:
        statements = sqlglot.parse(sql, read=resolved_dialect)
    except ParseError as exc:
        return GuardResult(allowed=False, reason=f"SQL failed to parse: {exc}")

    # sqlglot returns `None` entries for empty statements (e.g. a trailing
    # `;` or a stray `;;`) and can also emit a bare `Semicolon` separator node
    # when a comment sits between two statements — neither is a real
    # statement, so both are filtered out before counting.
    real_statements = [s for s in statements if s is not None and not isinstance(s, exp.Semicolon)]

    if not real_statements:
        return GuardResult(allowed=False, reason="No executable SQL after stripping comments.")

    if len(real_statements) > 1:
        return GuardResult(
            allowed=False,
            reason="Multiple SQL statements are not allowed. Submit a single read-only query.",
        )

    root = real_statements[0]
    statement_type = _root_type_name_for_reporting(root)

    if not statement_type:
        return GuardResult(allowed=False, reason="Could not identify the SQL statement type.")

    if statement_type not in _ALLOWED_STATEMENT_TYPES:
        is_known_write = (
            statement_type in _KNOWN_WRITE_COMMAND_KEYWORDS
            or statement_type in _WRITE_ROOT_TYPE_TO_KEYWORD.values()
        )
        reason = (
            f"{statement_type} is not permitted. Only read-only queries (SELECT / WITH / "
            "EXPLAIN / SHOW / DESCRIBE) are allowed."
            if is_known_write
            else f"Statement type '{statement_type}' is not permitted. Only read-only queries are allowed."
        )
        return GuardResult(allowed=False, statement_type=statement_type, reason=reason)

    # `Command` nodes (EXPLAIN/SHOW/DESCRIBE on dialects that don't give them
    # a typed node) carry no sub-tree to walk for embedded writes — the
    # keyword check above is already sufficient for those. Only a real
    # parsed `Select`/`Union`/`Subquery`/`Describe`/`Show` node needs the
    # embedded-write walk below (in particular the WITH-CTE case).
    if isinstance(root, exp.Command):
        pass
    elif statement_type == "WITH":
        if not root.args.get("with"):
            return GuardResult(
                allowed=False, statement_type="WITH", reason="A WITH clause must resolve to a SELECT query."
            )
        write_verb = _contains_write_or_ddl(root)
        if write_verb:
            return GuardResult(
                allowed=False,
                statement_type="WITH",
                reason="A WITH clause may not contain a write or DDL statement.",
            )
    else:
        # Even a plain SELECT/Union/Subquery/Describe/Show is walked
        # defensively — sqlglot can embed e.g. a subquery-DML dialect
        # extension inside an otherwise-Select tree in future grammar
        # additions; failing closed here costs nothing on the common case.
        write_verb = _contains_write_or_ddl(root)
        if write_verb:
            return GuardResult(
                allowed=False,
                statement_type=statement_type,
                reason=f"{write_verb} is not permitted. Only read-only queries are allowed.",
            )

    check = table_allowlist or _default_table_allowlist
    allowed, allow_reason = check(root.sql(dialect=resolved_dialect), catalog, schema)
    if not allowed:
        return GuardResult(
            allowed=False,
            statement_type=statement_type,
            reason=allow_reason or "Query references tables outside the allowlist.",
        )

    return GuardResult(allowed=True, statement_type=statement_type)
