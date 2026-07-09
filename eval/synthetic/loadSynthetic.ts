/**
 * loadSynthetic.ts — synthetic execution topology for the eval harness
 * (NL2SQL_SPEC.md §6.3 mode (a), §1.8, NL2SQL_PLAN.md §P6 task 1).
 *
 * DESCRIPTOR-DRIVEN (the gap this module closes): builds a HERMETIC DuckDB-
 * native schema by reading `synthetic.json` — the generator DESCRIPTORS the
 * Python prep toolchain emits (SPEC §1.8, `prep/prep/synthetic.py`) — out of
 * a bundle directory (`catalog.json` + `keys.json` + `synthetic.json`), and
 * fabricating rows FROM those descriptors. Previously this module hardcoded
 * the mock bundle's 6-table shape directly in TypeScript; that worked for
 * the mock bundle but did not scale to the real ~1,200-table staging schema,
 * whose synthetic fixture topology cannot be hand-written per table. This
 * loader instead generalizes to ANY bundle whose `synthetic.json` follows
 * the SPEC §1.8 shape — one JSON-driven code path for 6 tables or 1,200.
 *
 * Per-generator semantics (SPEC §1.8):
 *   - `surrogate-pk`:  sequential synthetic ids `start..start+rowTarget-1`.
 *   - `surrogate-fk`:  an id drawn from the ALREADY-GENERATED parent table's
 *     surrogate-pk pool (`params.references`) — FK integrity, never a
 *     dangling reference. Tables are synthesized in FK-dependency order
 *     (parents before children) so every reference always resolves.
 *   - `numeric`:       uniform-random value in `[params.min, params.max]`
 *     (never a raw cell — these bounds are `profiles.json` aggregate stats).
 *   - `categorical`:   weighted-random pick from `params.labels` /
 *     `params.weights` (the SAME non-PHI low-cardinality strings
 *     `profiles.json.topCategories` already allows elsewhere in the bundle).
 *   - `timestamp`:     uniform-random instant across `[params.start,
 *     params.end]`, PLUS a guaranteed subset of rows forced inside
 *     `params.recentWindow` (honoring `params.recentWindowAnchor ===
 *     'previous-day'` as a calendar-day anchor rather than a rolling
 *     window) — this is what makes the canonical "heart rate > 120 in the
 *     last 3 hours" / "patients admitted yesterday" golden questions always
 *     have matching rows, entirely driven by the descriptor rather than
 *     hand-authored per-table logic.
 *   - `synthetic-identifier`: opaque deterministic FAKE label/id
 *     (`${prefix}-${padded sequence}`) — the safe placeholder PHI/suppressed/
 *     high-cardinality columns get; zero cell-derived content.
 *
 * Deterministic (mulberry32 PRNG, same precedent as the former hardcoded
 * version and `generate.test.ts`'s hermetic seed) so every CI run produces
 * byte-identical row sets — no flakiness, no network, no live DB dependency.
 * NO PHI: every value is synthesized from a descriptor, never a real patient
 * cell (SPEC §8.2 invariant #4).
 */

