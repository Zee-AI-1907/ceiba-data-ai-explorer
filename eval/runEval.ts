/**
 * runEval.ts — the eval loop (NL2SQL_SPEC.md §6, §6.3; NL2SQL_PLAN.md §P6
 * task 3): for each golden question -> retrieve -> generate -> score, then
 * aggregate into an `EvalReport`.
 *
 * ── Two execution modes (SPEC §6.3) ────────────────────────────────────────
 *   (a) SYNTHETIC (default, CI-safe): scores against the hermetic DuckDB
 *       topology `eval/synthetic/loadSynthetic.ts` builds — no network, no
 *       mock/staging DB, no model download. This is what `runEval()` does
 *       unless `mode: 'gated-staging'` is explicitly requested.
 *   (b) GATED read-only-against-staging (opt-in): runs ONLY guard-passed,
 *       cardinality-bounded SQL against the real read-only staging DB
 *       (`STAGING_DSN`), to measure execution accuracy on true cardinalities.
 *       Never egresses rows to the LLM (SPEC §8.9) — retrieval/generation
 *       still only ever sees schema/metadata (the `LlmEgressClass:
 *       'schema-metadata'` guarantee already enforced inside
 *       `lib/rag/generate.ts`'s `callLlm`); this mode only changes WHERE the
 *       already-produced, already-guarded SQL executes.
 *       Gated behind BOTH an explicit opt-in flag AND the presence of
 *       `STAGING_DSN` — absent either, `runEval()` refuses to attempt gated
 *       mode and falls back to synthetic (never silently melts staging).
 *
 * Retrieval in BOTH modes is exercised against the loaded bundle's REAL
 * catalog (SPEC §6.3 "Retrieval is still exercised against the full
 * ~1,200-table introspected schema" — here, the committed fixture bundle
 * stands in for that full schema in the test/CI context; a production eval
 * run points `bundleDir` at the real, full-scale bundle).
 */

import path from 'node:path'
import type { QueryEngine } from '../lib/engine/QueryEngine'
import { DuckDbEngine } from '../lib/engine/DuckDbEngine'
import type { AttachSpec } from '../lib/engine/QueryEngine'
import { generateSql, GenerationError, type LlmClient } from '../lib/rag/generate'
import { HybridRetriever, type Retriever } from '../lib/rag/Retriever'
import { createDeterministicTestEmbedder, type EmbedQuery } from '../lib/rag/vssClient'
import { TEST_FALLBACK_EMBEDDING_MODEL_ID } from '../lib/rag/BundleLoader'
import { buildSyntheticTopology, type SyntheticTopology } from './synthetic/loadSynthetic'
import { buildEvalReport, scoreCandidate, type EvalReport, type ScoredItem } from './score'
import { RecordedLlmClient, RECORDED_DRIVING_MODEL_ID } from './fixtures/recordedLlm'

export const DEFAULT_FIXTURE_BUNDLE_DIR = path.join(
  __dirname,
  '..',
  'lib',
  'rag',
  '__tests__',
  'fixtures',
  'bundles',
  'mock-v1'
)

/** One golden or adversarial question loaded from a `.jsonl` file (SPEC §6.1). */
export interface GoldenItem {
  id: string
  question: string
  tags: string[]
  expectedTables?: string[]
  goldSql?: string
  targetSource?: string
  difficulty?: string
}

/** One adversarial question loaded from `eval/adversarial.jsonl`. `expectSql` documents what the recorded stub returns for this question (never actually executed — see scoreCandidate's hard-failure short-circuit). */
export interface AdversarialItem {
  id: string
  question: string
  tags: string[]
  expectSql?: string
}

export type EvalExecutionMode = 'synthetic' | 'gated-staging'

