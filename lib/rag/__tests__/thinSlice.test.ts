/**
 * thinSlice.test.ts — ★ M1 thin slice (NL2SQL_PLAN.md §M1, NL2SQL_SPEC.md §5.1).
 *
 * Proves the NL->SQL architecture end-to-end on ONE question ("heart rate > 120
 * in the last 3 hours") with a HAND-AUTHORED SchemaContext (no retriever yet —
 * that is P4/lib/rag/Retriever.ts), exercising the full safety chain:
 *
 *   promptAssembly -> stub generator -> guardSql -> cardinalityGuard -> explain -> execute
 *
 * Two execution flavors, both asserting the SAME safety-chain outcomes:
 *   (a) REAL INTEGRATION: DuckDB ATTACHes the real mock Postgres (docker/mock-
 *       postgres, localhost:55433) via `TYPE postgres, READ_ONLY` and runs the
 *       generated SQL against it. Skips gracefully (does not fail the suite) if
 *       the mock DB is unreachable, since CI does not guarantee it is up.
 *   (b) HERMETIC (CI-safe): builds an equivalent DuckDB-native table with the
 *       same columns/data for the heart-rate scenario, so the safety-chain
 *       assertions run in any environment with zero external services.
 *
 * Both good-SQL assertions require the exact 3 matching rows (Ids 480, 900001,
 * 900002 per docker/mock-postgres/init/02_seed.sql's deterministic seed — HR>120
 * within the last 3 hours) — verified live against the mock DB while authoring
 * this test (`psql` against localhost:55433).
 */