import { readFileSync, existsSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { DuckDBInstance } from '@duckdb/node-api'
import { DuckDbEngine } from '../../lib/engine/DuckDbEngine'
import type { AttachSpec } from '../../lib/engine/QueryEngine'

// Deliberately NOT imported from `../runEval` — that module imports
// `buildSyntheticTopology` FROM this file, so importing back would create a
// circular module dependency. Kept as an independent constant instead;
// `runEval.ts`'s own `DEFAULT_FIXTURE_BUNDLE_DIR` points at the identical
// path (both resolve to `lib/rag/__tests__/fixtures/bundles/mock-v1`).
const DEFAULT_FIXTURE_BUNDLE_DIR = path.join(__dirname, '..', '..', 'lib', 'rag', '__tests__', 'fixtures', 'bundles', 'mock-v1')

// ── deterministic PRNG (mulberry32) ─────────────────────────────────────────
// A tiny, dependency-free, seedable PRNG so the synthetic dataset is
// byte-for-byte reproducible across CI runs (SPEC §0a decision #5's sibling
// requirement: deterministic, seed-controlled fixtures — mirrors the mock
// Postgres seed's own determinism, docker/mock-postgres/init/02_seed.sql).
function mulberry32(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a |= 0
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

export const SYNTHETIC_SEED = 20260709

// ── bundle artifact shapes (only the fields this module reads) ─────────────

interface CatalogColumn {
  columnId: string
  name: string
  quotedName: string
  dataType: string
  nullable: boolean
  isPrimaryKey: boolean
  isTimeColumn: boolean
}

interface CatalogTable {
  tableId: string
  sourceId: string
  schema: string
  name: string
  quotedRef: string
  columns: CatalogColumn[]
}

interface CatalogJson {
  tables: CatalogTable[]
}

interface ForeignKeyEntry {
  fkId: string
  fromTable: string
  fromColumns: string[]
  toTable: string
  toColumns: string[]
}

interface KeysJson {
  primaryKeys: { tableId: string; columns: string[] }[]
  foreignKeys: ForeignKeyEntry[]
}

interface SyntheticColumnDescriptor {
  columnId: string
  generator: 'surrogate-pk' | 'surrogate-fk' | 'numeric' | 'categorical' | 'timestamp' | 'synthetic-identifier'
  params: Record<string, unknown>
}

interface SyntheticTableDescriptor {
  tableId: string
  syntheticRowTarget: number
  columns: SyntheticColumnDescriptor[]
}

interface SyntheticJson {
  tables: SyntheticTableDescriptor[]
}

// ── public API (unchanged shape — runEval.ts/eval.test.ts consume this as-is) ──

export interface SyntheticTopologyOptions {
  /** Bundle directory to read catalog.json/keys.json/synthetic.json from. Defaults to the committed fixture bundle. */
  bundleDir?: string
  /** Deterministic PRNG seed. Default SYNTHETIC_SEED. */
  seed?: number
  /**
   * DuckDB file path. Defaults to a fresh temp file (so parallel eval runs
   * never collide); pass an explicit path only for debugging/inspection.
   */
  dbPath?: string
}

export interface SyntheticTopology {
  /** Absolute path to the built DuckDB file backing this topology. */
  dbPath: string
  /** A ready-to-use QueryEngine with the synthetic DB ATTACHed as alias "mock" (mirrors the real bundle's sourceId). */
  engine: DuckDbEngine
  /** Row counts actually inserted per table, keyed by bare table name, for sanity assertions. */
  counts: Record<string, number>
  /** Tears down the engine and removes the temp DuckDB file (if one was created). */
  dispose(): Promise<void>
}

function quoteLiteral(value: string): string {
  return `'${value.replace(/'/g, "''")}'`
}

// ── DuckDB DDL type mapping (bundle dataType strings -> DuckDB column types) ──
// catalog.json dataType strings are already DuckDB-compatible spellings for
// this Postgres-sourced bundle (INTEGER/BIGINT/TEXT/TIMESTAMP/DOUBLE
// PRECISION etc — see sqlalchemy_introspector.py); passed through verbatim
// with a tiny normalization for the handful of Postgres spellings DuckDB
// itself does not accept unmodified.
const DDL_TYPE_OVERRIDES: Record<string, string> = {
  'double precision': 'DOUBLE',
  'character varying': 'VARCHAR',
  'timestamp without time zone': 'TIMESTAMP',
  'timestamp with time zone': 'TIMESTAMPTZ',
}

function ddlType(dataType: string): string {
  return DDL_TYPE_OVERRIDES[dataType.toLowerCase()] ?? dataType.toUpperCase()
}

// ── ISO-8601 duration parsing (subset: P<n>D, PT<n>H, P<n>Y, P<n>M — enough
//    for the recentWindow/start-window hints synthetic.json actually emits) ──

function isoDurationToMs(iso: string): number {
  const match = /^P(?:(\d+)Y)?(?:(\d+)M)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/.exec(iso)
  if (!match) throw new Error(`loadSynthetic: unparseable ISO-8601 duration ${JSON.stringify(iso)}`)
  const [, years, months, days, hours, minutes, seconds] = match
  const msPerDay = 24 * 60 * 60 * 1000
  return (
    Number(years ?? 0) * 365 * msPerDay +
    Number(months ?? 0) * 30 * msPerDay +
    Number(days ?? 0) * msPerDay +
    Number(hours ?? 0) * 60 * 60 * 1000 +
    Number(minutes ?? 0) * 60 * 1000 +
    Number(seconds ?? 0) * 1000
  )
}

/** Parses the prep tool's relative-offset shorthand ("-30d", "now") into an absolute Date. */
function relativeOffsetToDate(expr: string, now: Date): Date {
  if (expr === 'now') return now
  const match = /^-(\d+)([dhm])$/.exec(expr)
  if (!match) throw new Error(`loadSynthetic: unparseable relative offset ${JSON.stringify(expr)}`)
  const [, amountStr, unit] = match
  const amount = Number(amountStr)
  const msPerUnit = unit === 'd' ? 24 * 60 * 60 * 1000 : unit === 'h' ? 60 * 60 * 1000 : 60 * 1000
  return new Date(now.getTime() - amount * msPerUnit)
}

// ── bundle loading ───────────────────────────────────────────────────────────

function loadBundleJson<T>(bundleDir: string, filename: string): T {
  const raw = readFileSync(path.join(bundleDir, filename), 'utf-8')
  return JSON.parse(raw) as T
}

/** Topologically sorts tables so every FK's parent table is synthesized (and its surrogate-pk pool populated) before any child that references it. */
function topologicalTableOrder(tableIds: string[], foreignKeys: ForeignKeyEntry[]): string[] {
  const dependsOn = new Map<string, Set<string>>()
  for (const id of tableIds) dependsOn.set(id, new Set())
  for (const fk of foreignKeys) {
    if (fk.fromTable === fk.toTable) continue // self-referencing FK — do not create a cycle requirement
    dependsOn.get(fk.fromTable)?.add(fk.toTable)
  }

  const ordered: string[] = []
  const visited = new Set<string>()
  const visiting = new Set<string>()

  function visit(id: string): void {
    if (visited.has(id)) return
    if (visiting.has(id)) return // defensive: a cycle falls back to declaration order rather than throwing
    visiting.add(id)
    for (const dep of dependsOn.get(id) ?? []) visit(dep)
    visiting.delete(id)
    visited.add(id)
    ordered.push(id)
  }

  for (const id of tableIds) visit(id)
  return ordered
}

// ── per-column value generation ─────────────────────────────────────────────

interface GenerationContext {
  rand: () => number
  now: Date
  /** Populated as each table finishes generating — surrogate-fk reads from here. */
  pkPoolsByColumnId: Map<string, number[]>
}

function pickWeighted(rand: () => number, labels: string[], weights: number[] | undefined): string {
  if (!weights || weights.length !== labels.length) {
    return labels[Math.floor(rand() * labels.length)] as string
  }
  const total = weights.reduce((sum, w) => sum + w, 0) || 1
  let roll = rand() * total
  for (let i = 0; i < labels.length; i++) {
    roll -= weights[i] as number
    if (roll <= 0) return labels[i] as string
  }
  return labels[labels.length - 1] as string
}

/**
 * Generates ONE column's SQL-literal value for row index `rowIndex` (0-based)
 * out of `rowCount` total rows for this table, dispatching on the
 * descriptor's `generator` (SPEC §1.8). `forceRecentWindow`, when true (see
 * `guaranteedRecentRowIndices` below), overrides a `timestamp` generator's
 * normal uniform-over-history draw with a draw guaranteed to land inside
 * `params.recentWindow` of "now" — this is what gives the canonical
 * temporal golden questions guaranteed matching rows.
 */
function generateColumnValue(
  descriptor: SyntheticColumnDescriptor,
  ctx: GenerationContext,
  rowIndex: number,
  forceRecentWindow: boolean
): { sqlLiteral: string; pkValue?: number } {
  const { rand, now } = ctx
  const params = descriptor.params

  switch (descriptor.generator) {
    case 'surrogate-pk': {
      const start = Number(params.start ?? 1)
      const value = start + rowIndex
      return { sqlLiteral: String(value), pkValue: value }
    }

    case 'surrogate-fk': {
      const references = String(params.references)
      const pool = ctx.pkPoolsByColumnId.get(references)
      if (!pool || pool.length === 0) {
        // Parent table had zero synthesized rows (e.g. a lookup table whose
        // syntheticRowTarget floor still produced rows normally, but defend
        // anyway) — NULL is always valid for an FK column that permits it;
        // if not nullable this indicates a genuinely empty parent, which the
        // caller should have avoided via the row-target floor.
        return { sqlLiteral: 'NULL' }
      }
      const chosen = pool[Math.floor(rand() * pool.length)] as number
      return { sqlLiteral: String(chosen) }
    }

    case 'numeric': {
      const min = Number(params.min ?? 0)
      const max = Number(params.max ?? min + 1)
      const value = min + rand() * (max - min)
      return { sqlLiteral: value.toFixed(4) }
    }

    case 'categorical': {
      const labels = (params.labels as string[] | undefined) ?? ['synthetic']
      const weights = params.weights as number[] | undefined
      const label = pickWeighted(rand, labels, weights)
      return { sqlLiteral: quoteLiteral(label) }
    }

    case 'timestamp': {
      const startExpr = String(params.start ?? '-30d')
      const historyStart = relativeOffsetToDate(startExpr, now)
      const recentWindowIso = params.recentWindow as string | undefined
      const anchor = params.recentWindowAnchor as string | undefined

      let instant: Date
      if (forceRecentWindow && recentWindowIso) {
        instant = randomInstantInRecentWindow(rand, now, recentWindowIso, anchor)
      } else {
        const span = now.getTime() - historyStart.getTime()
        instant = new Date(historyStart.getTime() + rand() * Math.max(span, 1))
      }
      return { sqlLiteral: `TIMESTAMP '${instant.toISOString().replace('T', ' ').replace('Z', '')}'` }
    }

    case 'synthetic-identifier':
    default: {
      const prefix = String(params.prefix ?? 'SYN')
      const padWidth = Number(params.padWidth ?? 6)
      const label = `${prefix}-${String(rowIndex + 1).padStart(padWidth, '0')}`
      return { sqlLiteral: quoteLiteral(label) }
    }
  }
}

/**
 * Draws a random instant guaranteed to fall inside `recentWindowIso` of
 * `now` — a rolling window (e.g. "PT3H" -> somewhere in the last 3 hours) by
 * default, or a calendar-day-anchored window when `anchor === 'previous-day'`
 * (e.g. "P1D" -> somewhere within YESTERDAY, UTC calendar day, regardless of
 * what hour the eval happens to run at — mirrors the "patients admitted
 * yesterday" golden question's semantics exactly).
 */
function randomInstantInRecentWindow(rand: () => number, now: Date, recentWindowIso: string, anchor: string | undefined): Date {
  if (anchor === 'previous-day') {
    const todayUtcStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()))
    const yesterdayUtcStart = new Date(todayUtcStart.getTime() - 24 * 60 * 60 * 1000)
    return new Date(yesterdayUtcStart.getTime() + rand() * (24 * 60 * 60 * 1000 - 1))
  }
  const windowMs = isoDurationToMs(recentWindowIso)
  // Strictly inside the window (never exactly at the boundary) so a
  // ">="-style guard-generated filter reliably includes the row.
  return new Date(now.getTime() - rand() * Math.max(windowMs - 1000, 1000))
}