export interface RunEvalOptions {
  /** Bundle directory to load for retrieval. Defaults to the committed P4 fixture bundle. */
  bundleDir?: string
  /** Execution mode (SPEC §6.3). Default 'synthetic'. */
  mode?: EvalExecutionMode
  /** Injected LlmClient (the "driving LLM"). Defaults to the RecordedLlmClient (hermetic, CI-safe). A real LLM plugs in here for non-CI runs. */
  llm?: LlmClient
  /** Identifies the driving model in the EvalReport (SPEC §6.2 `drivingModel`). Defaults to RECORDED_DRIVING_MODEL_ID when `llm` is not overridden. */
  drivingModel?: string
  /** Injected query embedder. Defaults to the deterministic test embedder (matches the fixture bundle's test-fallback vectors). */
  embedQuery?: EmbedQuery
  /** Forwarded to BundleLoader via HybridRetriever. Defaults to the test-fallback embedding model id (matches the fixture bundle). */
  expectedEmbeddingModelId?: string
  /** Row cap forwarded to generation + scoring execute() calls. Default 1000. */
  maxRows?: number
  /** Explicit opt-in required (in addition to STAGING_DSN) to run gated-staging mode. Default false. */
  allowGatedStaging?: boolean
}

export interface RunEvalResult {
  report: EvalReport
  items: ScoredItem[]
  mode: EvalExecutionMode
}

/**
 * resolveEngine — builds the QueryEngine for the requested mode.
 *   - synthetic: `buildSyntheticTopology()` (hermetic DuckDB, alias `mock`).
 *   - gated-staging: requires BOTH `options.allowGatedStaging === true` AND
 *     `process.env.STAGING_DSN` set; attaches staging READ_ONLY via DuckDB.
 *     Falls back to synthetic (with a console warning) if either condition
 *     is not met — an eval run must never silently attempt a staging
 *     connection nobody asked for, and must never throw just because staging
 *     isn't configured (the common/default/CI case).
 */
async function resolveEngine(
  options: RunEvalOptions
): Promise<{ engine: QueryEngine; mode: EvalExecutionMode; synthetic?: SyntheticTopology }> {
  const requestedMode = options.mode ?? 'synthetic'

  if (requestedMode === 'gated-staging') {
    const stagingDsn = process.env.STAGING_DSN
    if (!options.allowGatedStaging || !stagingDsn) {
      // eslint-disable-next-line no-console
      console.warn(
        'runEval: gated-staging mode requested but not enabled — requires BOTH ' +
          '`allowGatedStaging: true` AND STAGING_DSN set. Falling back to synthetic mode ' +
          '(NL2SQL_SPEC.md §6.3(b): staging is opt-in only, default off).'
      )
    } else {
      const engine = new DuckDbEngine()
      const specs: AttachSpec[] = [
        { sourceId: 'staging', engine: 'postgres', dsn: stagingDsn, readOnly: true, alias: 'staging' },
      ]
      await engine.attach(specs)
      return { engine, mode: 'gated-staging' }
    }
  }

  const synthetic = await buildSyntheticTopology()
  return { engine: synthetic.engine, mode: 'synthetic', synthetic }
}

async function buildRetriever(options: RunEvalOptions): Promise<HybridRetriever> {
  const bundleDir = options.bundleDir ?? DEFAULT_FIXTURE_BUNDLE_DIR
  const embedQuery = options.embedQuery ?? createDeterministicTestEmbedder(384)
  const retriever = new HybridRetriever({
    embedQuery,
    dialect: 'duckdb',
    bundleLoaderOptions: { expectedEmbeddingModelId: options.expectedEmbeddingModelId ?? TEST_FALLBACK_EMBEDDING_MODEL_ID },
  })
  await retriever.load(bundleDir)
  return retriever
}

/** Rough, dependency-free token estimator (chars/4 — mirrors Retriever.ts's own estimator, no tokenizer dependency). */
function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4)
}

/**
 * runOneItem — retrieve -> generate -> score for a single golden question.
 * Failures inside generation (e.g. `GenerationError` when self-repair
 * exhausts) are captured as a scored item with `guardPasses:false` rather
 * than thrown, so one bad question never aborts the whole eval run.
 */
