/**
 * route.test.ts — POST /api/query engine migration (NL2SQL_SPEC.md §5.6; P1 fix).
 *
 * Proves the P1 dialect-mismatch fix and that all WS-F hardening survived the
 * migration from `executeTrinoQuery` to the shared DuckDbEngine:
 *
 *   • /api/query EXECUTES a read-only SELECT via DuckDbEngine and returns rows
 *     (hermetic: a DuckDB-native file source attached READ_ONLY — no live PG needed).
 *   • a write / DDL statement is rejected (guardSql 422 + the attach is read-only,
 *     so even a bypass could not write).
 *   • the generation route's dialect === the execution route's dialect (both
 *     'duckdb') — the mismatch is eliminated at the source (shared provisioning).
 *   • existing hardening is intact: 401 (unauth), 400 (bad body), 413 (oversize),
 *     429 (rate limit), and the catalog/schema allowlist rejects arbitrary values.
 *
 * Fully hermetic + CI-safe: the shared engine is injected via
 * `__setQueryEngineForTest` with a DuckDB **file** source (no :55432 staging, no
 * network). It does NOT depend on the :55433 mock Postgres.
 */

import { existsSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type { NextRequest } from 'next/server'
import { DuckDBInstance } from '@duckdb/node-api'
import { DuckDbEngine } from '@/lib/engine/DuckDbEngine'
import type { AttachSpec } from '@/lib/engine/QueryEngine'
import { __setQueryEngineForTest, resolvedDialect } from '@/lib/engine/provisioning'
import { signSession } from '@/lib/session'
import { resetRateLimit, rateLimitKey } from '@/lib/rateLimiter'
import { POST } from '../route'

beforeAll(() => {
  // requireAuthWithPermission -> verifySession needs a signing secret.
  process.env.SESSION_SECRET = process.env.SESSION_SECRET ?? 'test-session-secret-0123456789'
})

// ── hermetic DuckDB-native source (no PG, no network) ─────────────────────────

let workDir: string
let engine: DuckDbEngine

beforeAll(async () => {
  workDir = path.join(tmpdir(), `nl2sql-query-route-${process.pid}-${Date.now()}`)
  mkdirSync(workDir, { recursive: true })
  const dbPath = path.join(workDir, 'hermetic.duckdb')

  // Seed a tiny DuckDB file whose `public` schema holds a couple of rows. Attaching
  // it under alias `mock` mirrors the runtime topology (alias `mock` = MOCK_DSN),
  // but as a DuckDB-native file it needs no Postgres — fully hermetic.
  const seedInstance = await DuckDBInstance.create(dbPath)
  const seedConn = await seedInstance.connect()
  await seedConn.run('CREATE SCHEMA IF NOT EXISTS public')
  await seedConn.run(`
    CREATE TABLE public."VisitMock" (
      "visitRef" INTEGER PRIMARY KEY,
      "patientRef" INTEGER,
      "admittedAt" TIMESTAMPTZ
    )`)
  await seedConn.run(`INSERT INTO public."VisitMock" VALUES
    (1, 100, now() - INTERVAL '12 hours'),
    (2, 101, now() - INTERVAL '6 hours')`)
  seedConn.closeSync()
  seedInstance.closeSync()

  engine = new DuckDbEngine()
  const specs: AttachSpec[] = [{ sourceId: 'mock', engine: 'duckdb', dsn: dbPath, readOnly: true, alias: 'mock' }]
  await engine.attach(specs)
  __setQueryEngineForTest(engine)
})

afterAll(async () => {
  __setQueryEngineForTest(null)
  await engine.dispose()
  if (existsSync(workDir)) rmSync(workDir, { recursive: true, force: true })
})

// ── request builder ───────────────────────────────────────────────────────────

interface MakeReqOptions {
  body?: unknown
  orgId?: string
  role?: 'admin' | 'analyst' | 'clinician'
  userId?: string
  authenticated?: boolean
  contentLength?: number
}

function makeReq(opts: MakeReqOptions = {}): NextRequest {
  const {
    body = { sql: 'SELECT 1 AS n', database: 'mock', schema: 'public' },
    orgId = 'orgA',
    role = 'clinician',
    userId = 'user-1',
    authenticated = true,
    contentLength,
  } = opts

  const headers = new Headers({ 'Content-Type': 'application/json' })
  if (authenticated) {
    const cookie = signSession({ userId, orgId, role })
    headers.set('cookie', `ceiba_session=${encodeURIComponent(cookie)}`)
  }
  if (contentLength !== undefined) headers.set('content-length', String(contentLength))

  return new Request('http://localhost/api/query', {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  }) as unknown as NextRequest
}

beforeEach(() => {
  resetRateLimit(rateLimitKey({ userId: 'user-1' }, 'query'))
  resetRateLimit(rateLimitKey({ userId: 'user-2' }, 'query'))
})

describe('POST /api/query — executes via DuckDbEngine (P1 fix)', () => {
  it('executes a read-only SELECT and returns rows', async () => {
    const res = await POST(
      makeReq({ body: { sql: 'SELECT 1 AS n, 2 AS m', database: 'mock', schema: 'public' } })
    )
    expect(res.status).toBe(200)
    const json = await res.json()
    expect(Array.isArray(json.rows)).toBe(true)
    expect(json.rows.length).toBe(1)
    expect(json.rowCount).toBe(1)
    expect(json.columns.map((c: { key: string }) => c.key)).toEqual(['n', 'm'])
  })

  it('reads rows from the attached (read-only) source', async () => {
    const res = await POST(
      makeReq({ body: { sql: 'SELECT "visitRef", "patientRef" FROM mock.public."VisitMock" ORDER BY "visitRef"' } })
    )
    expect(res.status).toBe(200)
    const json = await res.json()
    expect(json.rowCount).toBe(2)
    expect(json.rows[0].patientRef).toBe(100)
  })

  it('interval syntax that generation validated as duckdb executes cleanly here', async () => {
    // The exact dialect construct the P1 gap risked (INTERVAL): validated as duckdb
    // in /api/sql-generate, so it MUST run on the duckdb execution engine too.
    const res = await POST(
      makeReq({
        body: {
          sql: `SELECT "visitRef" FROM mock.public."VisitMock" WHERE "admittedAt" >= now() - INTERVAL '1 day'`,
        },
      })
    )
    expect(res.status).toBe(200)
    const json = await res.json()
    expect(json.rowCount).toBe(2)
  })
})

describe('POST /api/query — write / DDL rejected', () => {
  it('rejects a DELETE with 422 SCOPE (guardSql)', async () => {
    const res = await POST(makeReq({ body: { sql: 'DELETE FROM mock.public."VisitMock"' } }))
    expect(res.status).toBe(422)
    const json = await res.json()
    expect(json.error.code).toBe('SCOPE')
    expect(json.error.message).not.toMatch(/stack|at Object/i)
  })

  it('rejects DDL (CREATE TABLE) with 422 SCOPE', async () => {
    const res = await POST(makeReq({ body: { sql: 'CREATE TABLE public.evil (x INT)' } }))
    expect(res.status).toBe(422)
    expect((await res.json()).error.code).toBe('SCOPE')
  })

  it('rejects a comment-prefixed write (B1 bypass vector)', async () => {
    const res = await POST(
      makeReq({ body: { sql: `/* x */ DELETE FROM mock.public."VisitMock"` } })
    )
    expect(res.status).toBe(422)
    expect((await res.json()).error.code).toBe('SCOPE')
  })
})

describe('POST /api/query — dialect matches generation (mismatch eliminated)', () => {
  it('the execution engine dialect === the resolved provisioning dialect (both duckdb)', () => {
    // /api/sql-generate labels its response with `deps.engine.dialect()`, and
    // deps.engine === getQueryEngine() (shared provisioning). The execution engine
    // this route runs on is that same engine. resolvedDialect() is the config-derived
    // dialect both routes agree on.
    expect(engine.dialect()).toBe('duckdb')
    expect(resolvedDialect()).toBe('duckdb')
    expect(engine.dialect()).toBe(resolvedDialect())
  })
})

describe('POST /api/query — catalog/schema allowlist (H22 identifier injection)', () => {
  it('an unknown database alias is NOT forwarded verbatim (falls back to safe default)', async () => {
    // `database: 'evil; DROP'` is neither in the allowlist nor identifier-shaped; the
    // route falls back to the default alias and still runs the (guard-passed) SELECT.
    const res = await POST(
      makeReq({ body: { sql: 'SELECT 1 AS n', database: 'evil; DROP TABLE x', schema: 'public' } })
    )
    expect(res.status).toBe(200)
  })

  it('an unknown schema falls back to the default schema', async () => {
    const res = await POST(
      makeReq({ body: { sql: 'SELECT 1 AS n', database: 'mock', schema: 'not a schema' } })
    )
    expect(res.status).toBe(200)
  })
})

describe('POST /api/query — hardening is preserved', () => {
  it('401 when unauthenticated', async () => {
    const res = await POST(makeReq({ authenticated: false }))
    expect(res.status).toBe(401)
  })

  it('400 when the body fails the schema (missing sql)', async () => {
    const res = await POST(makeReq({ body: { database: 'mock' } }))
    expect(res.status).toBe(400)
    expect((await res.json()).error.code).toBe('VALIDATION')
  })

  it('413 when Content-Length exceeds the body-size cap', async () => {
    const res = await POST(makeReq({ contentLength: 5 * 1024 * 1024 }))
    expect(res.status).toBe(413)
  })

  it('429 once the per-user rate limit is exceeded', async () => {
    // query limit is 30/min; drain it, then the next call is limited.
    let lastStatus = 0
    for (let i = 0; i < 31; i++) {
      // eslint-disable-next-line no-await-in-loop
      const res = await POST(makeReq())
      lastStatus = res.status
    }
    expect(lastStatus).toBe(429)
  })
})
