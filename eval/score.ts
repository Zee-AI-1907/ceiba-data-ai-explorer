/**
 * score.ts — EvalScore / EvalReport (NL2SQL_SPEC.md §6.2, NL2SQL_PLAN.md §P6
 * task 2).
 *
 * Scores one generated candidate SQL against the SPEC §6.2 dimensions, reusing
 * the REAL runtime controls rather than re-implementing them:
 *   - `guardPasses`  -> `lib/sqlGuard.ts`'s `guardSql` (the actual execution
 *     boundary's classifier — SPEC "the REAL boundary").
 *   - `parses`       -> `QueryEngine.explain` in the target dialect (no rows).
 *   - `referencesRealTables` -> every table reference resolves to a tableId in
 *     the bundle's `catalog.json` (valid-table-reference rate).
 *   - `cardinalityBounded`   -> `lib/rag/cardinalityGuard.ts`'s
 *     `cardinalityGuardFromContext` (action !== 'reject').
 *   - `executes`     -> `QueryEngine.execute` against the synthetic (or
 *     gated-staging) topology, without throwing.
 *   - `resultMatch`  -> row-set comparison against `goldSql` executed on the
 *     SAME topology, when a goldSql is provided; `null` otherwise (SPEC:
 *     "null if no goldSql").
 *
 * A guard failure is treated as a HARD failure (SPEC §6.2 "a guard failure is
 * a hard failure and flags a generator regression") — `scoreCandidate` never
 * calls `execute`/`explain` on SQL that failed `guardSql`, so an eval run can
 * never accidentally run rejected SQL against any topology (synthetic OR
 * gated staging).
 */

import type { QueryEngine } from '../lib/engine/QueryEngine'
import { guardSql, type TableAllowlistCheck } from '../lib/sqlGuard'
import { cardinalityGuardFromContext } from '../lib/rag/cardinalityGuard'
import type { SchemaContext } from '../lib/rag/Retriever'

// ── SPEC §6.2 shapes (verbatim) ────────────────────────────────────────────

export interface EvalScore {
  guardPasses: boolean
  parses: boolean
  referencesRealTables: boolean
  cardinalityBounded: boolean
  executes: boolean
  resultMatch: boolean | null
}

export interface PerTagMetrics {
  executionAccuracy: number
  guardPassRate: number
  parseRate: number
}

export interface OverallMetrics extends PerTagMetrics {
  validTableRate: number
}

export interface EvalReport {
  perTag: Record<string, PerTagMetrics>
  overall: OverallMetrics
  latencyMsP50: number
  tokenCostTotal: number
  bundleVersion: string
  drivingModel: string
}

/** One scored golden-set item, retained alongside the aggregate EvalReport for detailed inspection/debugging. */
export interface ScoredItem {
  id: string
  question: string
  tags: string[]
  sql: string
  score: EvalScore
  latencyMs: number
  tokenEstimate: number
  error?: string
}

// ── scoring a single candidate ─────────────────────────────────────────────

export interface ScoreCandidateOptions {
  /** Untrusted candidate SQL to score (already extracted from the LLM completion). */
  sql: string
  /** The retrieved SchemaContext the candidate was generated against (drives cardinalityGuard + valid-table-reference check). */
  context: SchemaContext
  /** The QueryEngine to run explain/execute against (synthetic topology by default, gated staging when opted in). */
  engine: QueryEngine
  /** All known tableIds in the loaded bundle's catalog (SPEC "all refs ∈ bundle catalog"). */
  bundleKnownTableIds: Set<string>
  /** Optional gold SQL to compare results against (SPEC: null resultMatch when absent). */
  goldSql?: string
  /** Row cap forwarded to execute() calls. Default 1000. */
  maxRows?: number
  /** Wall-clock budget forwarded to execute() calls. Default 10_000ms. */
  deadlineMs?: number
  /** Optional table-allowlist policy wired into guardSql (H25 seam), mirroring generate.ts's options.tableAllowlist. */
  tableAllowlist?: TableAllowlistCheck
}

/**
 * referencesRealTables — checks that every `quotedRef`/tableId surfaced in the
 * SchemaContext the candidate was retrieved against is a real bundle table.
 * The retriever only ever surfaces real catalog tables by construction, so
 * this check is really "did retrieval find and surface at least one real
 * table, and are all of THOSE real" — a defense against a retriever bug that
 * synthesizes a table id that doesn't exist in the loaded catalog.
 */
function referencesRealTables(context: SchemaContext, bundleKnownTableIds: Set<string>): boolean {
  if (context.tables.length === 0) return false
  return context.tables.every((t) => bundleKnownTableIds.has(t.tableId))
}

/** Normalizes an EngineResult's rows into a comparable, order-independent, stringified multiset. */
function normalizeRows(rows: Record<string, unknown>[]): string[] {
  return rows
    .map((row) => {
      const sortedKeys = Object.keys(row).toSorted()
      const normalized: Record<string, unknown> = {}
      for (const key of sortedKeys) {
        const value = row[key]
        // Normalize Date/bigint/etc. to a stable string so DuckDB type
        // differences (TIMESTAMPTZ vs TIMESTAMP, BIGINT vs number) don't
        // cause a spurious mismatch.
        normalized[key] = value instanceof Date ? value.toISOString() : typeof value === 'bigint' ? value.toString() : value
      }
      return JSON.stringify(normalized)
    })
    .toSorted()
}

