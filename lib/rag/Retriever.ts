/**
 * Retriever.ts — coarse-to-fine hybrid retriever (NL2SQL_SPEC.md §4, §4.1;
 * NL2SQL_PLAN.md §P4).
 *
 * CANONICAL home for `SchemaContext` / `RenderedTable` / `JoinHint` /
 * `CardinalityWarning` / `GlossaryHit` / `RetrieveOptions` (SPEC §4, verbatim
 * below). `lib/rag/promptAssembly.ts` (M1) previously defined a MINIMAL local
 * subset of these types with a `TODO(P4): unify` — this file is that
 * unification target; promptAssembly.ts now imports from here instead of
 * redefining (NL2SQL_PLAN.md §0 rule 6: "shared type files have a single
 * owning phase; later phases import, never edit").
 *
 * ── Pipeline (SPEC §4.1) ────────────────────────────────────────────────────
 *   1. Expand + normalize the question with glossary.abbreviations.
 *   2. Domain/schema prune (coarse) — restricted here to the bundle's own
 *      sourceScope filter; the mock/staging bundles used in this phase carry
 *      no populated `domain` tags yet (see BundleLoader.ts's documented
 *      catalog.json deviation note), so the domain-prune stage degrades
 *      gracefully to a no-op when `domain` is null for every table rather
 *      than silently mis-pruning — the narrowing still happens at stage 3.
 *   3. Table recall: hybrid dense (VssClient over doc_kind='table') + BM25
 *      (Bm25Index over doc_kind='table' docs), fused by reciprocal-rank
 *      fusion, biased by `importanceScore`. Keep top `recallTables`.
 *   4. Column recall: hybrid dense+BM25 over doc_kind='column' SCOPED to the
 *      stage-3 survivor tables. Keep top `recallColumns`.
 *   5. Graph-expand: pull FK neighbors of every survivor table from
 *      joingraph.json into the candidate table set.
 *   6. LLM-prune (injectable; a deterministic STUB by default so tests never
 *      require a live model — SPEC §4.1 stage 6, PLAN §P4 "LLM-prune (stub in
 *      CI)"). Selects the final <= maxTables tables from table-name + grain
 *      only.
 *   7. Render: emit the survivor tables with full column detail + join edges
 *      among them, honoring tokenBudget; attach cardinalityWarnings for any
 *      isLargeTimeSeries survivor, plus glossaryHits/exemplars.
 */

import {
  BundleLoader,
  EXPECTED_EMBEDDING_MODEL_ID,
  type BundleLoaderOptions,
  type CatalogTable,
  type GlossaryMap,
  type JoinGraphEdge,
} from './BundleLoader'
import { Bm25Index, type Bm25Document } from './bm25'
import { fuseTwo, type RankedItem } from './rankFusion'
import { VssClient, type EmbedQuery, type VssDocKind } from './vssClient'
import type { SqlDialect } from '../engine/QueryEngine'

// ── SPEC §4 canonical types (verbatim) ─────────────────────────────────────

export interface RenderedColumn {
  name: string
  quotedName: string
  dataType: string
  unit?: string
  isTimeColumn: boolean
  /** Fix C: whether this column is indexed/PK/FK — feeds the cardinality
   * guard's selective-equality-or-IN-predicate check (cardinalityGuard.ts).
   */
  isIndexed?: boolean
  isForeignKeyOrPrimaryKey?: boolean
}

export interface RenderedTable {
  tableId: string
  quotedRef: string
  grain: string
  columns: RenderedColumn[]
  approxRowCount: number
  isLargeTimeSeries: boolean
  /**
   * Additive (not in SPEC §4's inline snippet, but required by
   * promptAssembly.ts's cardinality-warning rendering and by
   * cardinalityGuard.ts's requiredTimeColumn policy — SPEC §5.4). The
   * indexed time column to bound on when isLargeTimeSeries=true, or
   * undefined if the table has no known time column.
   */
  requiredTimeColumn?: string
  /**
   * Fix A (JOINGRAPH_SURFACING.md §8.3): 'primary' survivors render with
   * their full (possibly recall-scoped) column list; 'bridge' tables render
   * as PK/FK-only stubs — they exist to be joined THROUGH, not selected FROM.
   */
  role: 'primary' | 'bridge'
}

export interface JoinHint {
  fromRef: string
  fromColumns: string[]
  toRef: string
  toColumns: string[]
  joinCardinality: string
  crossSource: boolean
}

/** Fix A: a BFS-shortest bridge path connecting two survivor tables through
 * one or more intermediate (bridge) tables (JOINGRAPH_SURFACING.md §8.3).
 */
export interface JoinPath {
  nodes: string[] // tableIds, fromRef -> ... -> toRef, in traversal order
  edges: JoinHint[] // one JoinHint per hop, same order as nodes
  hopCount: number
}

export interface CardinalityWarning {
  tableId: string
  approxRowCount: number
  requiredTimeColumn: string | null
  message: string
}