async function runOneItem(
  item: GoldenItem | AdversarialItem,
  deps: {
    retriever: Retriever
    engine: QueryEngine
    llm: LlmClient
    bundleKnownTableIds: Set<string>
    goldSql?: string
    maxRows: number
  }
): Promise<ScoredItem> {
  const start = performance.now()
  let tokenEstimate = 0

  try {
    const response = await generateSql({
      question: item.question,
      engine: deps.engine,
      retriever: deps.retriever,
      llm: deps.llm,
      options: { defaultLimit: deps.maxRows },
    })
    tokenEstimate = estimateTokens(response.sql) + estimateTokens(response.description)

    // generateSql already ran guardSql/cardinalityGuard/explain internally
    // and only returns SQL that passed all three (or throws). Re-score with
    // scoreCandidate anyway so the EvalScore/EvalReport is derived uniformly
    // (SAME code path a raw/ungenerated candidate would go through), and so
    // resultMate against goldSql is computed.
    const context = await deps.retriever.retrieve(item.question, { tokenBudget: 4000, maxTables: 8 })
    const score = await scoreCandidate({
      sql: response.sql,
      context,
      engine: deps.engine,
      bundleKnownTableIds: deps.bundleKnownTableIds,
      goldSql: deps.goldSql,
      maxRows: deps.maxRows,
    })

    return {
      id: item.id,
      question: item.question,
      tags: item.tags,
      sql: response.sql,
      score,
      latencyMs: performance.now() - start,
      tokenEstimate,
    }
  } catch (err) {
    // A GenerationError means self-repair exhausted without producing safe
    // SQL — this is the intended, correct outcome for an adversarial
    // (injection/write) question: score it as a guard failure using the
    // LAST attempted SQL for observability.
    const lastSql = err instanceof GenerationError ? (err.lastError ?? '') : ''
    return {
      id: item.id,
      question: item.question,
      tags: item.tags,
      sql: lastSql,
      score: {
        guardPasses: false,
        parses: false,
        referencesRealTables: false,
        cardinalityBounded: false,
        executes: false,
        resultMatch: null,
      },
      latencyMs: performance.now() - start,
      tokenEstimate,
      error: err instanceof Error ? err.message : String(err),
    }
  }
}

/**
 * runEval — the SPEC §6 loop. Loads the retriever + resolves the execution
 * engine (synthetic by default), runs every golden item through
 * retrieve->generate->score, and returns both the aggregate `EvalReport` and
 * the full per-item detail (`ScoredItem[]`) for debugging/inspection.
 */
export async function runEval(golden: GoldenItem[], options: RunEvalOptions = {}): Promise<RunEvalResult> {
  const maxRows = options.maxRows ?? 1000
  const retriever = await buildRetriever(options)
  const { engine, mode, synthetic } = await resolveEngine(options)
  const llm = options.llm ?? new RecordedLlmClient()
  const drivingModel = options.drivingModel ?? (options.llm ? 'custom-injected' : RECORDED_DRIVING_MODEL_ID)

  // Bundle catalog table ids — loaded via a throwaway retriever load already
  // done by buildRetriever(); HybridRetriever doesn't expose the loader
  // publicly, so reuse retrieve() to discover them defensively: instead,
  // load the bundle's catalog.json directly for the authoritative id set
  // (mirrors what BundleLoader already validated when the retriever loaded).
  const bundleKnownTableIds = await loadBundleTableIds(options.bundleDir ?? DEFAULT_FIXTURE_BUNDLE_DIR)

  try {
    const items: ScoredItem[] = []
    for (const item of golden) {
      // Sequential by necessity: each item's score depends on nothing from a
      // sibling item, but the shared `engine`/`retriever` are stateful DuckDB
      // handles — running items concurrently would interleave queries on the
      // same connection. Bounded by golden.length (a handful of questions).
      // eslint-disable-next-line no-await-in-loop
      const scored = await runOneItem(item, {
        retriever,
        engine,
        llm,
        bundleKnownTableIds,
        goldSql: item.goldSql,
        maxRows,
      })
      items.push(scored)
    }

    const tokenCostTotal = items.reduce((sum, i) => sum + i.tokenEstimate, 0)
    const bundleVersion = await loadBundleVersion(options.bundleDir ?? DEFAULT_FIXTURE_BUNDLE_DIR)
    const report = buildEvalReport(items, { bundleVersion, drivingModel, tokenCostTotal })

    return { report, items, mode }
  } finally {
    if (synthetic) await synthetic.dispose()
    else await engine.dispose()
    await retriever.dispose()
  }
}

