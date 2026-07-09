"""test_sqlguard.py — ceiba_nl2sql.sqltools.guard (NEW module, Phase 1;
docs/PYTHON_NL2SQL_SERVICE_PLAN.md §1.3, §3.1, §3.2). Ports the essential
behavioral contracts of lib/sqlGuard.ts's own test suite so the sqlglot-based
Python guard is proven at LEAST as strict as the TS tokenizer guard on every
documented bypass case, across every SPEC-relevant dialect (duckdb, postgres,
trino).
"""

from __future__ import annotations

import pytest

from ceiba_nl2sql.sqltools.dialect import UnsupportedDialectError, normalize_dialect
from ceiba_nl2sql.sqltools.guard import GuardResult, guard_sql

DIALECTS = ("duckdb", "postgres", "trino")


# ── allowed statement types ─────────────────────────────────────────────────


@pytest.mark.parametrize("dialect", DIALECTS)
@pytest.mark.parametrize(
    "sql",
    [
        "SELECT 1",
        "SELECT * FROM t WHERE x = 1",
        "SELECT * FROM t ORDER BY x LIMIT 10",
        "(SELECT 1)",
        "SELECT 1 UNION SELECT 2",
        "WITH x AS (SELECT 1) SELECT * FROM x",
        "WITH RECURSIVE x AS (SELECT 1) SELECT * FROM x",
        "EXPLAIN SELECT 1",
        "EXPLAIN ANALYZE SELECT 1",
        "SHOW TABLES",
        "DESCRIBE t",
        "DESC t",
        "SELECT 1;",  # trailing semicolon alone is not multi-statement
        "SELECT 'a;b' AS x",  # `;` inside a string literal must not split
        "SELECT '-- not a comment' AS x",  # comment-like text inside a string literal
    ],
)
def test_allowed_statements_pass(sql: str, dialect: str):
    result = guard_sql(sql, dialect=dialect)
    assert result.allowed is True, f"expected allowed, got reason={result.reason!r} for sql={sql!r} dialect={dialect}"


# ── the literal B1 bypass this module exists to close ───────────────────────


@pytest.mark.parametrize("dialect", DIALECTS)
@pytest.mark.parametrize(
    "sql",
    [
        '/* x */ DELETE FROM eclinics."Shared"."Patients"',
        "-- comment\nDELETE FROM t",
        "/* multi\nline\ncomment */ DROP TABLE t",
    ],
)
def test_comment_prefixed_write_is_rejected(sql: str, dialect: str):
    result = guard_sql(sql, dialect=dialect)
    assert result.allowed is False
    assert result.reason is not None


# ── known write/DDL verbs (mirrors lib/sqlGuard.ts KNOWN_WRITE_TYPES) ───────


@pytest.mark.parametrize("dialect", DIALECTS)
@pytest.mark.parametrize(
    "sql,expected_type",
    [
        ("INSERT INTO t VALUES (1)", "INSERT"),
        ("UPDATE t SET x = 1", "UPDATE"),
        ("DELETE FROM t", "DELETE"),
        ("MERGE INTO t USING s ON t.id = s.id WHEN MATCHED THEN UPDATE SET x = 1", "MERGE"),
        ("DROP TABLE t", "DROP"),
        ("ALTER TABLE t ADD COLUMN x INT", "ALTER"),
        ("CREATE TABLE t (x INT)", "CREATE"),
        ("TRUNCATE TABLE t", "TRUNCATE"),
        ("CALL foo()", "CALL"),
        ("EXECUTE foo", "EXECUTE"),
        ("GRANT SELECT ON t TO u", "GRANT"),
        ("REVOKE SELECT ON t FROM u", "REVOKE"),
        ("SET search_path = x", "SET"),
        ("BEGIN", "BEGIN"),
        ("COMMIT", "COMMIT"),
        ("ROLLBACK", "ROLLBACK"),
    ],
)
def test_known_write_ddl_verbs_rejected(sql: str, expected_type: str, dialect: str):
    result = guard_sql(sql, dialect=dialect)
    assert result.allowed is False
    assert result.statement_type == expected_type
    assert expected_type in (result.reason or "")


# ── multi-statement rejection ────────────────────────────────────────────────


@pytest.mark.parametrize("dialect", DIALECTS)
@pytest.mark.parametrize(
    "sql",
    [
        "SELECT 1; DROP TABLE t",
        "SELECT 1; SELECT 2",
        "SELECT 1; -- comment\nDROP TABLE t",
        "DELETE FROM t; SELECT 1",
    ],
)
def test_multiple_statements_rejected(sql: str, dialect: str):
    result = guard_sql(sql, dialect=dialect)
    assert result.allowed is False
    assert "multiple" in (result.reason or "").lower() or "single" in (result.reason or "").lower()


# ── WITH-CTE-embedded write rejection (stronger than lib/sqlGuard.ts's regex) ─


@pytest.mark.parametrize("dialect", DIALECTS)
@pytest.mark.parametrize(
    "sql",
    [
        "WITH x AS (DELETE FROM t RETURNING *) SELECT * FROM x",
        "WITH x AS (INSERT INTO t VALUES (1) RETURNING *) SELECT * FROM x",
        "WITH x AS (UPDATE t SET y = 1 RETURNING *) SELECT * FROM x",
    ],
)
def test_with_clause_embedded_write_rejected(sql: str, dialect: str):
    result = guard_sql(sql, dialect=dialect)
    assert result.allowed is False