export interface GlossaryHit {
  term: string
  resolvedColumnId?: string
  timeColumnId?: string
  unit?: string
  /** Fix D (SEMANTIC_HINTS.md §3.2/§8.2/§8.3): the fact table the coded
   * value lives on (the retrieval-pin anchor) + how confident this hit is.
   */
  hostingTableId?: string
  confidence: number
  /** The literal coded value this hit resolves to + a human label for the
   * `-- code N = 'NAME'` prompt provenance comment.
   */
  codeValue?: string | number
  codeLabel?: string
  /** The FK/discriminator column the codeValue filters on. */
  codeColumnId?: string
}

/** One few-shot NL->SQL exemplar surfaced by retrieval (SPEC §1.10, §3.1.3). */
export interface Exemplar {
  id: string
  question: string
  sql: string
  dialect: string
  tables: string[]
  tags: string[]
}

export interface SchemaContext {
  tables: RenderedTable[] // ONLY the survivors, full column detail
  joinHints: JoinHint[] // FK edges among the survivors (from joingraph.json)
  joinPaths: JoinPath[] // Fix A: Tier-2 bridge paths restricted to rendered survivors
  cardinalityWarnings: CardinalityWarning[] // per large table hit (research §3.2a)
  glossaryHits: GlossaryHit[] // term -> column/time-column/unit resolutions used
  exemplars: Exemplar[] // top-k similar NL->SQL pairs (research §3.1.3)
  tokenEstimate: number // rendered-context token budget accounting
  dialect: SqlDialect // from the target QueryEngine (drives §5 generation)
}

export interface RetrieveOptions {
  tokenBudget: number // max tokens for rendered schema context (e.g. 2500)
  maxTables: number // hard cap on survivor tables (e.g. 6) — research §2.3a #4
  sourceScope?: string[] // restrict to sourceIds; undefined = all attached
  recallTables?: number // stage-1 table recall (default 20, research §2.3a #1)
  recallColumns?: number // stage-2 column recall within survivors (default 40)
  exemplarK?: number // few-shot count (default 3)
}

export interface Retriever {
  /** Load a bundle by version (or 'latest'); validates embedding-model id against manifest. */
  load(bundleDir: string): Promise<void>
  /** NL question -> compact, token-budgeted schema context. The core replacement for schemaInjector. */
  retrieve(question: string, opts: RetrieveOptions): Promise<SchemaContext>
}

// ── LLM-prune seam (SPEC §4.1 stage 6) ──────────────────────────────────────

export interface LlmPruneCandidateTable {
  tableId: string
  grain: string
}

/**
 * Injectable LLM-prune function: given the question and the graph-expanded
 * candidate tables (name + one-line grain ONLY — never full columns, SPEC
 * §4.1 stage 6 "the cheap model table names + one-line grains only"), returns
 * the final <= maxTables tableIds to keep, ordered best-first.
 */
export type LlmPrune = (
  question: string,
  candidates: LlmPruneCandidateTable[],
  maxTables: number
) => Promise<string[]>

/**
 * createDeterministicStubLlmPrune — the default STUB used in tests/CI (PLAN
 * §P4 "LLM-prune (stub in CI)"; NL2SQL_PLAN.md §0a decision #3 "CI uses a
 * stubbed/recorded driving LLM"). Deterministically keeps candidates in their
 * incoming (already-ranked) order, truncated to maxTables — i.e. it trusts
 * the upstream hybrid-recall + graph-expand ranking rather than making an
 * independent judgment call, which is the correct stand-in for "no LLM
 * available" without ever calling a real model.
 */
export function createDeterministicStubLlmPrune(): LlmPrune {
  return async (_question, candidates, maxTables) => candidates.slice(0, maxTables).map((c) => c.tableId)
}

// ── token estimation ─────────────────────────────────────────────────────────

/** Cheap, deterministic token estimator (chars/4 — no tokenizer dependency). Consistent with promptAssembly's rendering, which is plain text. */
function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4)
}

function renderTableForEstimate(table: RenderedTable): string {
  const lines = [
    `Table ${table.quotedRef} grain=${table.grain} rows=${table.approxRowCount}`,
    ...table.columns.map((c) => `${c.quotedName} ${c.dataType}${c.unit ? ` unit=${c.unit}` : ''}`),
  ]
  return lines.join('\n')
}

// ── Fix A: pure BFS bridge-path functions (JOINGRAPH_SURFACING.md §2, §8.2) ─
//
// Deliberately free of any HybridRetriever/BundleLoader dependency so they
// are trivially unit-testable against a hand-built adjacency map (see
// lib/rag/__tests__/Retriever.test.ts's bridge-expand tests).

export const MAX_BRIDGE_HOPS = 3
export const MAX_BRIDGE_PATHS = 6
export const HINT_PIN_THRESHOLD = 0.62
export const MAX_SEMANTIC_HINTS = 6

const CARDINALITY_TAG: Record<string, string> = {
  'many-to-one': 'N:1',
  'one-to-many': '1:N',
  'one-to-one': '1:1',
  'many-to-many': 'N:N',
}