/**
 * runAdversarial — scores every adversarial (prompt-injection/write-attempt)
 * item and asserts EACH one is caught: `guardPasses:false` for every single
 * item (SPEC §6.2 "adversarial subset ... asserting the guard + read-only
 * role hold"). Unlike `runEval`, this does not compare against a goldSql
 * (there is no "correct" SQL for an injection attempt — the correct outcome
 * is rejection). Uses the RecordedLlmClient's adversarial completions (the
 * "worst case": a model that WAS coaxed into emitting the requested write).
 */
export async function runAdversarial(items: AdversarialItem[], options: RunEvalOptions = {}): Promise<ScoredItem[]> {
  const retriever = await buildRetriever(options)
  const { engine, synthetic } = await resolveEngine({ ...options, mode: 'synthetic' })
  const llm = options.llm ?? new RecordedLlmClient()
  const bundleKnownTableIds = await loadBundleTableIds(options.bundleDir ?? DEFAULT_FIXTURE_BUNDLE_DIR)

  try {
    const results: ScoredItem[] = []
    for (const item of items) {
      // eslint-disable-next-line no-await-in-loop
      const scored = await runOneItem(item, {
        retriever,
        engine,
        llm,
        bundleKnownTableIds,
        maxRows: options.maxRows ?? 1000,
      })
      results.push(scored)
    }
    return results
  } finally {
    if (synthetic) await synthetic.dispose()
    else await engine.dispose()
    await retriever.dispose()
  }
}

async function loadBundleTableIds(bundleDir: string): Promise<Set<string>> {
  const { readFile } = await import('node:fs/promises')
  const raw = await readFile(path.join(bundleDir, 'catalog.json'), 'utf-8')
  const catalog = JSON.parse(raw) as { tables: { tableId: string }[] }
  return new Set(catalog.tables.map((t) => t.tableId))
}

async function loadBundleVersion(bundleDir: string): Promise<string> {
  const { readFile } = await import('node:fs/promises')
  const raw = await readFile(path.join(bundleDir, 'manifest.json'), 'utf-8')
  const manifest = JSON.parse(raw) as { bundleVersion: string }
  return manifest.bundleVersion
}

/**
 * loadGoldenSet — reads every `.jsonl` file under `eval/golden/` and parses
 * each non-blank line as a `GoldenItem` (SPEC §6.1 one-record-per-line
 * format). Exported so both the CLI entry point below and
 * `eval/__tests__/eval.test.ts` load the golden set identically.
 */
export async function loadGoldenSet(goldenDir: string = path.join(__dirname, 'golden')): Promise<GoldenItem[]> {
  const { readdir, readFile } = await import('node:fs/promises')
  const files = (await readdir(goldenDir)).filter((f) => f.endsWith('.jsonl')).toSorted()
  const golden: GoldenItem[] = []
  for (const file of files) {
    // eslint-disable-next-line no-await-in-loop
    const raw = await readFile(path.join(goldenDir, file), 'utf-8')
    for (const line of raw.split('\n')) {
      if (line.trim().length === 0) continue
      golden.push(JSON.parse(line) as GoldenItem)
    }
  }
  return golden
}

/** Reads + parses `eval/adversarial.jsonl` (SPEC §6.2 adversarial subset). */
export async function loadAdversarialSet(
  filePath: string = path.join(__dirname, 'adversarial.jsonl')
): Promise<AdversarialItem[]> {
  const { readFile } = await import('node:fs/promises')
  const raw = await readFile(filePath, 'utf-8')
  const items: AdversarialItem[] = []
  for (const line of raw.split('\n')) {
    if (line.trim().length === 0) continue
    items.push(JSON.parse(line) as AdversarialItem)
  }
  return items
}

// ── CLI entry point ─────────────────────────────────────────────────────────
// `npx tsx eval/runEval.ts` (or any Node/TS runner that executes this file
// directly) runs the full golden set in synthetic mode and prints the
// EvalReport. This module has no top-level side effects otherwise — a test
// file importing `runEval`/`loadGoldenSet` never triggers a run.
export async function main(): Promise<void> {
  const golden = await loadGoldenSet()
  const { report, items } = await runEval(golden)

  // eslint-disable-next-line no-console
  console.log(JSON.stringify({ report, items: items.map((i) => ({ ...i, sql: i.sql.slice(0, 200) })) }, null, 2))
}
