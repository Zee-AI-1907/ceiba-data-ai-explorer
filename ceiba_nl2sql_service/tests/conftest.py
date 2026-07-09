"""conftest.py — shared fixtures for the service's hermetic test suite
(docs/PYTHON_NL2SQL_SERVICE_PLAN.md §4 "port the lib/rag/lib/engine unit
tests to pytest", §9 Phase 2 DoD "service boots, /readyz green on fixture
bundle").

Builds:
  - a hermetic seed DuckDB file (mirrors generate.test.ts's MeasurementsMock/
    MeasurementTypeRef/VisitMock seed) attached as alias "mock",
  - a fresh FastAPI `AppState` pointed at the committed fixture bundle
    (lib/rag/__tests__/fixtures/bundles/mock-v1) with the deterministic test
    embedder (no real fastembed model download — hermetic, CI-safe),
  - an httpx AsyncClient wired to the app via ASGITransport with that
    AppState injected directly onto `app.state.nl2sql` (bypassing the real
    `create_app_state`/env-based bring-up — the test-only equivalent of the
    TS suite's `__setGenerationDepsForTest` seam).
"""

from __future__ import annotations

from pathlib import Path

import duckdb
import pytest
import pytest_asyncio
from httpx import ASGITransport, AsyncClient

from ceiba_nl2sql.bundle.loader import TEST_FALLBACK_EMBEDDING_MODEL_ID
from ceiba_nl2sql.embed.local_embedder import DeterministicHashEmbedder
from ceiba_nl2sql.engine.base import AttachSpec
from ceiba_nl2sql.engine.duckdb_engine import DuckDbEngine
from ceiba_nl2sql.generation.llm import StubLlmClient
from ceiba_nl2sql.retrieval.retriever import HybridRetriever

from ceiba_nl2sql_service.app import app
from ceiba_nl2sql_service.deps import AppState
from ceiba_nl2sql_service.settings import Settings

FIXTURE_BUNDLE_DIR = Path(__file__).resolve().parents[2] / "lib" / "rag" / "__tests__" / "fixtures" / "bundles" / "mock-v1"

TEST_SERVICE_TOKEN = "test-internal-service-token"


@pytest.fixture(scope="session")
def seed_db_path(tmp_path_factory: pytest.TempPathFactory) -> str:
    db_path = str(tmp_path_factory.mktemp("nl2sql-service-tests") / "hermetic.duckdb")
    conn = duckdb.connect(db_path)
    conn.execute("CREATE SCHEMA IF NOT EXISTS public")
    conn.execute(
        """CREATE TABLE public."MeasurementTypeRef" (
            "MeasurementTypeId" INTEGER PRIMARY KEY, "name" VARCHAR NOT NULL, "unit" VARCHAR NOT NULL
        )"""
    )
    conn.execute(
        """CREATE TABLE public."MeasurementsMock" (
            "Id" BIGINT PRIMARY KEY, "DeviceId" INTEGER, "MeasurementTypeId" INTEGER,
            "Value" DOUBLE, "RecordedAt" TIMESTAMPTZ, "patientRef" INTEGER
        )"""
    )
    conn.execute(
        """CREATE TABLE public."VisitMock" (
            "visitRef" INTEGER PRIMARY KEY, "patientRef" INTEGER, "wardId" INTEGER,
            "admittedAt" TIMESTAMPTZ, "dischargedAt" TIMESTAMPTZ
        )"""
    )
    conn.execute(
        """INSERT INTO public."MeasurementsMock" VALUES
        (1, 10, 1, 135.0, now() - INTERVAL '30 minutes', 100),
        (2, 11, 1,  70.0, now() - INTERVAL '30 minutes', 101)"""
    )
    conn.execute("""INSERT INTO public."VisitMock" VALUES (1, 100, 5, now() - INTERVAL '12 hours', NULL)""")
    conn.close()
    return db_path


def _build_retriever() -> HybridRetriever:
    embedder = DeterministicHashEmbedder()

    def embed_query(text: str):
        return embedder.embed_documents([text])[0]

    r = HybridRetriever(embed_query=embed_query, dialect="duckdb", expected_embedding_model_id=TEST_FALLBACK_EMBEDDING_MODEL_ID)
    r.load(FIXTURE_BUNDLE_DIR)
    return r


@pytest.fixture
def test_settings(monkeypatch: pytest.MonkeyPatch) -> Settings:
    monkeypatch.setenv("NL2SQL_SERVICE_TOKEN", TEST_SERVICE_TOKEN)
    monkeypatch.delenv("OPENAI_BAA_SIGNED", raising=False)
    monkeypatch.delenv("OPENAI_API_KEY", raising=False)
    return Settings()


@pytest.fixture
def app_state(seed_db_path: str, test_settings: Settings):
    engine = DuckDbEngine()
    engine.attach([AttachSpec(source_id="mock", engine="duckdb", dsn=seed_db_path, read_only=True, alias="mock")])
    retriever = _build_retriever()
    state = AppState(
        settings=test_settings,
        engine=engine,
        retriever=retriever,
        bundle_version="v-test-fixture",
        embedding_model_id=TEST_FALLBACK_EMBEDDING_MODEL_ID,
    )
    yield state
    state.dispose()


@pytest_asyncio.fixture
async def client(app_state: AppState):
    """An httpx AsyncClient talking to the real FastAPI `app` ASGI callable
    with `app_state` injected directly (bypassing the real lifespan's
    env-driven bundle/engine bring-up, and letting each test inject its own
    stub LlmClient via `app_state._llm`).
    """
    app.state.nl2sql = app_state
    app.state.nl2sql_error = None
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as ac:
        yield ac
    app.state.nl2sql = None


@pytest.fixture
def auth_headers() -> dict:
    return {"Authorization": f"Bearer {TEST_SERVICE_TOKEN}"}
