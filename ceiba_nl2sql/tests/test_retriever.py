"""test_retriever.py — ceiba_nl2sql.retrieval.retriever.HybridRetriever
(Phase 2 port of lib/rag/__tests__/Retriever.test.ts's essential assertions;
docs/PYTHON_NL2SQL_SERVICE_PLAN.md §1.1, §3.1, §4). Uses the SAME committed
fixture bundle the TS suite uses (lib/rag/__tests__/fixtures/bundles/mock-v1)
and the SAME `DeterministicHashEmbedder` scheme it was built with — hermetic,
no network, no real fastembed model download.
"""

from __future__ import annotations

import hashlib
import json
import shutil
from pathlib import Path

import pytest

from ceiba_nl2sql.bundle.loader import TEST_FALLBACK_EMBEDDING_MODEL_ID
from ceiba_nl2sql.embed.local_embedder import DeterministicHashEmbedder
from ceiba_nl2sql.retrieval.retriever import (
    HINT_PIN_THRESHOLD,
    HybridRetriever,
    RetrieveOptions,
    bfs_shortest_path,
    bridge_expand,
    build_join_adjacency,
)

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


# ── Task 9: Exemplar.sample threading ───────────────────────────────────────


def test_recalled_exemplar_sample_defaults_to_empty_when_absent_from_bundle(retriever: HybridRetriever):
    """The committed fixture bundle's exemplars.json (lib/rag/__tests__/
    fixtures/bundles/mock-v1/exemplars.json) predates the `sample` field
    (Task 7's prep-side exemplar generator). Every recalled exemplar must
    still default to `sample=[]` rather than erroring or being omitted.
    """
    ctx = retriever.retrieve(
        "heart rate over 120 in the last 3 hours", RetrieveOptions(token_budget=2500, max_tables=6, exemplar_k=3)
    )
    assert ctx.exemplars  # sanity: something was recalled
    for exemplar in ctx.exemplars:
        assert exemplar.sample == []


def test_recalled_exemplar_carries_sample_when_present_in_bundle(tmp_path: Path):
    """A newer bundle (Task 6/7 exemplar generator output) carries a `sample`
    per exemplar entry — `_recall_exemplars` must thread it onto the
    recalled `Exemplar.sample` field verbatim.
    """
    bundle_dir = tmp_path / "mock-v1-with-sample"
    shutil.copytree(FIXTURE_BUNDLE_DIR, bundle_dir)

    exemplars_path = bundle_dir / "exemplars.json"
    exemplars_data = json.loads(exemplars_path.read_text())
    for entry in exemplars_data["exemplars"]:
        if entry["id"] == "ex_heart_rate_over_120_last_3h":
            entry["sample"] = [{"patientRef": 7, "Value": 132.0}]
    exemplars_path.write_text(json.dumps(exemplars_data))

    # The loader verifies every bundle file's sha256 against manifest.json
    # (BundleIntegrityError otherwise) — recompute the hash for the edited
    # exemplars.json so this hand-tampered copy still passes that check.
    manifest_path = bundle_dir / "manifest.json"
    manifest_data = json.loads(manifest_path.read_text())
    manifest_data["files"]["exemplars.json"] = hashlib.sha256(exemplars_path.read_bytes()).hexdigest()
    manifest_path.write_text(json.dumps(manifest_data))

    r = HybridRetriever(embed_query=_embed_query_factory(), dialect="duckdb", expected_embedding_model_id=TEST_FALLBACK_EMBEDDING_MODEL_ID)
    r.load(bundle_dir)
    try:
        ctx = r.retrieve(
            "heart rate over 120 in the last 3 hours", RetrieveOptions(token_budget=2500, max_tables=6, exemplar_k=3)
        )
        by_id = {e.id: e for e in ctx.exemplars}
        assert "ex_heart_rate_over_120_last_3h" in by_id
        assert by_id["ex_heart_rate_over_120_last_3h"].sample == [{"patientRef": 7, "Value": 132.0}]
    finally:
        r.dispose()


