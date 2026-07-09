"""fusion.py — reciprocal-rank fusion (RRF) of dense + BM25 result lists
(ports lib/rag/rankFusion.ts verbatim; docs/PYTHON_NL2SQL_SERVICE_PLAN.md
§1.1, §3.1 `retrieval/fusion.py`).

RRF combines multiple ranked lists by scoring each item `1 / (k + rank)` per
list it appears in (rank is 1-based) and summing across lists. `k` (default
60) is the conventional RRF damping constant.
"""

from __future__ import annotations

from dataclasses import dataclass, field


@dataclass(frozen=True)
class RankedItem:
    id: str
    score: float | None = None


@dataclass
class FusedItem:
    id: str
    fused_score: float
    contributions: dict[str, float] = field(default_factory=dict)


def fuse_rankings(
    rankings: dict[str, list[RankedItem]],
    *,
    k: int = 60,
    weights: dict[str, float] | None = None,
) -> list[FusedItem]:
    """Fuses N labeled, already-ranked lists (best-first) into one ranked list
    by reciprocal-rank fusion. Mirrors lib/rag/rankFusion.ts `fuseRankings`.
    """
    weights = weights or {}
    fused_by_id: dict[str, FusedItem] = {}

    for source, items in rankings.items():
        weight = weights.get(source, 1.0)
        for index, item in enumerate(items):
            rank = index + 1
            contribution = weight * (1 / (k + rank))
            entry = fused_by_id.get(item.id)
            if entry is None:
                entry = FusedItem(id=item.id, fused_score=0.0)
                fused_by_id[item.id] = entry
            entry.fused_score += contribution
            entry.contributions[source] = entry.contributions.get(source, 0.0) + contribution

    return sorted(fused_by_id.values(), key=lambda f: f.fused_score, reverse=True)


def fuse_two(
    dense_ranked: list[RankedItem],
    bm25_ranked: list[RankedItem],
    *,
    k: int = 60,
    weights: dict[str, float] | None = None,
) -> list[FusedItem]:
    """Convenience: fuse exactly two ranked lists (the common dense+BM25
    case). Mirrors lib/rag/rankFusion.ts `fuseTwo`.
    """
    return fuse_rankings({"dense": dense_ranked, "bm25": bm25_ranked}, k=k, weights=weights)
