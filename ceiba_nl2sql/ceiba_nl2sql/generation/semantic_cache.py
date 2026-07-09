"""semantic_cache.py — R5: flag-gated semantic question→SQL cache.

The TS layer caches EXACT question matches per tenant. This adds a Python-
side embedding-similarity cache that catches PARAPHRASES ("patients with HR
over 120 in the last 3 hours" vs "HR > 120 past 3h") and skips the entire
LLM round trip — the dominant latency (1.2–11s) and the entire token cost of
a generate request.

Safety posture (a wrong cache hit is a silent-wrong answer, the worst class):
  - OFF by default; enabled via NL2SQL_SEMANTIC_CACHE=true in the service.
  - HIGH default similarity threshold (0.97 cosine).
  - Tenant-scoped: a hit can never cross tenants.
  - The CALLER must revalidate a hit (engine.explain) before returning it —
    `lookup` returns the entry; the service drops it via `invalidate` if
    revalidation fails (schema drift).
  - TTL + size-capped LRU so stale entries age out regardless.
"""

from __future__ import annotations

import math
import time
from collections import OrderedDict
from dataclasses import dataclass
from typing import Callable

DEFAULT_SIMILARITY_THRESHOLD = 0.97
DEFAULT_MAX_ENTRIES = 512
DEFAULT_TTL_SECONDS = 1800.0


@dataclass(frozen=True)
class CachedGeneration:
    """The reusable part of a generate response. Usage is deliberately NOT
    cached — a cache hit costs ~0 tokens and the caller reports it as such.
    """

    question: str
    sql: str
    description: str
    dialect: str


def _cosine(a: list[float], b: list[float]) -> float:
    dot = sum(x * y for x, y in zip(a, b))
    norm_a = math.sqrt(sum(x * x for x in a))
    norm_b = math.sqrt(sum(x * x for x in b))
    if norm_a == 0.0 or norm_b == 0.0:
        return 0.0
    return dot / (norm_a * norm_b)


class SemanticSqlCache:
    """Embedding-similarity question cache, tenant-scoped, TTL'd, LRU-capped.

    `embed_query` is the SAME embedder the retriever uses (injected), so the
    similarity space matches retrieval's. `clock` is injectable for tests.
    """

    def __init__(
        self,
        embed_query: Callable[[str], list[float]],
        *,
        threshold: float = DEFAULT_SIMILARITY_THRESHOLD,
        max_entries: int = DEFAULT_MAX_ENTRIES,
        ttl_seconds: float = DEFAULT_TTL_SECONDS,
        clock: Callable[[], float] = time.monotonic,
    ) -> None:
        self._embed_query = embed_query
        self._threshold = threshold
        self._max_entries = max_entries
        self._ttl_seconds = ttl_seconds
        self._clock = clock
        # key: (tenant, question-normalized) -> (embedding, stored_at, entry)
        self._entries: OrderedDict[tuple[str, str], tuple[list[float], float, CachedGeneration]] = OrderedDict()

    @staticmethod
    def _key(tenant_id: str | None, question: str) -> tuple[str, str]:
        return (tenant_id or "", question.strip().lower())

    def lookup(self, question: str, tenant_id: str | None) -> CachedGeneration | None:
        """Best same-tenant entry at/above the similarity threshold, or None.
        Expired entries encountered during the scan are dropped. The caller
        MUST revalidate the returned SQL (engine.explain) before serving it.
        """
        now = self._clock()
        query_embedding = self._embed_query(question)
        tenant_key = tenant_id or ""

        best: CachedGeneration | None = None
        best_score = self._threshold
        expired: list[tuple[str, str]] = []
        for key, (embedding, stored_at, entry) in self._entries.items():
            if key[0] != tenant_key:
                continue
            if now - stored_at > self._ttl_seconds:
                expired.append(key)
                continue
            score = _cosine(query_embedding, embedding)
            if score >= best_score:
                best = entry
                best_score = score
        for key in expired:
            self._entries.pop(key, None)
        return best

    def store(self, question: str, tenant_id: str | None, entry: CachedGeneration) -> None:
        key = self._key(tenant_id, question)
        self._entries.pop(key, None)
        self._entries[key] = (self._embed_query(question), self._clock(), entry)
        while len(self._entries) > self._max_entries:
            self._entries.popitem(last=False)  # LRU: oldest first

    def invalidate(self, question: str, tenant_id: str | None) -> None:
        """Drop the entry for a question whose cached SQL failed revalidation
        (schema drift) — the next ask regenerates fresh.
        """
        self._entries.pop(self._key(tenant_id, question), None)

    def __len__(self) -> int:
        return len(self._entries)