/** adjacency: tableId -> list of (neighbor_table_id, joingraph edge). Each
 * edge is inserted TWICE (once per direction) so BFS can walk it either way
 * (undirected reachability, JOINGRAPH_SURFACING.md §2).
 */
export type JoinAdjacency = Map<string, Array<{ neighbor: string; edge: JoinGraphEdge }>>

export function buildJoinAdjacency(edges: JoinGraphEdge[]): JoinAdjacency {
  const adjacency: JoinAdjacency = new Map()
  const add = (from: string, to: string, edge: JoinGraphEdge) => {
    const list = adjacency.get(from) ?? []
    list.push({ neighbor: to, edge })
    adjacency.set(from, list)
  }
  for (const edge of edges) {
    add(edge.from, edge.to, edge)
    add(edge.to, edge.from, edge)
  }
  return adjacency
}

export interface JoinHop {
  from: string
  to: string
  edge: JoinGraphEdge
}

/** BFS shortest path from `start` to `end` over the undirected join graph,
 * capped at `maxHops` edges. Returns null when start === end (a table never
 * needs to "bridge" to itself) or when no path within maxHops exists.
 */
export function bfsShortestPath(
  adjacency: JoinAdjacency,
  start: string,
  end: string,
  maxHops: number = MAX_BRIDGE_HOPS
): JoinHop[] | null {
  if (start === end) return null
  const visited = new Set<string>([start])
  const queue: Array<{ node: string; path: JoinHop[] }> = [{ node: start, path: [] }]
  let qi = 0
  while (qi < queue.length) {
    const { node, path } = queue[qi++]!
    if (path.length >= maxHops) continue
    for (const { neighbor, edge } of adjacency.get(node) ?? []) {
      if (visited.has(neighbor)) continue
      const newPath = [...path, { from: node, to: neighbor, edge }]
      if (neighbor === end) return newPath
      visited.add(neighbor)
      queue.push({ node: neighbor, path: newPath })
    }
  }
  return null
}

function edgeConfidenceSum(hops: JoinHop[]): number {
  return hops.reduce((sum, h) => sum + (h.edge.confidence ?? 1), 0)
}

/**
 * bridgeExpand — JOINGRAPH_SURFACING.md §8.2's algorithm, as a pure function
 * over a plain adjacency map (no bundle/class dependency — trivially
 * unit-testable). For every unordered pair of survivors with NO direct edge
 * between them, finds the BFS shortest path (<= maxHops); collects every
 * intermediate (bridge) node into a set, and every found path, ranked
 * shortest-first then by total edge confidence descending, capped at
 * `maxPaths`.
 */
export function bridgeExpand(
  adjacency: JoinAdjacency,
  survivorIds: string[],
  maxHops: number = MAX_BRIDGE_HOPS,
  maxPaths: number = MAX_BRIDGE_PATHS
): { bridgeNodes: Set<string>; paths: JoinHop[][] } {
  const survivorSet = new Set(survivorIds)
  const directPairs = new Set<string>()
  for (const node of survivorSet) {
    for (const { neighbor } of adjacency.get(node) ?? []) {
      if (survivorSet.has(neighbor)) {
        directPairs.add([node, neighbor].toSorted().join(' '))
      }
    }
  }

  const survivorsSorted = Array.from(survivorSet).toSorted()
  const candidatePaths: JoinHop[][] = []
  const seenPairs = new Set<string>()
  for (let i = 0; i < survivorsSorted.length; i++) {
    for (let j = i + 1; j < survivorsSorted.length; j++) {
      const sI = survivorsSorted[i]!
      const sJ = survivorsSorted[j]!
      const pairKey = [sI, sJ].toSorted().join(' ')
      if (directPairs.has(pairKey) || seenPairs.has(pairKey)) continue
      seenPairs.add(pairKey)
      const path = bfsShortestPath(adjacency, sI, sJ, maxHops)
      if (path) candidatePaths.push(path)
    }
  }

  candidatePaths.sort((a, b) => a.length - b.length || edgeConfidenceSum(b) - edgeConfidenceSum(a))
  const admitted = candidatePaths.slice(0, maxPaths)

  const bridgeNodes = new Set<string>()
  for (const hops of admitted) {
    for (const { from, to } of hops) {
      if (!survivorSet.has(from)) bridgeNodes.add(from)
      if (!survivorSet.has(to)) bridgeNodes.add(to)
    }
  }

  return { bridgeNodes, paths: admitted }
}

// ── HybridRetriever implementation ──────────────────────────────────────────

export interface HybridRetrieverOptions {
  /** Injectable query embedder (SPEC §0 decision #2; PLAN §P4 task 3 option (b)). Required. */
  embedQuery: EmbedQuery
  /** Injectable LLM-prune stage (SPEC §4.1 stage 6). Defaults to the deterministic stub. */
  llmPrune?: LlmPrune
  /** The dialect this SchemaContext targets (from the caller's QueryEngine). Defaults to 'duckdb'. */
  dialect?: SqlDialect
  /** Forwarded to BundleLoader.load(). */
  bundleLoaderOptions?: BundleLoaderOptions
}

