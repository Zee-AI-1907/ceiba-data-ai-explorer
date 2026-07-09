"""test_explain.py — POST /nl2sql/explain (docs/PYTHON_NL2SQL_SERVICE_PLAN.md
§2.2: "dry-run validate ... Returns { ok: true, plan } | { ok: false, error
}"). Never executes — asserts the "explain, never execute" guarantee by
construction (this endpoint never calls engine.execute()).
"""

from __future__ import annotations


async def test_explain_accepts_valid_select(client, auth_headers):
    response = await client.post(
        "/nl2sql/explain", json={"sql": 'SELECT * FROM mock.public."VisitMock"'}, headers=auth_headers
    )
    assert response.status_code == 200
    body = response.json()
    assert body["ok"] is True
    assert body["plan"]


async def test_explain_rejects_write_statement(client, auth_headers):
    response = await client.post(
        "/nl2sql/explain", json={"sql": 'DROP TABLE mock.public."MeasurementsMock"'}, headers=auth_headers
    )
    assert response.status_code == 200
    body = response.json()
    assert body["ok"] is False
    assert "not permitted" in body["error"].lower() or "read-only" in body["error"].lower() or "drop" in body["error"].lower()


async def test_explain_rejects_multi_statement(client, auth_headers):
    response = await client.post(
        "/nl2sql/explain", json={"sql": "SELECT 1; SELECT 2"}, headers=auth_headers
    )
    assert response.status_code == 200
    body = response.json()
    assert body["ok"] is False


async def test_explain_reports_bind_error_for_unknown_column(client, auth_headers):
    response = await client.post(
        "/nl2sql/explain",
        json={"sql": 'SELECT "NoSuchColumn" FROM mock.public."MeasurementsMock"'},
        headers=auth_headers,
    )
    assert response.status_code == 200
    body = response.json()
    assert body["ok"] is False
    assert body["error"]