function rowSetsMatch(a: Record<string, unknown>[], b: Record<string, unknown>[]): boolean {
  const normA = normalizeRows(a)
  const normB = normalizeRows(b)
  if (normA.length !== normB.length) return false
  return normA.every((row, i) => row === normB[i])
}

/**
 * scoreCandidate — runs the SPEC §6.2 scoring chain on ONE candidate SQL.
 * Short-circuits after a guard failure (hard failure — never explains/
 * executes rejected SQL, per SPEC "a guard failure is a hard failure").
 */
export async function scoreCandidate(options: ScoreCandidateOptions): Promise<EvalScore> {
  const maxRows = options.maxRows ?? 1000
  const deadlineMs = options.deadlineMs ?? 10_000

  const validTables = referencesRealTables(options.context, options.bundleKnownTableIds)

  const guardVerdict = guardSql(options.sql, { tableAllowlist: options.tableAllowlist })
  const guardPasses = guardVerdict.allowed

  if (!guardPasses) {
    // HARD FAILURE (SPEC §6.2): never explain/execute SQL the guard rejected.
    return {
      guardPasses: false,
      parses: false,
      referencesRealTables: validTables,
      cardinalityBounded: false,
      executes: false,
      resultMatch: null,
    }
  }

  const cardVerdict = cardinalityGuardFromContext(options.sql, options.context, maxRows)
  const cardinalityBounded = cardVerdict.action !== 'reject'
  const sqlToRun = cardVerdict.action === 'repair' && cardVerdict.repairedSql ? cardVerdict.repairedSql : options.sql

  let parses = false
  let executes = false
  let resultMatch: boolean | null = null

  if (cardinalityBounded) {
    const explainVerdict = await options.engine.explain(sqlToRun, {})
    parses = explainVerdict.ok

    if (parses) {
      try {
        const result = await options.engine.execute(sqlToRun, { maxRows, deadlineMs })
        executes = true

        if (options.goldSql) {
          try {
            const goldResult = await options.engine.execute(options.goldSql, { maxRows, deadlineMs })
            resultMatch = rowSetsMatch(result.rows, goldResult.rows)
          } catch {
            // Gold SQL failed to execute on this topology — cannot judge a match.
            resultMatch = false
          }
        }
      } catch {
        executes = false
      }
    }
  }

  return {
    guardPasses,
    parses,
    referencesRealTables: validTables,
    cardinalityBounded,
    executes,
    resultMatch,
  }
}

// ── aggregate report ────────────────────────────────────────────────────────

function percentile50(sortedValues: number[]): number {
  if (sortedValues.length === 0) return 0
  const mid = Math.floor(sortedValues.length / 2)
  if (sortedValues.length % 2 === 1) return sortedValues[mid]!
  return (sortedValues[mid - 1]! + sortedValues[mid]!) / 2
}

function computeMetrics(items: ScoredItem[]): PerTagMetrics {
  if (items.length === 0) return { executionAccuracy: 0, guardPassRate: 0, parseRate: 0 }
  const n = items.length
  const guardPassRate = items.filter((i) => i.score.guardPasses).length / n
  const parseRate = items.filter((i) => i.score.parses).length / n
  // Execution accuracy (SPEC §3.3 "primary" metric): prefer resultMatch when a
  // goldSql was available for the item; otherwise fall back to `executes` so
  // items without a goldSql still contribute a meaningful accuracy signal.
  const accuracyHits = items.filter((i) => (i.score.resultMatch !== null ? i.score.resultMatch : i.score.executes)).length
  const executionAccuracy = accuracyHits / n
  return { executionAccuracy, guardPassRate, parseRate }
}

export interface BuildEvalReportOptions {
  bundleVersion: string
  drivingModel: string
  /** Rough token estimate summed across all generation calls (prompt + completion), for cost accounting. */
  tokenCostTotal: number
}

/**
 * buildEvalReport — aggregates a list of `ScoredItem`s (each carrying its own
 * `tags`) into the SPEC §6.2 `EvalReport` shape: per-tag metrics, overall
 * metrics (incl. `validTableRate`), p50 latency, and the identifying
 * `bundleVersion`/`drivingModel` for A/B benching across bundle builds.
 */
export function buildEvalReport(items: ScoredItem[], options: BuildEvalReportOptions): EvalReport {
  const perTag: Record<string, PerTagMetrics> = {}
  const tagSet = new Set(items.flatMap((i) => i.tags))
  for (const tag of tagSet) {
    perTag[tag] = computeMetrics(items.filter((i) => i.tags.includes(tag)))
  }

  const overallBase = computeMetrics(items)
  const validTableRate = items.length > 0 ? items.filter((i) => i.score.referencesRealTables).length / items.length : 0

  const latencies = items.map((i) => i.latencyMs).toSorted((a, b) => a - b)

  return {
    perTag,
    overall: { ...overallBase, validTableRate },
    latencyMsP50: percentile50(latencies),
    tokenCostTotal: options.tokenCostTotal,
    bundleVersion: options.bundleVersion,
    drivingModel: options.drivingModel,
  }
}
