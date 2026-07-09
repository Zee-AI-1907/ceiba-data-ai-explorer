/**
 * retriever.test.ts — NL2SQL_PLAN.md §P4 test list. Exercises the full
 * `HybridRetriever` coarse-to-fine pipeline (NL2SQL_SPEC.md §4.1) against the
 * committed tiny fixture bundle (lib/rag/__tests__/fixtures/bundles/mock-v1),
 * built via `ceiba-nl2sql-prep build --only mock --test-fallback-embedder`
 * against the OrbStack mock Postgres (docs/mock-topology.md).
 *
 * Hermetic/CI-safe (NL2SQL_PLAN.md §0 ground rule #4): no network, no live
 * DB, no model download.
 *   - The query embedder is `createDeterministicTestEmbedder()` — the SAME
 *     hash-projection scheme `prep`'s `--test-fallback-embedder` used to build
 *     the fixture's vectors.duckdb, so query vectors land in the identical
 *     vector space as the fixture's document vectors.
 *   - The LLM-prune stage uses the default deterministic stub
 *     (`createDeterministicStubLlmPrune`) — no live model call.
 *   - `vectors.duckdb` is opened read-only directly from the committed
 *     fixture directory on disk.
 */

import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { HybridRetriever, bfsShortestPath, bridgeExpand, buildJoinAdjacency, type LlmPrune } from '../Retriever'
import { createDeterministicTestEmbedder } from '../vssClient'
import { TEST_FALLBACK_EMBEDDING_MODEL_ID, type JoinGraphEdge } from '../BundleLoader'

const FIXTURE_BUNDLE_DIR = path.join(__dirname, 'fixtures', 'bundles', 'mock-v1')
const HEART_RATE_QUESTION = 'heart rate over 120 in the last 3 hours'

async function createLoadedRetriever(llmPrune?: LlmPrune): Promise<HybridRetriever> {
  const retriever = new HybridRetriever({
    embedQuery: createDeterministicTestEmbedder(384),
    llmPrune,
    bundleLoaderOptions: { expectedEmbeddingModelId: TEST_FALLBACK_EMBEDDING_MODEL_ID },
  })
  await retriever.load(FIXTURE_BUNDLE_DIR)
  return retriever
}

describe('HybridRetriever — canonical question: heart rate over 120 in the last 3 hours', () => {
  let retriever: HybridRetriever

  beforeEach(async () => {
    retriever = await createLoadedRetriever()
  })

  afterEach(async () => {
    await retriever.dispose()
  })

  it('returns the MeasurementsMock table with its RecordedAt time column, plus a cardinality warning', async () => {
    const context = await retriever.retrieve(HEART_RATE_QUESTION, { tokenBudget: 4000, maxTables: 6 })

    const measurements = context.tables.find((t) => t.tableId === 'mock.public.MeasurementsMock')
    expect(measurements).toBeDefined()
    expect(measurements?.isLargeTimeSeries).toBe(true)
    const timeColumn = measurements?.columns.find((c) => c.isTimeColumn)
    expect(timeColumn?.name).toBe('RecordedAt')

    const warning = context.cardinalityWarnings.find((w) => w.tableId === 'mock.public.MeasurementsMock')
    expect(warning).toBeDefined()
    expect(warning?.requiredTimeColumn).toBe('"RecordedAt"')
    expect(warning?.message.toLowerCase()).toContain('limit')
    expect(warning?.message).toContain('RecordedAt')

    expect(context.dialect).toBe('duckdb')
  })

  it('graph-expands to an FK partner of MeasurementsMock (MeasurementTypeRef or PatientMock)', async () => {
    const context = await retriever.retrieve(HEART_RATE_QUESTION, { tokenBudget: 4000, maxTables: 6 })
    const tableIds = new Set(context.tables.map((t) => t.tableId))
    const hasFkPartner = tableIds.has('mock.public.MeasurementTypeRef') || tableIds.has('mock.public.PatientMock')
    expect(hasFkPartner).toBe(true)

    // The join hint for whichever partner survived must be present among joinHints.
    const joinHint = context.joinHints.find(
      (h) => h.fromRef === '"public"."MeasurementsMock"' || h.toRef === '"public"."MeasurementsMock"'
    )
    expect(joinHint).toBeDefined()
  })

  it('resolves "heart rate" via the glossary into a glossaryHit pointing at MeasurementsMock.Value/RecordedAt', async () => {
    const context = await retriever.retrieve(HEART_RATE_QUESTION, { tokenBudget: 4000, maxTables: 6 })
    const hit = context.glossaryHits.find((h) => h.term === 'heart rate')
    expect(hit).toBeDefined()
    expect(hit?.resolvedColumnId).toBe('mock.public.MeasurementsMock.Value')
    expect(hit?.timeColumnId).toBe('mock.public.MeasurementsMock.RecordedAt')
    expect(hit?.unit).toBe('bpm')
  })

  it('surfaces the heart-rate exemplar among context.exemplars', async () => {
    const context = await retriever.retrieve(HEART_RATE_QUESTION, { tokenBudget: 4000, maxTables: 6, exemplarK: 3 })
    expect(context.exemplars.length).toBeGreaterThan(0)
    const found = context.exemplars.some((e) => e.id === 'ex_heart_rate_over_120_last_3h')
    expect(found).toBe(true)
  })

  it('honors maxTables as a hard cap', async () => {
    const context = await retriever.retrieve(HEART_RATE_QUESTION, { tokenBudget: 4000, maxTables: 1 })
    expect(context.tables.length).toBeLessThanOrEqual(1)
  })

  it('honors tokenBudget by not exceeding it while still returning at least one table', async () => {
    const context = await retriever.retrieve(HEART_RATE_QUESTION, { tokenBudget: 50, maxTables: 6 })
    expect(context.tables.length).toBeGreaterThanOrEqual(1)
    // The FIRST table is always admitted even if it alone would slightly
    // exceed a very tight budget (never return zero tables); subsequent
    // tables must respect the budget.
    if (context.tables.length > 1) {
      expect(context.tokenEstimate).toBeLessThanOrEqual(50 + 1)
    }
  })
})

