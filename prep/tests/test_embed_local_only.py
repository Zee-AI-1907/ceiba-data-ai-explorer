"""test_embed_local_only.py — local_embedder.py (SPEC §1.2, §2.5 invariant 4). P3b.

Asserts:
  * A non-local provider fails validation (`assert_local_embedding_provider`,
    `build_embedder`) BEFORE any model load / network call — SPEC §2.5
    invariant 4 fail-fast discipline.
  * `build_embedder` refuses `DeterministicHashEmbedder` (the TEST-ONLY
    fallback) unless `allow_test_fallback=True` is passed explicitly — a real
    `build` can never silently produce fake vectors.
  * Real embedder (`FastEmbedEmbedder`) OR test fallback
    (`DeterministicHashEmbedder`, explicitly opted into) both produce
    dimension-384, L2-normalized vectors — the dimension/normalization
    contract holds regardless of which embedder backs it.
  * `FastEmbedEmbedder` is hard-pinned to `bge-small-en-v1.5`; constructing it
    with any other model id raises before touching fastembed at all.
  * `assert_fingerprint_matches_expected` rejects a fingerprint whose `id`
    doesn't match what the manifest expects (mirrors the SPEC §1.2 runtime
    guard, enforced build-side too).
  * `DeterministicHashEmbedder` is genuinely deterministic (same text -> same
    vector, run to run) and distinct texts do not collide.

The real fastembed model is exercised too (not just the fallback) whenever
it's available in this environment (network-optional local model cache) — if
it's unavailable, that specific test skips cleanly (fastembed model download
is a one-time local fetch, not a per-embed network call, but the FIRST fetch
does need connectivity or a warm cache, per PLAN §0a decision #2).
"""

from __future__ import annotations

import math

import pytest

from prep.embed.local_embedder import (
    DeterministicHashEmbedder,
    EmbedderConfigError,
    EXPECTED_DIMENSION,
    EXPECTED_MODEL_ID,
    EXPECTED_NORMALIZATION,
    FastEmbedEmbedder,
    assert_fingerprint_matches_expected,
    assert_local_embedding_provider,
    build_embedder,
)


# ── provider gate (fail before any model load) ──────────────────────────────


def test_non_local_provider_rejected_before_model_load():
    with pytest.raises(EmbedderConfigError):
        assert_local_embedding_provider("openai")


def test_local_provider_passes():
    assert_local_embedding_provider("local") is None  # no raise


def test_build_embedder_rejects_non_local_provider_fast():
    with pytest.raises(EmbedderConfigError):
        build_embedder(provider="openai", model_id=EXPECTED_MODEL_ID, dimension=EXPECTED_DIMENSION)


# ── test-fallback gating ─────────────────────────────────────────────────────


def test_test_fallback_model_id_refused_without_explicit_flag():
    with pytest.raises(EmbedderConfigError):
        build_embedder(
            provider="local",
            model_id=DeterministicHashEmbedder.MODEL_ID,
            dimension=EXPECTED_DIMENSION,
            allow_test_fallback=False,
        )


def test_test_fallback_model_id_allowed_with_explicit_flag():
    embedder = build_embedder(
        provider="local",
        model_id=DeterministicHashEmbedder.MODEL_ID,
        dimension=EXPECTED_DIMENSION,
        allow_test_fallback=True,
    )
    assert isinstance(embedder, DeterministicHashEmbedder)


def test_unknown_model_id_rejected():
    with pytest.raises(EmbedderConfigError):
        build_embedder(provider="local", model_id="some-other-model", dimension=EXPECTED_DIMENSION)


def test_dimension_mismatch_rejected():
    with pytest.raises(EmbedderConfigError):
        build_embedder(provider="local", model_id=EXPECTED_MODEL_ID, dimension=768)


# ── FastEmbedEmbedder pinning ────────────────────────────────────────────────


def test_fastembed_embedder_rejects_non_default_model_id():
    with pytest.raises(EmbedderConfigError):
        FastEmbedEmbedder(model_id="some-other-model")


# ── vectors are dim 384, L2-normalized (deterministic fallback path) ───────


def test_deterministic_fallback_produces_dim_384_normalized_vectors():
    embedder = DeterministicHashEmbedder(dimension=384)
    vectors = embedder.embed_documents(["heart rate over 120", "patients admitted yesterday"])
    assert len(vectors) == 2
    for v in vectors:
        assert len(v) == 384
        norm = math.sqrt(sum(x * x for x in v))
        assert abs(norm - 1.0) < 1e-6


