"""test_routing.py — single-source detection + native-passthrough rewrite
(ceiba_nl2sql.sqltools.routing; docs/research/DUCKDB_PUSHDOWN.md §5.1).

These are pure/parse-only tests — no DB. They pin the routing DECISION (which
queries are single-source and get the postgres_query() passthrough) and the
rewrite (catalog qualifier stripped, transpiled to postgres), which is the
performance-critical fix for the multi-hop federation timeout.
"""

from __future__ import annotations

from ceiba_nl2sql.sqltools.routing import analyze_single_source


def test_single_catalog_query_is_routed_and_rewritten():
    sql = 'SELECT count(*) FROM pg."Shared"."Monitors" m WHERE m."Id" > 1'
    result = analyze_single_source(sql, dialect="duckdb")
    assert result is not None
    assert result.alias == "pg"
    assert result.remote_dialect == "postgres"
    # catalog qualifier stripped; schema+table preserved
    assert "pg." not in result.remote_sql
    assert '"Shared"."Monitors"' in result.remote_sql


def test_multi_hop_single_catalog_join_is_single_source():
    # The canonical HR query: 3 tables, all on catalog `pg` -> single source.
    sql = (
        'SELECT count(DISTINCT a."PatientId") '
        'FROM pg."Shared"."MonitorMeasurements" mm '
        'JOIN pg."Shared"."Monitors" m ON mm."DeviceId" = m."Id" '
        'JOIN pg."Shared"."Acceptances" a ON m."AcceptanceId" = a."Id" '
        'WHERE mm."MeasurementTypeId" = 2 AND mm."Value" > 120'
    )
    result = analyze_single_source(sql, dialect="duckdb")
    assert result is not None
    assert result.alias == "pg"
    assert "pg." not in result.remote_sql


def test_two_catalogs_is_not_single_source():
    sql = (
        'SELECT * FROM a."S"."T1" t1 '
        'JOIN b."S"."T2" t2 ON t1."k" = t2."k"'
    )
    assert analyze_single_source(sql, dialect="duckdb") is None


def test_no_qualified_catalog_falls_back():
    # Unqualified tables give us no source to route to -> None (federated path).
    sql = 'SELECT * FROM "Shared"."Monitors"'
    assert analyze_single_source(sql, dialect="duckdb") is None


def test_multi_statement_falls_back():
    sql = 'SELECT 1 FROM pg.s.t; SELECT 2 FROM pg.s.t'
    assert analyze_single_source(sql, dialect="duckdb") is None


def test_unparseable_sql_fails_closed():
    assert analyze_single_source('SELECT FROM WHERE (', dialect="duckdb") is None


def test_empty_sql_returns_none():
    assert analyze_single_source("", dialect="duckdb") is None
    assert analyze_single_source("   ", dialect="duckdb") is None


def test_interval_and_now_transpile_to_postgres():
    # DuckDB `now() - INTERVAL '3 hours'` must survive transpilation to postgres
    # (this exact expression is what timed out federated; the passthrough relies
    # on a faithful rewrite).
    sql = (
        'SELECT m."Id" FROM pg."Shared"."Monitors" m '
        "WHERE m.\"MeasuredDate\" >= now() - INTERVAL '3 hours'"
    )
    result = analyze_single_source(sql, dialect="duckdb")
    assert result is not None
    lowered = result.remote_sql.lower()
    assert "now()" in lowered
    assert "interval" in lowered
