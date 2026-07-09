"""test_semantic_cache.py — R5 semantic question cache (hermetic)."""

from __future__ import annotations

from ceiba_nl2sql.generation.semantic_cache import CachedGeneration, SemanticSqlCache


def _embedder_over(vocab: dict[str, list[float]]):
    """Deterministic 'embedder': exact strings map to fixed vectors; unknown
    strings map to an orthogonal vector.
    """

    def _embed(text: str) -> list[float]:
        return vocab.get(text, [0.0, 0.0, 1.0])

    return _embed


def _entry(question: str = "q", sql: str = "SELECT 1") -> CachedGeneration:
    return CachedGeneration(question=question, sql=sql, description="d", dialect="duckdb")


def test_paraphrase_above_threshold_hits():
    vocab = {
        "heart rate over 120 last 3 hours": [1.0, 0.0, 0.0],
        "HR > 120 in the past 3h": [0.999, 0.04, 0.0],  # cosine ~0.999
    }
    cache = SemanticSqlCache(_embedder_over(vocab), threshold=0.97)
    cache.store("heart rate over 120 last 3 hours", "org1", _entry("heart rate over 120 last 3 hours"))
    hit = cache.lookup("HR > 120 in the past 3h", "org1")
    assert hit is not None and hit.sql == "SELECT 1"


def test_dissimilar_question_misses():
    vocab = {
        "heart rate over 120 last 3 hours": [1.0, 0.0, 0.0],
        "patients admitted yesterday": [0.0, 1.0, 0.0],
    }
    cache = SemanticSqlCache(_embedder_over(vocab), threshold=0.97)
    cache.store("heart rate over 120 last 3 hours", "org1", _entry())
    assert cache.lookup("patients admitted yesterday", "org1") is None


def test_tenant_isolation_is_absolute():
    vocab = {"same question": [1.0, 0.0, 0.0]}
    cache = SemanticSqlCache(_embedder_over(vocab), threshold=0.5)
    cache.store("same question", "org1", _entry())
    assert cache.lookup("same question", "org2") is None
    assert cache.lookup("same question", None) is None
    assert cache.lookup("same question", "org1") is not None


def test_ttl_expiry():
    now = [0.0]
    vocab = {"q": [1.0, 0.0, 0.0]}
    cache = SemanticSqlCache(_embedder_over(vocab), threshold=0.5, ttl_seconds=100, clock=lambda: now[0])
    cache.store("q", "org1", _entry())
    now[0] = 99.0
    assert cache.lookup("q", "org1") is not None
    now[0] = 101.0
    assert cache.lookup("q", "org1") is None
    assert len(cache) == 0  # expired entry dropped


def test_lru_size_cap():
    vocab = {f"q{i}": [1.0, 0.0, float(i)] for i in range(5)}
    cache = SemanticSqlCache(_embedder_over(vocab), threshold=0.99, max_entries=3)
    for i in range(5):
        cache.store(f"q{i}", "org1", _entry(f"q{i}"))
    assert len(cache) == 3


def test_invalidate_drops_entry():
    vocab = {"q": [1.0, 0.0, 0.0]}
    cache = SemanticSqlCache(_embedder_over(vocab), threshold=0.5)
    cache.store("q", "org1", _entry("q"))
    hit = cache.lookup("q", "org1")
    assert hit is not None
    cache.invalidate(hit.question, "org1")
    assert cache.lookup("q", "org1") is None