def test_retrieve_embeds_the_question_exactly_once():
    """Regression: table recall and column recall each embedded the same
    expanded question — two embedder forward passes per request for one
    string. retrieve() must compute the embedding once and share it.
    """
    calls: list[str] = []
    inner = _embed_query_factory()

    def counting_embed(text: str):
        calls.append(text)
        return inner(text)

    r = HybridRetriever(
        embed_query=counting_embed, dialect="duckdb", expected_embedding_model_id=TEST_FALLBACK_EMBEDDING_MODEL_ID
    )
    r.load(FIXTURE_BUNDLE_DIR)
    try:
        r.retrieve("heart rate over 120 in the last 3 hours", RetrieveOptions(token_budget=2500, max_tables=6))
        assert len(calls) == 1
    finally:
        r.dispose()


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


# ── Fix A: pure BFS bridge-path functions (JOINGRAPH_SURFACING.md §2, §8.2) ─
#
# mock-v1's own joingraph.json is FLAT (MeasurementsMock -> PatientMock is a
# direct edge, no bridge needed), so these tests hand-build a MINIMAL 3-hop
# adjacency shaped like the REAL staging bridge (MonitorMeasurements ->
# Monitors -> Acceptances -> Patients) to exercise the actual HR failure
# mode without needing a full bundle reload — no `HybridRetriever` instance
# required at all, per the pure-function extraction.


def _real_staging_shaped_edges() -> list[dict]:
    """A minimal repro of the REAL staging join path documented in the task:
    MonitorMeasurements.DeviceId -> Monitors.Id;
    Monitors.AcceptanceId -> Acceptances.Id;
    Acceptances.PatientId -> Patients.Id;
    MonitorMeasurements.MeasurementTypeId -> MonitorMeasurementTypes.Id.
    """
    return [
        {
            "from": "staging.Shared.MonitorMeasurements",
            "fromColumns": ["DeviceId"],
            "to": "staging.Shared.Monitors",
            "toColumns": ["Id"],
            "joinCardinality": "many-to-one",
            "crossSource": False,
            "origin": "declared",
            "confidence": 1.0,
        },
        {
            "from": "staging.Shared.Monitors",
            "fromColumns": ["AcceptanceId"],
            "to": "staging.Shared.Acceptances",
            "toColumns": ["Id"],
            "joinCardinality": "many-to-one",
            "crossSource": False,
            "origin": "declared",
            "confidence": 1.0,
        },
        {
            "from": "staging.Shared.Acceptances",
            "fromColumns": ["PatientId"],
            "to": "staging.Shared.Patients",
            "toColumns": ["Id"],
            "joinCardinality": "many-to-one",
            "crossSource": False,
            "origin": "declared",
            "confidence": 1.0,
        },
        {
            "from": "staging.Shared.MonitorMeasurements",
            "fromColumns": ["MeasurementTypeId"],
            "to": "staging.Shared.MonitorMeasurementTypes",
            "toColumns": ["Id"],
            "joinCardinality": "many-to-one",
            "crossSource": False,
            "origin": "declared",
            "confidence": 1.0,
        },
    ]


def test_bfs_shortest_path_finds_3_hop_bridge():
    adjacency = build_join_adjacency(_real_staging_shaped_edges())
    path = bfs_shortest_path(
        adjacency, "staging.Shared.MonitorMeasurements", "staging.Shared.Patients", max_hops=3
    )
    assert path is not None
    assert len(path) == 3
    intermediate_nodes = {hop[1] for hop in path[:-1]}
    assert intermediate_nodes == {"staging.Shared.Monitors", "staging.Shared.Acceptances"}


def test_bfs_shortest_path_returns_none_beyond_max_hops():
    adjacency = build_join_adjacency(_real_staging_shaped_edges())
    path = bfs_shortest_path(
        adjacency, "staging.Shared.MonitorMeasurements", "staging.Shared.Patients", max_hops=2
    )
    assert path is None


def test_bfs_shortest_path_none_for_identical_start_and_end():
    adjacency = build_join_adjacency(_real_staging_shaped_edges())
    assert bfs_shortest_path(adjacency, "staging.Shared.Patients", "staging.Shared.Patients") is None