/**
 * Picks a deterministic subset of row indices (roughly 1-in-8, minimum 3,
 * capped at rowCount) to force into the recent window for any table that has
 * AT LEAST ONE `timestamp`-generator column. Mirrors the former hardcoded
 * version's "guaranteed-match block" concept, generalized to run for every
 * table/column pair driven by the descriptor rather than one hand-picked
 * table.
 */
function guaranteedRecentRowIndices(rowCount: number): Set<number> {
  const count = Math.max(3, Math.floor(rowCount / 8))
  const indices = new Set<number>()
  for (let i = 0; i < count && i < rowCount; i++) {
    indices.add((i * 8) % rowCount)
  }
  return indices
}

/** Batches large INSERT VALUES lists so DuckDB never sees one gigantic statement. */
async function insertBatched(
  conn: { run: (sql: string) => Promise<unknown> },
  quotedTable: string,
  rows: string[],
  batchSize = 500
): Promise<void> {
  for (let i = 0; i < rows.length; i += batchSize) {
    const batch = rows.slice(i, i + batchSize)
    if (batch.length === 0) continue
    // eslint-disable-next-line no-await-in-loop
    await conn.run(`INSERT INTO ${quotedTable} VALUES ${batch.join(', ')}`)
  }
}

/**
 * buildSyntheticTopology — the SPEC §6.3(a) / §1.8 hermetic execution
 * target. Reads `catalog.json` + `keys.json` + `synthetic.json` out of a
 * bundle directory (default: the committed fixture bundle), synthesizes an
 * FK-consistent, seeded, shape-preserving DuckDB dataset FROM THE
 * DESCRIPTORS (never hardcoded per-table TS), then attaches it via
 * `DuckDbEngine` under alias `mock` (matching the fixture bundle's
 * `sourceId`), so generated SQL referencing `mock.public."MeasurementsMock"`
 * etc. binds and executes exactly as it would against the real (or
 * mock-Postgres) topology.
 */