def test_deterministic_fallback_is_deterministic():
    embedder = DeterministicHashEmbedder(dimension=384)
    v1 = embedder.embed_documents(["heart rate over 120"])[0]
    v2 = embedder.embed_documents(["heart rate over 120"])[0]
    assert v1 == v2


def test_deterministic_fallback_distinct_texts_do_not_collide():
    embedder = DeterministicHashEmbedder(dimension=384)
    v1 = embedder.embed_documents(["heart rate over 120"])[0]
    v2 = embedder.embed_documents(["patients admitted yesterday"])[0]
    assert v1 != v2


def test_deterministic_fallback_fingerprint_never_claims_the_real_model_id():
    embedder = DeterministicHashEmbedder()
    fp = embedder.fingerprint()
    assert fp.id != EXPECTED_MODEL_ID
    assert fp.id == "test-deterministic-hash-v1"
    assert fp.dimension == EXPECTED_DIMENSION


# ── manifest-id mismatch guard ───────────────────────────────────────────────


def test_assert_fingerprint_matches_expected_rejects_mismatch():
    embedder = DeterministicHashEmbedder()
    fp = embedder.fingerprint()
    with pytest.raises(EmbedderConfigError):
        assert_fingerprint_matches_expected(fp, expected_model_id=EXPECTED_MODEL_ID)


def test_assert_fingerprint_matches_expected_passes_for_matching_id():
    embedder = DeterministicHashEmbedder()
    fp = embedder.fingerprint()
    assert_fingerprint_matches_expected(fp, expected_model_id=fp.id) is None  # no raise


# ── the REAL default embedder (skips cleanly if fastembed/model unavailable) ─


@pytest.fixture(scope="module")
def real_embedder():
    try:
        embedder = FastEmbedEmbedder()
        # Touch the model once; if this fails (no network for first-time
        # download, no cache warm), skip rather than fail — PLAN ground rule
        # #4: no test may REQUIRE external state to be green.
        embedder.embed_documents(["warmup"])
        return embedder
    except Exception as exc:  # noqa: BLE001 - deliberately broad: any failure means "skip"
        pytest.skip(f"fastembed/bge-small-en-v1.5 unavailable in this environment: {exc}")


def test_real_embedder_produces_dim_384_l2_normalized_vectors(real_embedder):
    vectors = real_embedder.embed_documents(["heart rate over 120 in the last 3 hours"])
    assert len(vectors) == 1
    vector = vectors[0]
    assert len(vector) == EXPECTED_DIMENSION
    norm = math.sqrt(sum(x * x for x in vector))
    assert abs(norm - 1.0) < 1e-4


def test_real_embedder_fingerprint_matches_manifest_shape(real_embedder):
    fp = real_embedder.fingerprint()
    assert fp.id == EXPECTED_MODEL_ID
    assert fp.dimension == EXPECTED_DIMENSION
    assert fp.normalization == EXPECTED_NORMALIZATION
    assert fp.lib == "fastembed"
    assert fp.revision.startswith("sha256:")

    summary = fp.to_manifest_summary()
    assert summary == {"id": "bge-small-en-v1.5", "dim": 384, "lib": "fastembed", "revision": fp.revision}


def test_real_embedder_fingerprint_is_reproducible_across_instances(real_embedder):
    fp1 = real_embedder.fingerprint()
    fp2 = FastEmbedEmbedder().fingerprint()
    assert fp1.revision == fp2.revision


def test_real_embedder_semantic_similarity_heart_rate_vs_unrelated(real_embedder):
    """A loose sanity check that the real model produces semantically
    meaningful vectors: "heart rate" should be closer to "pulse rate" than to
    an unrelated phrase like "quarterly financial report".
    """
    heart_rate, pulse_rate, unrelated = real_embedder.embed_documents(
        ["heart rate", "pulse rate", "quarterly financial report"]
    )

    def cosine_similarity(a: list[float], b: list[float]) -> float:
        return sum(x * y for x, y in zip(a, b))  # already L2-normalized -> dot product = cosine

    sim_related = cosine_similarity(heart_rate, pulse_rate)
    sim_unrelated = cosine_similarity(heart_rate, unrelated)
    assert sim_related > sim_unrelated