import { createConnection } from 'node:net'
import { existsSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { DuckDBInstance } from '@duckdb/node-api'
import { DuckDbEngine } from '../../engine/DuckDbEngine'
import type { AttachSpec, EngineCapabilities, QueryEngine, SqlDialect } from '../../engine/QueryEngine'
import { guardSql } from '../../sqlGuard'
import { assemblePrompt, USER_REQUEST_CLOSE, USER_REQUEST_OPEN, type SchemaContext } from '../promptAssembly'
import { cardinalityGuard, type CardinalityGuardOptions } from '../cardinalityGuard'

const MOCK_DSN = process.env.MOCK_DSN ?? 'postgresql://ceiba_ro:ceiba_ro_pw@localhost:55433/mockdb'
const MOCK_HOST = 'localhost'
const MOCK_PORT = 55433
const QUESTION = 'heart rate > 120 in the last 3 hours'
const EXPECTED_IDS = [480, 900001, 900002]

const DUCKDB_CAPABILITIES: EngineCapabilities = {
  supportsCrossCatalogJoin: true,
  identifierQuote: '"',
  intervalSyntax: 'ansi',
  supportsExplain: true,
}
const DIALECT: SqlDialect = 'duckdb'

// ── Hand-authored SchemaContext (SPEC §4 shape; M1 owns no retriever) ─────────
const schemaContext: SchemaContext = {
  tables: [
    {
      tableId: 'mock.public.MeasurementsMock',
      quotedRef: '"MeasurementsMock"',
      grain: 'one row = one device measurement sample for a patient at a timestamp',
      approxRowCount: 480,
      isLargeTimeSeries: true,
      requiredTimeColumn: '"RecordedAt"',
      columns: [
        { name: 'Id', quotedName: '"Id"', dataType: 'BIGINT', isTimeColumn: false },
        { name: 'DeviceId', quotedName: '"DeviceId"', dataType: 'INTEGER', isTimeColumn: false },
        { name: 'MeasurementTypeId', quotedName: '"MeasurementTypeId"', dataType: 'INTEGER', isTimeColumn: false },
        { name: 'Value', quotedName: '"Value"', dataType: 'DOUBLE', isTimeColumn: false },
        { name: 'RecordedAt', quotedName: '"RecordedAt"', dataType: 'TIMESTAMPTZ', isTimeColumn: true },
        { name: 'patientRef', quotedName: '"patientRef"', dataType: 'INTEGER', isTimeColumn: false },
      ],
    },
    {
      tableId: 'mock.public.MeasurementTypeRef',
      quotedRef: '"MeasurementTypeRef"',
      grain: 'one row = one measurement type in the shared reference vocabulary',
      approxRowCount: 5,
      isLargeTimeSeries: false,
      columns: [
        { name: 'MeasurementTypeId', quotedName: '"MeasurementTypeId"', dataType: 'INTEGER', isTimeColumn: false },
        { name: 'name', quotedName: '"name"', dataType: 'TEXT', isTimeColumn: false },
        { name: 'unit', quotedName: '"unit"', dataType: 'TEXT', isTimeColumn: false },
      ],
    },
  ],
  cardinalityWarnings: [],
}

const CARDINALITY_OPTIONS: CardinalityGuardOptions = {
  largeTables: [{ tableName: 'MeasurementsMock', quotedRef: '"MeasurementsMock"' }],
  requiredTimeColumnByTable: { MeasurementsMock: 'RecordedAt' },
  defaultLimit: 1000,
}

// ── Stub generators (no network, no real LLM, no BAA needed) ──────────────────

/** KNOWN-GOOD: a bounded, read-only SELECT joining the two hand-authored tables. */
function stubGeneratorGood(): string {
  return `SELECT m."Id", m."Value", m."RecordedAt"
FROM "MeasurementsMock" m
JOIN "MeasurementTypeRef" t ON m."MeasurementTypeId" = t."MeasurementTypeId"
WHERE t."name" = 'Heart Rate' AND m."Value" > 120 AND m."RecordedAt" >= now() - INTERVAL '3 hours'
ORDER BY m."Id"
LIMIT 1000`
}

/** KNOWN-BAD (a): unbounded scan — no time bound, no LIMIT. */
function stubGeneratorUnboundedScan(): string {
  return `SELECT m."Id", m."Value", m."RecordedAt"
FROM "MeasurementsMock" m
JOIN "MeasurementTypeRef" t ON m."MeasurementTypeId" = t."MeasurementTypeId"
WHERE t."name" = 'Heart Rate' AND m."Value" > 120`
}

/** KNOWN-BAD (b): a write statement. */
function stubGeneratorWrite(): string {
  return `UPDATE "MeasurementsMock" SET "Value" = 0 WHERE "Id" = 1`
}

async function isMockDbReachable(): Promise<boolean> {
  return new Promise((resolve) => {
    const probe = createConnection({ host: MOCK_HOST, port: MOCK_PORT, timeout: 1500 })
    const done = (result: boolean) => {
      probe.removeAllListeners()
      probe.destroy()
      resolve(result)
    }
    probe.once('connect', () => done(true))
    probe.once('timeout', () => done(false))
    probe.once('error', () => done(false))
  })
}

describe('M1 thin slice — promptAssembly', () => {
  const prompt = assemblePrompt(schemaContext, QUESTION, DUCKDB_CAPABILITIES, DIALECT)

  it('delimits the untrusted question and marks it as data-not-instructions (H25)', () => {
    expect(prompt).toContain(USER_REQUEST_OPEN)
    expect(prompt).toContain(USER_REQUEST_CLOSE)
    expect(prompt).toContain(QUESTION)
    // The question text must appear strictly between the delimiters.
    const openIdx = prompt.indexOf(USER_REQUEST_OPEN)
    const closeIdx = prompt.indexOf(USER_REQUEST_CLOSE)
    const questionIdx = prompt.indexOf(QUESTION)
    expect(questionIdx).toBeGreaterThan(openIdx)
    expect(questionIdx).toBeLessThan(closeIdx)
    expect(prompt.toLowerCase()).toContain('untrusted')
    expect(prompt.toLowerCase()).toMatch(/data\b.*never.*instructions|treat it strictly as data/i)
  })

  it('renders the schema: table names, columns, and the time column', () => {
    expect(prompt).toContain('"MeasurementsMock"')
    expect(prompt).toContain('"MeasurementTypeRef"')
    expect(prompt).toContain('"RecordedAt"')
    expect(prompt).toContain('TIME COLUMN')
    expect(prompt).toContain('"Value"')
    expect(prompt).toContain('"name"')
  })

  it('injects a cardinality warning for the large/time-series table', () => {
    expect(prompt).toContain('CARDINALITY WARNING')
    expect(prompt).toMatch(/"MeasurementsMock".*(?:~480|480).*rows/i)
    expect(prompt.toLowerCase()).toContain('limit')
    expect(prompt).toContain('"RecordedAt"')
  })

  it('states the dialect from engine capabilities, not a hardcoded string', () => {
    expect(prompt).toContain('duckdb')
    expect(prompt).toContain(DUCKDB_CAPABILITIES.intervalSyntax)
  })
})

describe('M1 thin slice — safety chain with stub generators (guard + cardinality only, no engine)', () => {
  it('KNOWN-GOOD SQL passes guardSql and cardinalityGuard', () => {
    const sql = stubGeneratorGood()
    const guardVerdict = guardSql(sql)
    expect(guardVerdict.allowed).toBe(true)
    expect(guardVerdict.statementType).toBe('SELECT')

    const cardVerdict = cardinalityGuard(sql, CARDINALITY_OPTIONS)
    expect(cardVerdict.ok).toBe(true)
    expect(cardVerdict.action).toBe('pass')
  })

  it('KNOWN-BAD (a) unbounded scan is rejected or repaired by cardinalityGuard', () => {
    const sql = stubGeneratorUnboundedScan()
    const guardVerdict = guardSql(sql)
    // It IS a plain SELECT, so sqlGuard alone allows it — cardinalityGuard is the
    // control that must catch the missing time bound + missing LIMIT.
    expect(guardVerdict.allowed).toBe(true)

    const cardVerdict = cardinalityGuard(sql, CARDINALITY_OPTIONS)
    expect(cardVerdict.action).not.toBe('pass')
    expect(['repair', 'reject']).toContain(cardVerdict.action)
    if (cardVerdict.action === 'reject') {
      expect(cardVerdict.ok).toBe(false)
      expect(cardVerdict.reason).toMatch(/unbounded|time-bound/i)
    }
  })

  it('KNOWN-BAD (b) write statement is rejected by guardSql', () => {
    const sql = stubGeneratorWrite()
    const guardVerdict = guardSql(sql)
    expect(guardVerdict.allowed).toBe(false)
    expect(guardVerdict.statementType).toBe('UPDATE')
    expect(guardVerdict.reason).toMatch(/not permitted|read-only/i)
  })
})

describe('M1 thin slice — HERMETIC path (DuckDB-native, CI-safe)', () => {
  let workDir: string
  let dbPath: string
  let engine: DuckDbEngine

  beforeAll(async () => {
    workDir = join(tmpdir(), `nl2sql-m1-hermetic-${process.pid}-${Date.now()}`)
    mkdirSync(workDir, { recursive: true })
    dbPath = join(workDir, 'hermetic.duckdb')

    // Build a DuckDB-native table with the SAME columns/data as the mock
    // Postgres "MeasurementsMock" + "MeasurementTypeRef" for the heart-rate
    // scenario, including the exact 3 rows that satisfy HR>120 in the last 3h
    // (Ids 480, 900001, 900002 — verified live against the mock DB).
    const seedInstance = await DuckDBInstance.create(dbPath)
    const seedConn = await seedInstance.connect()
    await seedConn.run(`
      CREATE TABLE "MeasurementTypeRef" (
        "MeasurementTypeId" INTEGER PRIMARY KEY,
        "name" VARCHAR NOT NULL,
        "unit" VARCHAR NOT NULL
      )
    `)
    await seedConn.run(`
      INSERT INTO "MeasurementTypeRef" VALUES
        (1, 'Heart Rate', 'bpm'),
        (2, 'SpO2', '%')
    `)
    await seedConn.run(`
      CREATE TABLE "MeasurementsMock" (
        "Id" BIGINT PRIMARY KEY,
        "DeviceId" INTEGER NOT NULL,
        "MeasurementTypeId" INTEGER NOT NULL,
        "Value" DOUBLE NOT NULL,
        "RecordedAt" TIMESTAMPTZ NOT NULL,
        "patientRef" INTEGER NOT NULL
      )
    `)
    // Row 480: HR>120 within last 3h (matches). Row 481: HR<120 recent (non-match).
    // Rows 900001/900002: HR>120 within last 3h (matches, mirrors the mock seed's
    // reserved-Id guarantee rows). Row 900003: HR<120 recent (non-match).
    // Row 100: HR>120 but 7 days old (non-match — outside the 3h window).
    await seedConn.run(`
      INSERT INTO "MeasurementsMock" VALUES
        (100,    1001, 1, 135.0, now() - INTERVAL '7 days',    1),
        (480,    1002, 1, 135.0, now() - INTERVAL '30 minutes', 2),
        (481,    1003, 1,  72.0, now() - INTERVAL '31 minutes', 3),
        (900001, 1004, 1, 145.0, now() - INTERVAL '30 minutes', 4),
        (900002, 1005, 1, 158.0, now() - INTERVAL '90 minutes', 5),
        (900003, 1006, 1,  68.0, now() - INTERVAL '45 minutes', 6)
    `)
    seedConn.closeSync()
    seedInstance.closeSync()

    engine = new DuckDbEngine()
  })

  afterAll(async () => {
    await engine.dispose()
    if (existsSync(workDir)) rmSync(workDir, { recursive: true, force: true })
  })

  it('runs the full safety chain: guard -> cardinality -> explain -> execute, returns the 3 matching rows', async () => {
    const specs: AttachSpec[] = [{ sourceId: 'hermetic', engine: 'duckdb', dsn: dbPath, readOnly: true, alias: 'hermetic' }]
    await engine.attach(specs)

    const sql = `SELECT m."Id", m."Value", m."RecordedAt"
FROM hermetic."MeasurementsMock" m
JOIN hermetic."MeasurementTypeRef" t ON m."MeasurementTypeId" = t."MeasurementTypeId"
WHERE t."name" = 'Heart Rate' AND m."Value" > 120 AND m."RecordedAt" >= now() - INTERVAL '3 hours'
ORDER BY m."Id"
LIMIT 1000`

    const guardVerdict = guardSql(sql)
    expect(guardVerdict.allowed).toBe(true)

    const cardVerdict = cardinalityGuard(sql, CARDINALITY_OPTIONS)
    expect(cardVerdict.ok).toBe(true)
    expect(cardVerdict.action).toBe('pass')

    const explainVerdict = await engine.explain(sql, {})
    expect(explainVerdict.ok).toBe(true)

    const result = await engine.execute(sql, { maxRows: 1000, deadlineMs: 10_000 })
    expect(result.truncated).toBe(false)
    expect(result.rowCount).toBe(3)
    const ids = result.rows.map((r) => Number(r.Id)).toSorted((a, b) => a - b)
    expect(ids).toEqual(EXPECTED_IDS)
  })

  it('KNOWN-BAD unbounded scan against the hermetic table is rejected/repaired before execute', async () => {
    const sql = `SELECT m."Id" FROM hermetic."MeasurementsMock" m
JOIN hermetic."MeasurementTypeRef" t ON m."MeasurementTypeId" = t."MeasurementTypeId"
WHERE t."name" = 'Heart Rate' AND m."Value" > 120`

    const cardVerdict = cardinalityGuard(sql, CARDINALITY_OPTIONS)
    expect(['repair', 'reject']).toContain(cardVerdict.action)
    // This is the paradigm "wholly unbounded" case (no time predicate at all) —
    // must not be silently passed through to engine.execute.
    expect(cardVerdict.action).toBe('reject')
  })
})

describe('M1 thin slice — REAL INTEGRATION (mock Postgres ATTACH, skips if unreachable)', () => {
  let mockReachable = false
  let engine: QueryEngine | undefined

  beforeAll(async () => {
    mockReachable = await isMockDbReachable()
  })

  afterAll(async () => {
    if (engine) await engine.dispose()
  })

  it('attaches the mock Postgres READ_ONLY and returns the 3 matching heart-rate rows via the full safety chain', async (ctx) => {
    if (!mockReachable) {
      ctx.skip()
      return
    }

    engine = new DuckDbEngine()
    const specs: AttachSpec[] = [{ sourceId: 'mock', engine: 'postgres', dsn: MOCK_DSN, readOnly: true, alias: 'mock' }]
    await engine.attach(specs)

    const sql = `SELECT m."Id", m."Value", m."RecordedAt"
FROM mock.public."MeasurementsMock" m
JOIN mock.public."MeasurementTypeRef" t ON m."MeasurementTypeId" = t."MeasurementTypeId"
WHERE t."name" = 'Heart Rate' AND m."Value" > 120 AND m."RecordedAt" >= now() - INTERVAL '3 hours'
ORDER BY m."Id"
LIMIT 1000`

    const guardVerdict = guardSql(sql)
    expect(guardVerdict.allowed).toBe(true)

    const cardVerdict = cardinalityGuard(sql, CARDINALITY_OPTIONS)
    expect(cardVerdict.ok).toBe(true)
    expect(cardVerdict.action).toBe('pass')

    const explainVerdict = await engine.explain(sql, {})
    expect(explainVerdict.ok).toBe(true)

    const result = await engine.execute(sql, { maxRows: 1000, deadlineMs: 15_000 })
    expect(result.truncated).toBe(false)
    expect(result.rowCount).toBe(3)
    const ids = result.rows.map((r) => Number(r.Id)).toSorted((a, b) => a - b)
    expect(ids).toEqual(EXPECTED_IDS)
  }, 20_000)

  it('rejects a write statement against the mock Postgres attach before it ever reaches execute()', async (ctx) => {
    if (!mockReachable) {
      ctx.skip()
      return
    }
    const sql = stubGeneratorWrite()
    const guardVerdict = guardSql(sql)
    expect(guardVerdict.allowed).toBe(false)
  })
})