describe('HybridRetriever — second canonical question: patients admitted yesterday', () => {
  let retriever: HybridRetriever

  beforeEach(async () => {
    retriever = await createLoadedRetriever()
  })

  afterEach(async () => {
    await retriever.dispose()
  })

  it('returns VisitMock (admission table) within maxTables/tokenBudget', async () => {
    const context = await retriever.retrieve('patients admitted yesterday', { tokenBudget: 4000, maxTables: 6 })
    const tableIds = context.tables.map((t) => t.tableId)
    expect(tableIds).toContain('mock.public.VisitMock')
    expect(context.tables.length).toBeLessThanOrEqual(6)
  })
})

describe('HybridRetriever — BM25 finds an exact identifier the dense side would garble', () => {
  it('a literal, mixed-case identifier query surfaces the matching table via lexical recall', async () => {
    const retriever = await createLoadedRetriever()
    try {
      // "MeasurementsMock" is an exact PascalCase identifier. A purely dense
      // retriever over paraphrastic text could plausibly rank it below a
      // more "semantically typical" table for a garbled/unnatural query
      // string; BM25's exact-token match (via bm25.ts's camelCase
      // sub-tokenization) is what guarantees recall here.
      const context = await retriever.retrieve('MeasurementsMock', { tokenBudget: 4000, maxTables: 3 })
      const tableIds = context.tables.map((t) => t.tableId)
      expect(tableIds).toContain('mock.public.MeasurementsMock')
    } finally {
      await retriever.dispose()
    }
  })
})

/** Keeps only the first graph-expanded candidate — proves a custom LlmPrune is honored over the default stub. */
const keepOnlyFirstCandidateStub: LlmPrune = async (_q, candidates) => candidates.slice(0, 1).map((c) => c.tableId)

describe('HybridRetriever — LLM-prune stub is injectable and deterministic', () => {
  it('a custom stub that always keeps only the first candidate is honored', async () => {
    const retriever = await createLoadedRetriever(keepOnlyFirstCandidateStub)
    try {
      const context = await retriever.retrieve(HEART_RATE_QUESTION, { tokenBudget: 4000, maxTables: 6 })
      expect(context.tables.length).toBe(1)
    } finally {
      await retriever.dispose()
    }
  })
})

describe('HybridRetriever — embedding-model mismatch is refused at load()', () => {
  it('rejects loading the fixture bundle under the REAL production model id expectation', async () => {
    const retriever = new HybridRetriever({
      embedQuery: createDeterministicTestEmbedder(384),
      bundleLoaderOptions: { expectedEmbeddingModelId: 'bge-small-en-v1.5' },
    })
    await expect(retriever.load(FIXTURE_BUNDLE_DIR)).rejects.toThrow(/embeddingModel\.id/)
  })
})

// ── Fix A: pure BFS bridge-path functions (JOINGRAPH_SURFACING.md §2, §8.2) ─
//
// mock-v1's own joingraph.json is FLAT, so these tests hand-build a MINIMAL
// 3-hop adjacency shaped like the REAL staging bridge (MonitorMeasurements ->
// Monitors -> Acceptances -> Patients) — no bundle/retriever needed at all.