const DEFAULT_RECALL_TABLES = 20
const DEFAULT_RECALL_COLUMNS = 40
const DEFAULT_EXEMPLAR_K = 3
const DENSE_VSS_K_MULTIPLIER = 3 // over-fetch dense candidates before RRF, mirrors typical hybrid-search practice

/**
 * HybridRetriever — the SPEC §4 `Retriever` implementation. Coarse-to-fine:
 * glossary-expand -> table recall (hybrid dense+BM25 RRF, importance-biased)
 * -> column recall (scoped) -> FK graph-expand -> LLM-prune (stub-by-default)
 * -> render within tokenBudget/maxTables.
 */
export class HybridRetriever implements Retriever {
  private readonly loader = new BundleLoader()
  private readonly embedQuery: EmbedQuery
  private readonly llmPrune: LlmPrune
  private readonly dialect: SqlDialect
  private readonly bundleLoaderOptions: BundleLoaderOptions
  private vssClient: VssClient | null = null
  private tableBm25: Bm25Index | null = null
  private columnBm25: Bm25Index | null = null
  private tableDocTextById = new Map<string, string>()
  private columnDocTextById = new Map<string, string>()
  private adjacency: JoinAdjacency = new Map()

  constructor(options: HybridRetrieverOptions) {
    this.embedQuery = options.embedQuery
    this.llmPrune = options.llmPrune ?? createDeterministicStubLlmPrune()
    this.dialect = options.dialect ?? 'duckdb'
    this.bundleLoaderOptions = options.bundleLoaderOptions ?? {}
  }

  async load(bundleDir: string): Promise<void> {
    await this.loader.load(bundleDir, this.bundleLoaderOptions)

    const dimension = this.loader.manifest.embeddingModel.dimension
    this.vssClient = new VssClient(this.loader.vectorsDuckdbPath, dimension)

    // Build the two BM25 indexes (table-scoped, column-scoped) from the SAME
    // document text the bundle's vectors.duckdb was embedded from, so lexical
    // and dense retrieval score the identical corpus (SPEC §4.1 "hybrid
    // dense+BM25" implies one shared document set, not two divergent ones).
    const tableDocs: Bm25Document[] = []
    const columnDocs: Bm25Document[] = []
    for (const table of this.loader.catalog.tables) {
      const columnNames = table.columns.map((c) => c.name).join(', ')
      const tableText = `${table.tableId} ${table.quotedRef}: ${table.grain ?? `table ${table.quotedRef}`}. columns: ${columnNames}`
      tableDocs.push({ docId: table.tableId, text: tableText })
      this.tableDocTextById.set(table.tableId, tableText)

      for (const column of table.columns) {
        // Mirror prep's PHI discipline: never index a suppressed column's doc.
        const phi = this.loader.getColumnPhi(column.columnId)
        if (phi && phi.phiClass !== 'non-phi') continue
        const columnText = [column.columnId, column.name, column.dataType, column.unit ? `unit=${column.unit}` : '']
          .filter(Boolean)
          .join(' ')
        columnDocs.push({ docId: column.columnId, text: columnText })
        this.columnDocTextById.set(column.columnId, columnText)
      }
    }
    this.tableBm25 = new Bm25Index(tableDocs)
    this.columnBm25 = new Bm25Index(columnDocs)

    // Fix A (JOINGRAPH_SURFACING.md §6): precompute the adjacency map ONCE
    // at load() time rather than scanning `edges` linearly on every retrieve.
    this.adjacency = buildJoinAdjacency(this.loader.joinGraph.edges)
  }

  private ensureLoaded(): { vss: VssClient; tableBm25: Bm25Index; columnBm25: Bm25Index } {
    if (!this.vssClient || !this.tableBm25 || !this.columnBm25) {
      throw new Error('HybridRetriever: load() must succeed before calling retrieve().')
    }
    return { vss: this.vssClient, tableBm25: this.tableBm25, columnBm25: this.columnBm25 }
  }

  async dispose(): Promise<void> {
    await this.vssClient?.dispose()
  }

  // ── stage 1: expand + normalize the question ─────────────────────────────

  // SEMANTIC_HINTS.md §7 stop-token deny-list: bare short ambiguous
  // abbreviations that are common English words — a bare-form match only
  // fires when a multi-word alias for the SAME term also matched.
  private static readonly AMBIGUOUS_BARE_TERM_DENYLIST = new Set(['map', 'temp', 'pa', 'sap'])

