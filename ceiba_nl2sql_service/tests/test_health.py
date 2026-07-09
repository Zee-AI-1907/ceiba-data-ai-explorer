"""test_health.py — GET /healthz, GET /readyz
(docs/PYTHON_NL2SQL_SERVICE_PLAN.md §2.2, §9 Phase 2 DoD "/readyz green on
fixture bundle"). Both are UNAUTHENTICATED (§7.2: orchestration probes must
not need the service token) and are exercised with and without a valid
AppState.
"""

from __future__ import annotations

import pytest
from httpx import ASGITransport, AsyncClient

from ceiba_nl2sql_service.app import app
from ceiba_nl2sql_service.deps import AppState


async def test_healthz_responds_ok_even_without_appstate():
    """/healthz is pure liveness — no DB touch, no dependency on AppState —
    so it must respond 200 even if the bundle/engine never loaded.
    """
    app.state.nl2sql = None
    app.state.nl2sql_error = "not loaded (test)"
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as client:
        response = await client.get("/healthz")
    assert response.status_code == 200
    assert response.json() == {"status": "ok"}


async def test_healthz_requires_no_auth_header():
    app.state.nl2sql = None
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as client:
        response = await client.get("/healthz")
    assert response.status_code == 200


async def test_readyz_reports_not_ready_without_appstate():
    app.state.nl2sql = None
    app.state.nl2sql_error = "bundle dir not configured"
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as client:
        response = await client.get("/readyz")
    assert response.status_code == 200
    body = response.json()
    assert body["ready"] is False
    assert "bundle dir not configured" in body["reason"]


async def test_readyz_reports_ready_with_bundle_version_and_embedding_model(client, app_state: AppState):
    response = await client.get("/readyz")
    assert response.status_code == 200
    body = response.json()
    assert body["ready"] is True
    assert body["bundleVersion"] == app_state.bundle_version
    assert body["embeddingModelId"] == app_state.embedding_model_id
    assert body["engineAttached"] is True


async def test_readyz_requires_no_auth_header(client):
    response = await client.get("/readyz")
    assert response.status_code == 200
