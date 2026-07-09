/**
 * rankFusion.ts — reciprocal-rank fusion (RRF) of dense + BM25 result lists
 * (NL2SQL_SPEC.md §4.1 stage 3: "fused by reciprocal-rank fusion").
 *
 * RRF combines multiple ranked lists by scoring each item `1 / (k + rank)`
 * per list it appears in (rank is 1-based) and summing across lists — a
 * simple, parameter-light fusion that does not require the two lists' raw
 * scores (BM25 scores and cosine distances live on incomparable scales) to be
 * normalized against each other. `k` (default 60) is the conventional RRF
 * damping constant from the original Cormack/Clarke/Buettcher formulation;
 * larger `k` flattens the influence of rank-1 items.
 */

export interface RankedItem {
  id: string
  /** Optional per-list score, carried through for observability/debugging — NOT used by the fusion formula itself. */
  score?: number
}

export interface FusedItem {
  id: string
  fusedScore: number
  /** Per-source contribution, keyed by the label passed to fuseRankings — useful for tests/observability. */
  contributions: Record<string, number>
}

export interface RankFusionOptions {
  /** RRF damping constant. Default 60 (the conventional literature default). */
  k?: number
  /**
   * Optional per-source weight multiplier (default 1 for every source),
   * applied to that source's RRF contribution before summing — lets a caller
   * bias one retrieval channel over another (e.g. importance-weighted table
   * recall, SPEC §4.1 stage 3 "bias by importanceScore") without abandoning
   * RRF's scale-independence.
   */
  weights?: Record<string, number>
}

/**
 * Fuses N labeled, already-ranked lists (best-first) into one ranked list by
 * reciprocal-rank fusion. `rankings` is a map from a source label (e.g.
 * "dense", "bm25") to that source's ranked item-id list.
 */
export function fuseRankings(rankings: Record<string, RankedItem[]>, options: RankFusionOptions = {}): FusedItem[] {
  const k = options.k ?? 60
  const weights = options.weights ?? {}

  const fusedById = new Map<string, FusedItem>()

  for (const [source, items] of Object.entries(rankings)) {
    const weight = weights[source] ?? 1
    items.forEach((item, index) => {
      const rank = index + 1 // 1-based
      const contribution = weight * (1 / (k + rank))

      let entry = fusedById.get(item.id)
      if (!entry) {
        entry = { id: item.id, fusedScore: 0, contributions: {} }
        fusedById.set(item.id, entry)
      }
      entry.fusedScore += contribution
      entry.contributions[source] = (entry.contributions[source] ?? 0) + contribution
    })
  }

  return Array.from(fusedById.values()).toSorted((a, b) => b.fusedScore - a.fusedScore)
}

/** Convenience: fuse exactly two ranked lists (the common dense+BM25 case, SPEC §4.1 stage 3). */
export function fuseTwo(
  denseRanked: RankedItem[],
  bm25Ranked: RankedItem[],
  options: RankFusionOptions = {}
): FusedItem[] {
  return fuseRankings({ dense: denseRanked, bm25: bm25Ranked }, options)
}