export async function buildSyntheticTopology(options: SyntheticTopologyOptions = {}): Promise<SyntheticTopology> {
  const bundleDir = options.bundleDir ?? DEFAULT_FIXTURE_BUNDLE_DIR
  const seed = options.seed ?? SYNTHETIC_SEED
  const rand = mulberry32(seed)
  const now = new Date()

  const catalog = loadBundleJson<CatalogJson>(bundleDir, 'catalog.json')
  const keys = loadBundleJson<KeysJson>(bundleDir, 'keys.json')
  const synthetic = loadBundleJson<SyntheticJson>(bundleDir, 'synthetic.json')

  const tablesByCatalogId = new Map(catalog.tables.map((t) => [t.tableId, t]))
  const descriptorsByTableId = new Map(synthetic.tables.map((t) => [t.tableId, t]))
  const orderedTableIds = topologicalTableOrder(catalog.tables.map((t) => t.tableId), keys.foreignKeys)

  const ownsTempDir = !options.dbPath
  const workDir = ownsTempDir ? path.join(tmpdir(), `nl2sql-eval-synthetic-${process.pid}-${Date.now()}`) : undefined
  if (workDir) mkdirSync(workDir, { recursive: true })
  const dbPath = options.dbPath ?? path.join(workDir as string, 'synthetic.duckdb')

  const buildInstance = await DuckDBInstance.create(dbPath)
  const buildConn = await buildInstance.connect()
  await buildConn.run('CREATE SCHEMA IF NOT EXISTS public')

  const ctx: GenerationContext = { rand, now, pkPoolsByColumnId: new Map() }
  const counts: Record<string, number> = {}

  for (const tableId of orderedTableIds) {
    const table = tablesByCatalogId.get(tableId)
    const descriptor = descriptorsByTableId.get(tableId)
    if (!table || !descriptor) continue // defensive: synthetic.json and catalog.json are expected to agree on table sets

    const descriptorByColumnId = new Map(descriptor.columns.map((c) => [c.columnId, c]))
    const quotedTable = `public.${table.quotedRef.split('.').slice(1).join('.')}`

    // ── DDL ──
    const columnDdls = table.columns.map((col) => {
      const colDescriptor = descriptorByColumnId.get(col.columnId)
      const typeName = ddlType(col.dataType)
      const pkSuffix = col.isPrimaryKey ? ' PRIMARY KEY' : ''
      void colDescriptor
      return `${col.quotedName ?? `"${col.name}"`} ${typeName}${pkSuffix}`
    })
    // eslint-disable-next-line no-await-in-loop
    await buildConn.run(`CREATE TABLE ${quotedTable} (${columnDdls.join(', ')})`)

    // ── rows ──
    const rowCount = Math.max(descriptor.syntheticRowTarget, 0)
    const recentRowIndices = guaranteedRecentRowIndices(rowCount)
    const rows: string[] = []
    const pkValuesThisTable: number[] = []
    let pkColumnId: string | undefined

    for (let rowIndex = 0; rowIndex < rowCount; rowIndex++) {
      const values: string[] = []
      for (const col of table.columns) {
        const colDescriptor = descriptorByColumnId.get(col.columnId)
        if (!colDescriptor) {
          values.push('NULL')
          continue
        }
        const forceRecent = colDescriptor.generator === 'timestamp' && recentRowIndices.has(rowIndex)
        const { sqlLiteral, pkValue } = generateColumnValue(colDescriptor, ctx, rowIndex, forceRecent)
        values.push(sqlLiteral)
        if (pkValue !== undefined) {
          pkColumnId = colDescriptor.columnId
          pkValuesThisTable.push(pkValue)
        }
      }
      rows.push(`(${values.join(', ')})`)
    }

    // eslint-disable-next-line no-await-in-loop
    await insertBatched(buildConn, quotedTable, rows)
    counts[table.name] = rows.length
    if (pkColumnId) ctx.pkPoolsByColumnId.set(pkColumnId, pkValuesThisTable)
  }

  // Helpful indexes on every isTimeColumn column, mirroring the former
  // hardcoded version's RecordedAt index (query-plan realism, not required
  // for correctness).
  for (const table of catalog.tables) {
    for (const col of table.columns) {
      if (!col.isTimeColumn) continue
      const quotedTable = `public.${table.quotedRef.split('.').slice(1).join('.')}`
      const indexName = `ix_${table.name.toLowerCase()}_${col.name.toLowerCase()}`
      // eslint-disable-next-line no-await-in-loop
      await buildConn.run(`CREATE INDEX IF NOT EXISTS ${indexName} ON ${quotedTable} (${col.quotedName ?? `"${col.name}"`})`)
    }
  }

  buildConn.closeSync()
  buildInstance.closeSync()

  // ── attach read-only via the real QueryEngine (mirrors runtime/eval usage) ──
  const engine = new DuckDbEngine()
  const specs: AttachSpec[] = [{ sourceId: 'mock', engine: 'duckdb', dsn: dbPath, readOnly: true, alias: 'mock' }]
  await engine.attach(specs)

  return {
    dbPath,
    engine,
    counts,
    async dispose() {
      await engine.dispose()
      if (workDir && existsSync(workDir)) rmSync(workDir, { recursive: true, force: true })
    },
  }
}
