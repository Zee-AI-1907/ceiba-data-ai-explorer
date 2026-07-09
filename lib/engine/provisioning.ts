/**
 * provisioning.ts — the SINGLE source of truth for the runtime QueryEngine and its
 * attach topology (NL2SQL_SPEC.md §3, §5.6; docs/DATA_SOURCES.md federation topology).
 *
 * ── WHY THIS EXISTS (the P1 dialect-mismatch fix) ─────────────────────────────
 * Before this module, POST /api/sql-generate built its own DuckDbEngine and
 * EXPLAIN-validated candidate SQL as the `duckdb` dialect, while POST /api/query
 * EXECUTED that same SQL through `executeTrinoQuery` (the `trino` dialect). SQL
 * validated for one dialect but run on another is a silent conformance gap
 * (interval syntax, quoting, function names differ). Aligning on a decision made by
 * the product owner: BOTH generation and execution use ONE engine, so the dialect
 * they validate/execute against is guaranteed identical.
 *
 * `getQueryEngine()` is the shared, memoized accessor both routes call. It:
 *   1. Selects the engine KIND from config/env (`NL2SQL_ENGINE`, default `duckdb`)
 *      — Trino stays pluggable (SPEC §3.3) without a route rewrite.
 *   2. Builds the read-only ATTACH set from the configured DSNs (MOCK_DSN /
 *      STAGING_DSN per docs/DATA_SOURCES.md). Every spec is `readOnly: true`;
 *      DuckDbEngine hard-errors on a non-READ_ONLY attach and re-verifies
 *      `duckdb_databases().readonly`, so read-only is enforced defense-in-depth.
 *   3. Memoizes the constructed+attached engine keyed by (kind + attach set) so the
 *      expensive DuckDB instance/extension load happens once per process.
 *
 * The engine is NEVER torn down per-request; it lives for the process lifetime
 * (mirrors the `getGenerationDeps` memoization the generation route already used).
 */

import { createEngine, type EngineKind } from './index'
import type { AttachSpec, QueryEngine, SqlDialect } from './QueryEngine'

/** Env var selecting the federation engine kind. Default `duckdb` (SPEC §0 decision #3). */
const ENGINE_KIND_ENV = 'NL2SQL_ENGINE'
/** Env var: local synthetic companion Postgres DSN (docs/DATA_SOURCES.md; alias `mock`). */
const MOCK_DSN_ENV = 'MOCK_DSN'
/** Env var: read-only staging CeibaHospitalDB DSN (docs/DATA_SOURCES.md; alias `staging`). */
const STAGING_DSN_ENV = 'STAGING_DSN'

/** Attach alias for the local synthetic mock source. */
export const MOCK_ALIAS = 'mock'
/** Attach alias for the read-only staging source. */
export const STAGING_ALIAS = 'staging'

/**
 * The set of attach aliases this deployment knows about. `/api/query` validates a
 * caller-supplied `database` against this set (+ the actually-attached aliases) so
 * no arbitrary identifier ever reaches the engine as a catalog (H22 header/identifier
 * injection protection carried over from the Trino route's catalog allowlist).
 */
export const KNOWN_ATTACH_ALIASES: readonly string[] = [MOCK_ALIAS, STAGING_ALIAS] as const

function resolveEngineKind(): EngineKind {
  const raw = (process.env[ENGINE_KIND_ENV] ?? 'duckdb').trim().toLowerCase()
  return raw === 'trino' ? 'trino' : 'duckdb'
}

/**
 * Build the read-only AttachSpec set from the configured DSNs. A DSN that is not set
 * simply contributes no spec (a deployment may run with only the mock source up, or
 * only staging). Both sources attach as Postgres, READ_ONLY.
 */
export function buildAttachSpecs(): AttachSpec[] {
  const specs: AttachSpec[] = []
  const mockDsn = process.env[MOCK_DSN_ENV]
  if (mockDsn && mockDsn.trim().length > 0) {
    specs.push({ sourceId: MOCK_ALIAS, engine: 'postgres', dsn: mockDsn, readOnly: true, alias: MOCK_ALIAS })
  }
  const stagingDsn = process.env[STAGING_DSN_ENV]
  if (stagingDsn && stagingDsn.trim().length > 0) {
    specs.push({ sourceId: STAGING_ALIAS, engine: 'postgres', dsn: stagingDsn, readOnly: true, alias: STAGING_ALIAS })
  }
  return specs
}

/** A stable key for the memoized engine — kind + the ordered attach aliases. */
function memoKey(kind: EngineKind, specs: AttachSpec[]): string {
  return `${kind}::${specs.map((s) => s.alias).toSorted().join(',')}`
}

let cachedEngine: QueryEngine | null = null
let cachedEnginePromise: Promise<QueryEngine> | null = null
let cachedKey: string | null = null

/**
 * TEST-ONLY: inject an already-built (and attached) QueryEngine, bypassing DSN/attach
 * construction so a route test can run fully hermetically against a DuckDB-native or
 * file-backed engine. Pass `null` to reset back to real provisioning.
 */
// eslint-disable-next-line no-underscore-dangle
export function __setQueryEngineForTest(engine: QueryEngine | null): void {
  cachedEngine = engine
  cachedEnginePromise = null
  cachedKey = engine ? 'test-injected' : null
}

/**
 * getQueryEngine — the shared, memoized runtime engine. Both /api/query (execution)
 * and /api/sql-generate (EXPLAIN validation) call this so they provision from ONE
 * topology and therefore ONE dialect (the P1 fix). Construction + attach happen once
 * per (kind + attach set); subsequent calls return the same instance.
 */
export async function getQueryEngine(): Promise<QueryEngine> {
  if (cachedEngine) return cachedEngine
  if (cachedEnginePromise) return cachedEnginePromise

  const kind = resolveEngineKind()
  const specs = buildAttachSpecs()
  const key = memoKey(kind, specs)

  cachedEnginePromise = (async () => {
    const engine = await createEngine(kind, specs)
    cachedEngine = engine
    cachedKey = key
    return engine
  })()

  return cachedEnginePromise
}

/**
 * The dialect the shared engine validates/executes against, WITHOUT forcing engine
 * construction (attach can require live DSNs). Derived from the configured kind so
 * generation can label a cached response before the engine is built. Kept in lockstep
 * with the concrete engine's `dialect()`:
 *   - duckdb  → 'duckdb'
 *   - trino   → 'trino'
 */
export function resolvedDialect(): SqlDialect {
  return resolveEngineKind() === 'trino' ? 'trino' : 'duckdb'
}

/** TEST/observability helper: the memo key currently in effect (or null if unbuilt). */
export function currentEngineKey(): string | null {
  return cachedKey
}