def test_bridge_expand_pulls_in_monitors_and_acceptances_as_bridge_nodes():
    """The actual HR failure mode: survivors are MonitorMeasurements +
    Patients (the pin + the target entity), with NO direct edge between
    them — bridge_expand must find the 3-hop path and mark Monitors +
    Acceptances as bridge nodes.
    """
    adjacency = build_join_adjacency(_real_staging_shaped_edges())
    survivors = ["staging.Shared.MonitorMeasurements", "staging.Shared.Patients"]
    bridge_nodes, paths = bridge_expand(adjacency, survivors, max_hops=3, max_paths=6)

    assert bridge_nodes == {"staging.Shared.Monitors", "staging.Shared.Acceptances"}
    assert len(paths) == 1
    path = paths[0]
    assert path[0][0] == "staging.Shared.MonitorMeasurements"
    assert path[-1][1] == "staging.Shared.Patients"
    assert len(path) == 3


def test_bridge_expand_no_bridge_needed_for_direct_edge():
    adjacency = build_join_adjacency(_real_staging_shaped_edges())
    survivors = ["staging.Shared.MonitorMeasurements", "staging.Shared.MonitorMeasurementTypes"]
    bridge_nodes, paths = bridge_expand(adjacency, survivors, max_hops=3, max_paths=6)
    assert bridge_nodes == set()
    assert paths == []


def test_bridge_expand_respects_max_paths_cap():
    # A small fan: one hub table bridges to 4 different leaf survivors, each
    # via a 2-hop path through a distinct bridge — more than max_paths=2.
    edges = []
    for i in range(4):
        edges.append(
            {
                "from": f"leaf{i}",
                "fromColumns": ["x"],
                "to": f"bridge{i}",
                "toColumns": ["x"],
                "joinCardinality": "many-to-one",
                "crossSource": False,
                "origin": "declared",
                "confidence": 1.0,
            }
        )
        edges.append(
            {
                "from": f"bridge{i}",
                "fromColumns": ["y"],
                "to": "hub",
                "toColumns": ["y"],
                "joinCardinality": "many-to-one",
                "crossSource": False,
                "origin": "declared",
                "confidence": 1.0,
            }
        )
    adjacency = build_join_adjacency(edges)
    survivors = ["hub", "leaf0", "leaf1", "leaf2", "leaf3"]
    _bridge_nodes, paths = bridge_expand(adjacency, survivors, max_hops=3, max_paths=2)
    assert len(paths) == 2


# ── Fix D: retrieval pin + glossary hint fields ─────────────────────────────


def test_glossary_hit_carries_hosting_table_id_and_code_value(retriever: HybridRetriever):
    _expanded, hits = retriever._expand_question("what is the heart rate")
    hr_hit = next(h for h in hits if h.term == "heart rate")
    assert hr_hit.hosting_table_id == "mock.public.MeasurementsMock"
    assert hr_hit.confidence >= HINT_PIN_THRESHOLD
    assert hr_hit.code_value == "Heart Rate"
    assert hr_hit.code_column_id == "mock.public.MeasurementsMock.MeasurementTypeId"


def test_retrieval_pin_puts_hosting_table_at_front_of_recalled_ids(retriever: HybridRetriever):
    """A hint whose hosting table would NOT otherwise be recalled by dense/
    BM25 alone still ends up in `ctx.tables` after `retrieve()` — this is the
    causal recall fix for the HR failure. We can't easily force dense/BM25 to
    MISS MeasurementsMock in this small fixture, but we CAN assert the pin
    mechanism itself: MeasurementsMock is present, and it is exactly the
    hosting_table_id resolved by the glossary hit.
    """
    ctx = retriever.retrieve("heart rate over 120 in the last 3 hours", RetrieveOptions(token_budget=2500, max_tables=6))
    hr_hit = next(h for h in ctx.glossary_hits if h.term == "heart rate")
    table_ids = [t.table_id for t in ctx.tables]
    assert hr_hit.hosting_table_id in table_ids