function realStagingShapedEdges(): JoinGraphEdge[] {
  return [
    {
      from: 'staging.Shared.MonitorMeasurements',
      fromColumns: ['DeviceId'],
      to: 'staging.Shared.Monitors',
      toColumns: ['Id'],
      joinCardinality: 'many-to-one',
      crossSource: false,
      origin: 'declared',
      confidence: 1.0,
    },
    {
      from: 'staging.Shared.Monitors',
      fromColumns: ['AcceptanceId'],
      to: 'staging.Shared.Acceptances',
      toColumns: ['Id'],
      joinCardinality: 'many-to-one',
      crossSource: false,
      origin: 'declared',
      confidence: 1.0,
    },
    {
      from: 'staging.Shared.Acceptances',
      fromColumns: ['PatientId'],
      to: 'staging.Shared.Patients',
      toColumns: ['Id'],
      joinCardinality: 'many-to-one',
      crossSource: false,
      origin: 'declared',
      confidence: 1.0,
    },
    {
      from: 'staging.Shared.MonitorMeasurements',
      fromColumns: ['MeasurementTypeId'],
      to: 'staging.Shared.MonitorMeasurementTypes',
      toColumns: ['Id'],
      joinCardinality: 'many-to-one',
      crossSource: false,
      origin: 'declared',
      confidence: 1.0,
    },
  ]
}

describe('bfsShortestPath / bridgeExpand — pure BFS bridge-path functions', () => {
  it('finds the 3-hop bridge from MonitorMeasurements to Patients', () => {
    const adjacency = buildJoinAdjacency(realStagingShapedEdges())
    const path = bfsShortestPath(adjacency, 'staging.Shared.MonitorMeasurements', 'staging.Shared.Patients', 3)
    expect(path).not.toBeNull()
    expect(path).toHaveLength(3)
    const intermediateNodes = new Set(path!.slice(0, -1).map((hop) => hop.to))
    expect(intermediateNodes).toEqual(new Set(['staging.Shared.Monitors', 'staging.Shared.Acceptances']))
  })

  it('returns null beyond maxHops', () => {
    const adjacency = buildJoinAdjacency(realStagingShapedEdges())
    const path = bfsShortestPath(adjacency, 'staging.Shared.MonitorMeasurements', 'staging.Shared.Patients', 2)
    expect(path).toBeNull()
  })

  it('returns null for identical start and end', () => {
    const adjacency = buildJoinAdjacency(realStagingShapedEdges())
    expect(bfsShortestPath(adjacency, 'staging.Shared.Patients', 'staging.Shared.Patients')).toBeNull()
  })

  it('bridgeExpand pulls in Monitors and Acceptances as bridge nodes for the HR failure mode', () => {
    const adjacency = buildJoinAdjacency(realStagingShapedEdges())
    const survivors = ['staging.Shared.MonitorMeasurements', 'staging.Shared.Patients']
    const { bridgeNodes, paths } = bridgeExpand(adjacency, survivors, 3, 6)

    expect(bridgeNodes).toEqual(new Set(['staging.Shared.Monitors', 'staging.Shared.Acceptances']))
    expect(paths).toHaveLength(1)
    expect(paths[0]![0]!.from).toBe('staging.Shared.MonitorMeasurements')
    expect(paths[0]!.at(-1)!.to).toBe('staging.Shared.Patients')
  })

  it('bridgeExpand finds no bridge needed when a direct edge already connects the pair', () => {
    const adjacency = buildJoinAdjacency(realStagingShapedEdges())
    const survivors = ['staging.Shared.MonitorMeasurements', 'staging.Shared.MonitorMeasurementTypes']
    const { bridgeNodes, paths } = bridgeExpand(adjacency, survivors, 3, 6)
    expect(bridgeNodes.size).toBe(0)
    expect(paths).toHaveLength(0)
  })
})

// ── Fix D: retrieval pin + glossary hint fields ─────────────────────────────

describe('HybridRetriever — Fix D retrieval pin + glossary hint fields', () => {
  it('the "heart rate" glossaryHit carries hostingTableId + codeValue', async () => {
    const retriever = await createLoadedRetriever()
    try {
      const context = await retriever.retrieve(HEART_RATE_QUESTION, { tokenBudget: 4000, maxTables: 6 })
      const hit = context.glossaryHits.find((h) => h.term === 'heart rate')
      expect(hit).toBeDefined()
      expect(hit?.hostingTableId).toBe('mock.public.MeasurementsMock')
      expect(hit?.confidence).toBeGreaterThanOrEqual(0.62)
      expect(hit?.codeValue).toBe('Heart Rate')
      expect(hit?.codeColumnId).toBe('mock.public.MeasurementsMock.MeasurementTypeId')
    } finally {
      await retriever.dispose()
    }
  })

  it('the pinned hosting table is present in ctx.tables even under a tight maxTables', async () => {
    const retriever = await createLoadedRetriever()
    try {
      const context = await retriever.retrieve(HEART_RATE_QUESTION, { tokenBudget: 4000, maxTables: 3 })
      const hit = context.glossaryHits.find((h) => h.term === 'heart rate')
      const tableIds = context.tables.map((t) => t.tableId)
      expect(hit?.hostingTableId).toBeDefined()
      expect(tableIds).toContain(hit!.hostingTableId!)
    } finally {
      await retriever.dispose()
    }
  })
})
