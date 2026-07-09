"""test_auth.py — internal service auth (docs/PYTHON_NL2SQL_SERVICE_PLAN.md
§2.1: "The FastAPI app rejects any request without the exact token
(constant-time compare) with 401"). Every protected route (/nl2sql/generate,
/nl2sql/execute, /nl2sql/explain) is exercised.
"""

from __future__ import annotations

import pytest


@pytest.mark.parametrize(
    "method,path,body",
    [
        ("POST", "/nl2sql/generate", {"question": "x", "tenantId": "org_1"}),
        ("POST", "/nl2sql/execute", {"sql": "SELECT 1", "tenantId": "org_1"}),
        ("POST", "/nl2sql/explain", {"sql": "SELECT 1"}),
    ],
)
async def test_missing_token_is_rejected_401(client, method, path, body):
    response = await client.request(method, path, json=body)
    assert response.status_code == 401


async def test_malformed_authorization_header_is_rejected_401(client):
    response = await client.post(
        "/nl2sql/explain", json={"sql": "SELECT 1"}, headers={"Authorization": "NotBearer abc"}
    )
    assert response.status_code == 401


async def test_wrong_token_is_rejected_401(client):
    response = await client.post(
        "/nl2sql/explain", json={"sql": "SELECT 1"}, headers={"Authorization": "Bearer wrong-token"}
    )
    assert response.status_code == 401


async def test_correct_token_is_accepted(client, auth_headers):
    response = await client.post("/nl2sql/explain", json={"sql": "SELECT 1"}, headers=auth_headers)
    assert response.status_code == 200


async def test_unconfigured_token_fails_closed(monkeypatch: pytest.MonkeyPatch, client, auth_headers):
    """If NL2SQL_SERVICE_TOKEN is unset in this process's env, the service
    must reject EVERY request — even one bearing what would otherwise be a
    valid-looking token — rather than silently becoming open to any caller.
    """
    monkeypatch.delenv("NL2SQL_SERVICE_TOKEN", raising=False)
    response = await client.post("/nl2sql/explain", json={"sql": "SELECT 1"}, headers=auth_headers)
    assert response.status_code == 401
