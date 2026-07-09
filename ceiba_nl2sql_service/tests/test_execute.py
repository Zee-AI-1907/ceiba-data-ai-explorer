"""test_execute.py — POST /nl2sql/execute (docs/PYTHON_NL2SQL_SERVICE_PLAN.md
§2.2, §2.3: "execution moves to Python ... DuckDB ATTACH read-only + guard
re-check + row cap + deadline"). Hermetic: runs against the seeded in-memory
mock DuckDB attach (no live Postgres needed), and asserts writes are
rejected by the service-side re-guard even though this endpoint is not the
primary security boundary (§1.3 — the TS `/api/query` route's guardSql
already ran before this call in production; this is defense in depth).
"""

from __future__ import annotations


async def test_execute_runs_read_only_select(client, auth_headers):
    response = await client.post(
        "/nl2sql/execute",
        json={"sql": 'SELECT * FROM mock.public."VisitMock"', "maxRows": 10},
        headers=auth_headers,
    )
    assert response.status_code == 200
    body = response.json()
    assert body["truncated"] is False
    assert body["rowCount"] == 1
    assert {c["name"] for c in body["columns"]} >= {"visitRef", "patientRef"}


async def test_execute_truncates_at_max_rows(client, auth_headers):
    response = await client.post(
        "/nl2sql/execute",
        json={"sql": 'SELECT * FROM mock.public."MeasurementsMock"', "maxRows": 1},
        headers=auth_headers,
    )
    assert response.status_code == 200
    body = response.json()
    assert body["rowCount"] == 1
    assert body["truncated"] is True


async def test_execute_rejects_write_statement(client, auth_headers):
    response = await client.post(
        "/nl2sql/execute",
        json={"sql": 'DELETE FROM mock.public."VisitMock"'},
        headers=auth_headers,
    )
    assert response.status_code == 422
    body = response.json()
    assert body["error"]["kind"] == "guard"


async def test_execute_rejects_ddl_statement(client, auth_headers):
    response = await client.post(
        "/nl2sql/execute",
        json={"sql": 'DROP TABLE mock.public."VisitMock"'},
        headers=auth_headers,
    )
    assert response.status_code == 422
    body = response.json()
    assert body["error"]["kind"] == "guard"


async def test_execute_never_leaks_raw_duckdb_error_detail(client, auth_headers):
    """A malformed-but-guard-passing SELECT (unknown column) fails at
    DuckDB's bind step; the service must scrub the raw exception (H20
    discipline) and return only a generic engine-kind error + correlationId.
    """
    response = await client.post(
        "/nl2sql/execute",
        json={"sql": 'SELECT "NoSuchColumn" FROM mock.public."VisitMock"'},
        headers=auth_headers,
    )
    assert response.status_code == 502
    body = response.json()
    assert body["error"]["kind"] == "engine"
    assert "NoSuchColumn" not in body["error"]["message"]
    assert body["error"]["detail"]["correlationId"]