  private expandQuestion(question: string): { expanded: string; glossaryHits: GlossaryHit[] } {
    const { abbreviations, synonyms, autoSynonyms } = this.loader.glossary
    const glossaryHits: GlossaryHit[] = []
    const lowerQuestion = question.toLowerCase()
    const expandedTerms: string[] = [question]

    // Abbreviation expansion (research §2.2 "the clinicalContext expansion, now data-driven").
    for (const [abbr, full] of Object.entries(abbreviations)) {
      const pattern = new RegExp(`\\b${abbr.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i')
      if (pattern.test(question)) expandedTerms.push(full)
    }

    // Synonym resolution — feeds glossaryHits (term -> column/time-column/unit).
    for (const synonym of synonyms) {
      const candidateTerms = [synonym.term, ...synonym.aliases]
      const matched = candidateTerms.some((t) => lowerQuestion.includes(t.toLowerCase()))
      if (!matched) continue

      expandedTerms.push(synonym.term, ...synonym.aliases)
      for (const map of synonym.maps) {
        glossaryHits.push(this.glossaryHitFromMap(synonym.term, map, 1.0))
      }
    }

    // Fix D (SEMANTIC_HINTS.md §3.2/§8.2): machine-mined hint matrix, kept
    // separate from hand-seeded `synonyms` for auditable provenance.
    // Backward compatible: `autoSynonyms` may be absent on an older bundle.
    for (const autoSynonym of autoSynonyms ?? []) {
      const { term, aliases, confidence } = autoSynonym
      const candidateTerms = [term, ...aliases]

      const matchedMultiWordAlias = candidateTerms.some(
        (t) => t.includes(' ') && lowerQuestion.includes(t.toLowerCase())
      )
      let matchedBare = false
      for (const t of candidateTerms) {
        if (t.includes(' ')) continue
        const pattern = new RegExp(`\\b${t.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i')
        if (!pattern.test(lowerQuestion)) continue
        if (HybridRetriever.AMBIGUOUS_BARE_TERM_DENYLIST.has(t.toLowerCase()) && !matchedMultiWordAlias) continue
        matchedBare = true
        break
      }

      if (!matchedMultiWordAlias && !matchedBare) continue

      expandedTerms.push(term, ...aliases)
      for (const map of autoSynonym.maps) {
        glossaryHits.push(this.glossaryHitFromMap(term, map, confidence))
      }
    }

    return { expanded: expandedTerms.join(' '), glossaryHits }
  }

  private glossaryHitFromMap(term: string, map: GlossaryMap, confidence: number): GlossaryHit {
    switch (map.kind) {
      case 'coded-measurement': {
        // Fix D §3.3: hostingTableId is the load-bearing retrieval-pin
        // field. Prefer an explicit `hostingTableId` (auto-mined maps
        // always carry it); derive it from valueColumnId's table for
        // backward compat with hand-seeded entries that don't carry it yet.
        const hostingTableId =
          map.hostingTableId ?? map.valueColumnId.split('.').slice(0, -1).join('.')
        return {
          term,
          resolvedColumnId: map.valueColumnId,
          timeColumnId: map.timeColumnId,
          unit: map.unit,
          hostingTableId,
          confidence,
          codeValue: map.codeValue,
          codeLabel: map.codeLabel ?? (typeof map.codeValue === 'string' ? map.codeValue : undefined),
          codeColumnId: map.codeColumnId,
        }
      }
      case 'column':
        return { term, resolvedColumnId: map.columnId, timeColumnId: map.timeColumnId, unit: map.unit, confidence }
      case 'temporal-column':
        return { term, timeColumnId: map.columnId, confidence }
      case 'table':
        return { term, confidence }
      case 'derived':
        return { term, resolvedColumnId: map.toColumnId, confidence }
      default: {
        // Exhaustiveness guard: if a new GlossaryMap variant is added to
        // BundleLoader.ts without updating this switch, fail loudly at
        // compile time (never silently drop a glossary hit at runtime).
        const exhaustive: never = map
        return exhaustive
      }
    }
  }

  // ── stage 3: hybrid table recall ──────────────────────────────────────────

  private async recallTables(
    expandedQuestion: string,
    sourceScope: string[] | undefined,
    recallTables: number
  ): Promise<string[]> {
    const { vss, tableBm25 } = this.ensureLoaded()

    const queryEmbedding = await this.embedQuery(expandedQuestion)
    const denseHits = await vss.search(queryEmbedding, {
      docKind: 'table' as VssDocKind,
      sourceIds: sourceScope,
      k: recallTables * DENSE_VSS_K_MULTIPLIER,
    })
    const denseRanked: RankedItem[] = denseHits.map((hit) => ({ id: hit.refId, score: -hit.distance }))

    const scopedTableIds = sourceScope
      ? new Set(this.loader.catalog.tables.filter((t) => sourceScope.includes(t.sourceId)).map((t) => t.tableId))
      : undefined
    const bm25Hits = tableBm25.search(expandedQuestion, recallTables * DENSE_VSS_K_MULTIPLIER, scopedTableIds)
    const bm25Ranked: RankedItem[] = bm25Hits.map((hit) => ({ id: hit.docId, score: hit.score }))

    // Importance bias (SPEC §4.1 stage 3 "bias by importanceScore, research
    // §2.3a #3"): weight the dense channel's contribution per-table by its
    // catalog importanceScore via a per-item score multiplier folded into a
    // THIRD synthetic ranking so RRF's rank-based fusion (which ignores raw
    // scores) still reflects importance — a table with high importance but a
    // middling recall rank is nudged up by appearing in this list too.
    const importanceRanked: RankedItem[] = this.loader.catalog.tables
      .toSorted((a, b) => b.importanceScore - a.importanceScore)
      .map((t) => ({ id: t.tableId, score: t.importanceScore }))

    const fused = fuseTwo(denseRanked, bm25Ranked, { weights: { dense: 1, bm25: 1 } })
    const fusedWithImportance = fuseRankingsWithImportance(fused, importanceRanked)

    return fusedWithImportance.slice(0, recallTables).map((f) => f.id)
  }

  // ── stage 4: hybrid column recall, scoped to survivor tables ─────────────

  private async recallColumns(
    expandedQuestion: string,
    survivorTableIds: string[],
    recallColumns: number
  ): Promise<string[]> {
    const { vss, columnBm25 } = this.ensureLoaded()

    const queryEmbedding = await this.embedQuery(expandedQuestion)
    const denseHits = await vss.search(queryEmbedding, {
      docKind: 'column' as VssDocKind,
      refIdPrefixes: survivorTableIds.map((t) => `${t}.`),
      k: recallColumns * DENSE_VSS_K_MULTIPLIER,
    })
    const denseRanked: RankedItem[] = denseHits.map((hit) => ({ id: hit.refId, score: -hit.distance }))

    const survivorColumnIds = new Set(
      survivorTableIds.flatMap((tableId) => {
        const table = this.loader.getTable(tableId)
        return table ? table.columns.map((c) => c.columnId) : []
      })
    )
    const bm25Hits = columnBm25.search(expandedQuestion, recallColumns * DENSE_VSS_K_MULTIPLIER, survivorColumnIds)
    const bm25Ranked: RankedItem[] = bm25Hits.map((hit) => ({ id: hit.docId, score: hit.score }))

    const fused = fuseTwo(denseRanked, bm25Ranked)
    return fused.slice(0, recallColumns).map((f) => f.id)
  }

  // ── stage 5: FK graph-expand ───────────────────────────────────────────────

  private graphExpand(survivorTableIds: string[]): string[] {
    const survivorSet = new Set(survivorTableIds)
    for (const edge of this.loader.joinGraph.edges) {
      if (survivorSet.has(edge.from)) survivorSet.add(edge.to)
      if (survivorSet.has(edge.to)) survivorSet.add(edge.from)
    }
    return Array.from(survivorSet)
  }

  // ── Fix A stage: BFS bridge-expand (JOINGRAPH_SURFACING.md §2, §3, §8.2) ──

  private bridgeExpandSurvivors(recalledSurvivorIds: string[]): { bridgeNodes: Set<string>; joinPaths: JoinPath[] } {
    const { bridgeNodes, paths } = bridgeExpand(this.adjacency, recalledSurvivorIds, MAX_BRIDGE_HOPS, MAX_BRIDGE_PATHS)

    const joinPaths: JoinPath[] = paths.map((hops) => {
      const nodes = [hops[0]!.from, ...hops.map((h) => h.to)]
      const edges: JoinHint[] = hops.map(({ edge }) => {
        const fromTable = this.loader.getTable(edge.from)
        const toTable = this.loader.getTable(edge.to)
        return {
          fromRef: fromTable?.quotedRef ?? edge.from,
          fromColumns: edge.fromColumns,
          toRef: toTable?.quotedRef ?? edge.to,
          toColumns: edge.toColumns,
          joinCardinality: edge.joinCardinality,
          crossSource: edge.crossSource,
        }
      })
      return { nodes, edges, hopCount: hops.length }
    })

    return { bridgeNodes, joinPaths }
  }

  private static restrictJoinPathsToRendered(joinPaths: JoinPath[], renderedTableIds: Set<string>): JoinPath[] {
    return joinPaths.filter((jp) => jp.nodes.every((n) => renderedTableIds.has(n)))
  }

  // ── stage 7: render ─────────────────────────────────────────────────────────

  private fkFromColumnsByTable(tableId: string): Set<string> {
    const names = new Set<string>()
    for (const edge of this.loader.joinGraph.edges) {
      if (edge.from === tableId) {
        for (const col of edge.fromColumns) names.add(col)
      }
    }
    return names
  }

  private renderTable(table: CatalogTable, columnIdAllowlist?: Set<string>, role: 'primary' | 'bridge' = 'primary'): RenderedTable {
    const requiredTimeColumn = table.columns.find((c) => c.isTimeColumn)?.quotedName
    const fkColumnNames = this.fkFromColumnsByTable(table.tableId)
    const sourceColumns =
      role === 'bridge'
        ? table.columns.filter((c) => c.isPrimaryKey || fkColumnNames.has(c.name))
        : table.columns.filter((c) => !columnIdAllowlist || columnIdAllowlist.has(c.columnId) || c.isPrimaryKey)
    const columns = sourceColumns.map((c) => ({
      name: c.name,
      quotedName: c.quotedName,
      dataType: c.dataType,
      unit: c.unit ?? undefined,
      isTimeColumn: c.isTimeColumn,
      isIndexed: c.isIndexed,
      isForeignKeyOrPrimaryKey: c.isPrimaryKey || fkColumnNames.has(c.name),
    }))
    const profile = this.loader.getTableProfile(table.tableId)
    return {
      tableId: table.tableId,
      quotedRef: table.quotedRef,
      grain: table.grain ?? `table ${table.quotedRef}`,
      columns,
      approxRowCount: profile?.approxRowCount ?? 0,
      isLargeTimeSeries: table.isLargeTimeSeries,
      requiredTimeColumn,
      role,
    }
  }

  private buildCardinalityWarning(table: RenderedTable): CardinalityWarning {
    const rowsDesc = table.approxRowCount.toLocaleString('en-US')
    const timeCol = table.requiredTimeColumn
    const timeBoundInstruction = timeCol
      ? `you MUST include a time-bound predicate on ${timeCol}`
      : 'you MUST include a bounding predicate that limits the scan'
    return {
      tableId: table.tableId,
      approxRowCount: table.approxRowCount,
      requiredTimeColumn: timeCol ?? null,
      message: `${table.quotedRef} has ~${rowsDesc} rows; ${timeBoundInstruction} and a LIMIT; do not scan unbounded.`,
    }
  }

  private buildJoinHints(survivorTableIds: string[]): JoinHint[] {
    const survivorSet = new Set(survivorTableIds)
    return this.loader.joinGraph.edges
      .filter((edge) => survivorSet.has(edge.from) && survivorSet.has(edge.to))
      .map((edge) => {
        const fromTable = this.loader.getTable(edge.from)
        const toTable = this.loader.getTable(edge.to)
        return {
          fromRef: fromTable?.quotedRef ?? edge.from,
          fromColumns: edge.fromColumns,
          toRef: toTable?.quotedRef ?? edge.to,
          toColumns: edge.toColumns,
          joinCardinality: edge.joinCardinality,
          crossSource: edge.crossSource,
        }
      })
  }

  private recallExemplars(question: string, exemplarK: number): Exemplar[] {
    const exemplars = this.loader.exemplars.exemplars
    if (exemplars.length === 0) return []
    const bm25 = new Bm25Index(exemplars.map((e) => ({ docId: e.id, text: e.question })))
    const hits = bm25.search(question, exemplarK)
    const byId = new Map(exemplars.map((e) => [e.id, e]))
    const picked = hits.length > 0 ? hits.map((h) => byId.get(h.docId)).filter((e): e is (typeof exemplars)[number] => !!e) : exemplars.slice(0, exemplarK)
    return picked.map((e) => ({ id: e.id, question: e.question, sql: e.sql, dialect: e.dialect, tables: e.tables, tags: e.tags }))
  }

  // ── the public retrieve() pipeline ─────────────────────────────────────────

  async retrieve(question: string, opts: RetrieveOptions): Promise<SchemaContext> {
    this.ensureLoaded()

    const recallTablesCount = opts.recallTables ?? DEFAULT_RECALL_TABLES
    const recallColumnsCount = opts.recallColumns ?? DEFAULT_RECALL_COLUMNS
    const exemplarK = opts.exemplarK ?? DEFAULT_EXEMPLAR_K

    // 1. expand + normalize
    const { expanded, glossaryHits } = this.expandQuestion(question)

    // 2. domain/schema prune — degrades to sourceScope-only when catalog
    // carries no populated `domain` tags (documented BundleLoader.ts deviation).
    const sourceScope = opts.sourceScope

    // 3. table recall (hybrid dense+BM25 RRF, importance-biased)
    let recalledTableIds = await this.recallTables(expanded, sourceScope, recallTablesCount)

    // Fix D §4.2/§8.3 — the RETRIEVAL PIN: a matched glossary hint's hosting
    // table is injected at rank 0, AHEAD of the dense/BM25 fused list,
    // bypassing dense/BM25 entirely for a known coded-measurement hit.
    const pinnedTableIds = glossaryHits
      .filter((h) => h.hostingTableId && h.confidence >= HINT_PIN_THRESHOLD)
      .map((h) => h.hostingTableId as string)
    {
      const seen = new Set<string>()
      const ordered: string[] = []
      for (const tid of [...pinnedTableIds, ...recalledTableIds]) {
        if (seen.has(tid)) continue
        seen.add(tid)
        ordered.push(tid)
      }
      recalledTableIds = ordered
    }

    // 4. column recall, scoped to stage-3 survivors
    const recalledColumnIds = await this.recallColumns(expanded, recalledTableIds, recallColumnsCount)
    const recalledColumnIdSet = new Set(recalledColumnIds)

    // 5. FK graph-expand — preserve pin-then-recall rank order through
    // expansion (newly-reachable FK neighbors appended after the already-
    // ordered recalledTableIds) so a tight maxTables cap still respects the pin.
    let expandedTableIds = this.graphExpand(recalledTableIds)
    {
      const ordered = [...recalledTableIds]
      const seen = new Set(ordered)
      for (const tid of expandedTableIds) {
        if (seen.has(tid)) continue
        seen.add(tid)
        ordered.push(tid)
      }
      expandedTableIds = ordered
    }

    // Fix A §2/§3 — BFS bridge-expand + bridge-protect: pull in the shortest
    // connecting paths (and their intermediate bridge tables) between
    // survivor pairs with no direct edge, BEFORE LLM-prune runs.
    const { bridgeNodes, joinPaths } = this.bridgeExpandSurvivors(expandedTableIds)
    const candidateIds = [...expandedTableIds]
    {
      const seen = new Set(candidateIds)
      for (const tid of bridgeNodes) {
        if (seen.has(tid)) continue
        seen.add(tid)
        candidateIds.push(tid)
      }
    }

    // 6. LLM-prune (stub by default) — down to <= maxTables
    const candidates: LlmPruneCandidateTable[] = candidateIds.map((tableId) => {
      const table = this.loader.getTable(tableId)
      return { tableId, grain: table?.grain ?? `table ${tableId}` }
    })
    const prunedTableIds = await this.llmPrune(question, candidates, opts.maxTables)

    // Bridge-protect (+ pin-protect): reserve slots for protected tables
    // (pins ahead of bridges) so a tight maxTables cap does not silently
    // drop a "guaranteed recall" hit or a needed bridge table.
    const protectedOrdered = [
      ...pinnedTableIds.filter((t) => candidateIds.includes(t)),
      ...Array.from(bridgeNodes).filter((t) => candidateIds.includes(t) && !pinnedTableIds.includes(t)),
    ]

    let finalTableIds = prunedTableIds.slice(0, opts.maxTables)
    const missingProtected = protectedOrdered.filter((t) => !finalTableIds.includes(t))
    if (missingProtected.length > 0 && finalTableIds.length + missingProtected.length <= opts.maxTables) {
      finalTableIds = [...finalTableIds, ...missingProtected]
    } else if (missingProtected.length > 0) {
      const protectedCapped = missingProtected.slice(0, opts.maxTables)
      const nonProtectedRanked = prunedTableIds.filter((t) => !protectedOrdered.includes(t))
      const roomForNonProtected = Math.max(opts.maxTables - protectedCapped.length, 0)
      finalTableIds = [...protectedCapped, ...nonProtectedRanked.slice(0, roomForNonProtected)]
    }

    const primaryRenderedIds = new Set([...recalledTableIds, ...finalTableIds.filter((t) => !bridgeNodes.has(t))])

    // 7. render within tokenBudget
    const renderedTables: RenderedTable[] = []
    let runningTokens = 0
    for (const tableId of finalTableIds) {
      const table = this.loader.getTable(tableId)
      if (!table) continue
      const role: 'primary' | 'bridge' = bridgeNodes.has(tableId) && !primaryRenderedIds.has(tableId) ? 'bridge' : 'primary'
      // Only the original recall (not graph-expanded) columns get scoped
      // filtering; graph-expanded tables (join partners) render in full so
      // their join columns are always visible.
      const columnAllowlist = recalledTableIds.includes(tableId) ? recalledColumnIdSet : undefined
      const rendered = this.renderTable(table, columnAllowlist, role)
      const renderedTokens = estimateTokens(renderTableForEstimate(rendered))
      if (renderedTables.length > 0 && runningTokens + renderedTokens > opts.tokenBudget) {
        // Bridge tables are protected from the token-budget cut too, as long
        // as at least one non-bridge table already rendered.
        if (role === 'bridge') {
          renderedTables.push(rendered)
          runningTokens += renderedTokens
          continue
        }
        break
      }
      renderedTables.push(rendered)
      runningTokens += renderedTokens
    }

    const renderedTableIds = new Set(renderedTables.map((t) => t.tableId))
    const cardinalityWarnings = renderedTables.filter((t) => t.isLargeTimeSeries).map((t) => this.buildCardinalityWarning(t))
    const joinHints = this.buildJoinHints(renderedTables.map((t) => t.tableId))
    const renderedJoinPaths = HybridRetriever.restrictJoinPathsToRendered(joinPaths, renderedTableIds)
    const exemplars = this.recallExemplars(question, exemplarK)

    return {
      tables: renderedTables,
      joinHints,
      joinPaths: renderedJoinPaths,
      cardinalityWarnings,
      glossaryHits,
      exemplars,
      tokenEstimate: runningTokens,
      dialect: this.dialect,
    }
  }
}

/** Folds an importance-ranked list into an already-RRF-fused list as a third contribution (see recallTables). */
function fuseRankingsWithImportance(
  fused: { id: string; fusedScore: number }[],
  importanceRanked: RankedItem[]
): { id: string; fusedScore: number }[] {
  const importanceRank = new Map<string, number>()
  importanceRanked.forEach((item, index) => importanceRank.set(item.id, index + 1))
  const k = 60
  return fused
    .map((item) => {
      const rank = importanceRank.get(item.id)
      const importanceContribution = rank ? 1 / (k + rank) : 0
      return { id: item.id, fusedScore: item.fusedScore + importanceContribution }
    })
    .toSorted((a, b) => b.fusedScore - a.fusedScore)
}

export { EXPECTED_EMBEDDING_MODEL_ID }