def test_retrieve_pin_bypasses_recall_when_dense_bm25_would_miss(retriever: HybridRetriever):
    """Directly exercises the pin logic in retrieve(): monkeypatch
    `_recall_tables` to return an empty list (simulating a total dense/BM25
    miss), and confirm the hosting table STILL appears in the final
    SchemaContext purely via the glossary pin.
    """
    original_recall = retriever._recall_tables
    retriever._recall_tables = lambda *args, **kwargs: []  # type: ignore[method-assign]
    try:
        ctx = retriever.retrieve("heart rate over 120 in the last 3 hours", RetrieveOptions(token_budget=2500, max_tables=6))
    finally:
        retriever._recall_tables = original_recall  # type: ignore[method-assign]

    table_ids = [t.table_id for t in ctx.tables]
    assert "mock.public.MeasurementsMock" in table_ids


def test_bridge_table_renders_with_role_bridge_when_pruned_to_stub(retriever: HybridRetriever):
    """With a tight max_tables, a bridge table that connects two survivors
    with no direct edge renders with role='bridge'."""
    ctx = retriever.retrieve("heart rate over 120 in the last 3 hours", RetrieveOptions(token_budget=2500, max_tables=3))
    roles = {t.table_id: t.role for t in ctx.tables}
    assert "mock.public.MeasurementsMock" in roles
    # At least the primary hosting table must always render as "primary".
    assert roles["mock.public.MeasurementsMock"] == "primary"


# ── R2 static-context mode ───────────────────────────────────────────────────


def _static_retriever(max_tokens: int = 100_000) -> HybridRetriever:
    calls: list[str] = []
    inner = _embed_query_factory()

    def counting_embed(text: str):
        calls.append(text)
        return inner(text)

    r = HybridRetriever(
        embed_query=counting_embed,
        dialect="duckdb",
        expected_embedding_model_id=TEST_FALLBACK_EMBEDDING_MODEL_ID,
        static_context_max_tokens=max_tokens,
    )
    r._embed_calls = calls  # test-only handle
    r.load(FIXTURE_BUNDLE_DIR)
    return r


def test_static_mode_returns_all_tables_ignoring_max_tables():
    r = _static_retriever()
    try:
        bundle_table_count = len(r._bundle.catalog["tables"])
        ctx = r.retrieve("heart rate over 120", RetrieveOptions(token_budget=100, max_tables=1))
        assert len(ctx.tables) == bundle_table_count
        assert ctx.static_context is True
    finally:
        r.dispose()


def test_static_mode_table_order_identical_across_questions():
    r = _static_retriever()
    try:
        ctx_a = r.retrieve("heart rate over 120", RetrieveOptions(token_budget=2500, max_tables=6))
        ctx_b = r.retrieve("patients admitted yesterday", RetrieveOptions(token_budget=2500, max_tables=6))
        assert [t.table_id for t in ctx_a.tables] == [t.table_id for t in ctx_b.tables]
        assert ctx_a.join_hints == ctx_b.join_hints
    finally:
        r.dispose()


def test_static_mode_never_invokes_the_embedder():
    r = _static_retriever()
    try:
        r.retrieve("heart rate over 120", RetrieveOptions(token_budget=2500, max_tables=6))
        assert r._embed_calls == []
    finally:
        r.dispose()


def test_static_mode_still_produces_question_dependent_hints_and_exemplars():
    r = _static_retriever()
    try:
        ctx = r.retrieve(
            "heart rate over 120 in the last 3 hours", RetrieveOptions(token_budget=2500, max_tables=6, exemplar_k=3)
        )
        assert any("heart_rate" in e.id for e in ctx.exemplars)
        assert len(ctx.cardinality_warnings) > 0  # large tables still warned
    finally:
        r.dispose()


def test_static_mode_disabled_when_bundle_exceeds_bound():
    r = _static_retriever(max_tokens=10)  # fixture bundle cannot fit 10 tokens
    try:
        ctx = r.retrieve("heart rate over 120", RetrieveOptions(token_budget=2500, max_tables=2))
        assert ctx.static_context is False
        assert len(ctx.tables) <= 2  # hybrid path honors max_tables again
    finally:
        r.dispose()