# ── empty / degenerate input ─────────────────────────────────────────────────


@pytest.mark.parametrize("sql", ["", "   ", "\n\t"])
def test_empty_input_rejected(sql: str):
    result = guard_sql(sql)
    assert result.allowed is False
    assert result.reason == "No SQL provided."


def test_non_string_input_rejected():
    result = guard_sql(None)  # type: ignore[arg-type]
    assert result.allowed is False


def test_only_comments_rejected():
    result = guard_sql("-- just a comment\n")
    assert result.allowed is False


# ── table-allowlist hook (H25 seam) ─────────────────────────────────────────


def test_table_allowlist_hook_can_reject():
    def deny_all(sql: str, catalog, schema):
        return False, "not on the allowlist"

    result = guard_sql("SELECT 1", table_allowlist=deny_all)
    assert result.allowed is False
    assert result.reason == "not on the allowlist"


def test_table_allowlist_hook_default_is_permissive():
    result = guard_sql("SELECT * FROM some_unknown_table")
    assert result.allowed is True


# ── dialect handling ─────────────────────────────────────────────────────────


def test_unsupported_dialect_raises():
    with pytest.raises(UnsupportedDialectError):
        guard_sql("SELECT 1", dialect="mysql")


def test_normalize_dialect_defaults_to_duckdb():
    assert normalize_dialect(None) == "duckdb"


def test_normalize_dialect_case_insensitive():
    assert normalize_dialect("DuckDB") == "duckdb"
    assert normalize_dialect("  postgres  ") == "postgres"


# ── result shape ─────────────────────────────────────────────────────────────


def test_guard_result_is_frozen_dataclass():
    result = guard_sql("SELECT 1")
    assert isinstance(result, GuardResult)
    with pytest.raises(Exception):
        result.allowed = False  # type: ignore[misc]


# ── P1 SECURITY: filesystem/network table-function denylist ──────────────────


@pytest.mark.parametrize("dialect", DIALECTS)
def test_rejects_read_csv_local_file(dialect):
    """A read-only SELECT that reads a local file (secret exfiltration) is
    rejected by the guard even though its leading verb is SELECT.
    """
    result = guard_sql("SELECT * FROM read_csv('/proc/self/environ')", dialect=dialect)
    assert result.allowed is False
    assert "filesystem/network access" in (result.reason or "").lower()


@pytest.mark.parametrize("dialect", DIALECTS)
def test_rejects_read_parquet_remote_url(dialect):
    """A read-only SELECT that reads a remote URL (SSRF) is rejected."""
    result = guard_sql("SELECT * FROM read_parquet('http://attacker.example/x')", dialect=dialect)
    assert result.allowed is False
    assert "filesystem/network access" in (result.reason or "").lower()


def test_rejects_read_text_read_blob_read_json_glob():
    for sql in (
        "SELECT read_text('/etc/passwd')",
        "SELECT read_blob('/etc/passwd')",
        "SELECT * FROM read_json('/etc/x.json')",
        "SELECT * FROM glob('/etc/*')",
    ):
        assert guard_sql(sql, dialect="duckdb").allowed is False, sql


def test_rejects_copy_to_and_select_into():
    assert guard_sql("COPY (SELECT 1) TO '/tmp/x.csv'", dialect="duckdb").allowed is False
    into = guard_sql("SELECT 1 AS a INTO newtable FROM t", dialect="duckdb")
    assert into.allowed is False


def test_rejects_install_and_load_extension():
    assert guard_sql("INSTALL httpfs", dialect="duckdb").allowed is False
    assert guard_sql("LOAD httpfs", dialect="duckdb").allowed is False


def test_filesystem_denylist_does_not_false_trip_on_benign_select():
    # A column named like a function prefix must not be rejected.
    assert guard_sql("SELECT read_count FROM t", dialect="duckdb").allowed is True
    assert guard_sql("SELECT count(*) FROM orders WHERE ts > now()", dialect="duckdb").allowed is True


# ── P0-arch: WITH-body write verb in a STRING LITERAL (TS-parity lexical fallback) ──


@pytest.mark.parametrize("dialect", DIALECTS)
def test_rejects_with_body_write_verb_in_string_literal(dialect):
    """lib/sqlGuard.ts's WITH-body regex matches a write verb even inside a
    string literal, so the Python guard's lexical fallback rejects the same
    `WITH x AS (SELECT 'DELETE' AS a) SELECT ...` to stay AT LEAST as strict.
    """
    result = guard_sql("WITH x AS (SELECT 'DELETE' AS a) SELECT * FROM x", dialect=dialect)
    assert result.allowed is False
    assert result.statement_type == "WITH"


def test_malformed_sql_unterminated_quote_fails_closed_no_crash():
    """A truncated LLM completion with an unterminated quote raises sqlglot
    TokenError during tokenization (before ParseError). The guard MUST catch it
    and reject (fail closed), never propagate the exception and crash the request.
    """
    from ceiba_nl2sql.sqltools.guard import guard_sql

    bad = 'SELECT * FROM x WHERE "a" >= 1 AND vm."Id < 90 LIMIT 100'  # unterminated "
    result = guard_sql(bad, dialect="duckdb")
    assert result.allowed is False
    assert "parse" in (result.reason or "").lower()
