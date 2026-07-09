"""test_retriever.py — ceiba_nl2sql.retrieval.retriever.HybridRetriever
(Phase 2 port of lib/rag/__tests__/Retriever.test.ts's essential assertions;
docs/PYTHON_NL2SQL_SERVICE_PLAN.md §1.1, §3.1, §4). Uses the SAME committed
fixture bundle the TS suite uses (lib/rag/__tests__/fixtures/bundles/mock-v1)
and the SAME `DeterministicHashEmbedder` scheme it was built with — hermetic,
no network, no real fastembed model download.
"""

from __future__ import annotations

from pathlib import Path

import pytest

from ceiba_nl2sql.bundle.loader import TEST_FALLBACK_EMBEDDING_MODEL_ID
from ceiba_nl2sql.embed.local_embedder import DeterministicHashEmbedder
from ceiba_nl2sql.retrieval.retriever import HybridRetriever, RetrieveOptions

FIXTURE_BUNDLE_DIR = Path(__file__).resolve().parents[2] / "lib" / "rag" / "__tests__" / "fixtures" / "bundles" / "mock-v1"


def _embed_query_factory():
    embedder = DeterministicHashEmbedder()

    def _embed(text: str):
        return embedder.embed_documents([text])[0]

    return _embed


@pytest.fixture
def retriever():
    r = HybridRetriever(embed_query=_embed_query_factory(), dialect="duckdb", expected_embedding_model_id=TEST_FALLBACK_EMBEDDING_MODEL_ID)
    r.load(FIXTURE_BUNDLE_DIR)
    yield r
    r.dispose()


def test_heart_rate_question_surfaces_measurements_table_with_cardinality_warning(retriever: HybridRetriever):
    ctx = retriever.retrieve("heart rate over 120 in the last 3 hours", RetrieveOptions(token_budget=2500, max_tables=6))
    table_ids = [t.table_id for t in ctx.tables]
    assert "mock.public.MeasurementsMock" in table_ids
    assert len(ctx.cardinality_warnings) > 0
    assert any("RecordedAt" in (w.required_time_column or "") for w in ctx.cardinality_warnings)
    assert ctx.dialect == "duckdb"


def test_admitted_question_surfaces_visit_table(retriever: HybridRetriever):
    ctx = retriever.retrieve("patients admitted yesterday", RetrieveOptions(token_budget=2500, max_tables=6))
    table_ids = [t.table_id for t in ctx.tables]
    assert "mock.public.VisitMock" in table_ids


def test_render_respects_max_tables_cap(retriever: HybridRetriever):
    ctx = retriever.retrieve("heart rate over 120 in the last 3 hours", RetrieveOptions(token_budget=2500, max_tables=2))
    assert len(ctx.tables) <= 2


def test_exemplars_recalled_for_heart_rate_question(retriever: HybridRetriever):
    ctx = retriever.retrieve("heart rate over 120 in the last 3 hours", RetrieveOptions(token_budget=2500, max_tables=6, exemplar_k=3))
    assert any("heart_rate" in e.id for e in ctx.exemplars)


def test_retrieve_before_load_raises():
    r = HybridRetriever(embed_query=_embed_query_factory(), dialect="duckdb", expected_embedding_model_id=TEST_FALLBACK_EMBEDDING_MODEL_ID)
    with pytest.raises(RuntimeError):
        r.retrieve("anything", RetrieveOptions(token_budget=1000, max_tables=3))


def test_load_rejects_mismatched_embedding_model_id():
    """Mirrors BundleLoader's hard-error contract: loading the test-fallback
    fixture bundle while expecting the REAL production model id must refuse,
    not silently retrieve against a mismatched vector space.
    """
    from ceiba_nl2sql.bundle.loader import EmbeddingModelMismatchError

    r = HybridRetriever(embed_query=_embed_query_factory(), dialect="duckdb")  # default expects bge-small-en-v1.5
    with pytest.raises(EmbeddingModelMismatchError):
        r.load(FIXTURE_BUNDLE_DIR)
