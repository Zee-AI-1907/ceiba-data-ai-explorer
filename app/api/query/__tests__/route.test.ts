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
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { NextRequest } from 'next/server'
import { DuckDBInstance } from '@duckdb/node-api'
import { DuckDbEngine } from '@/lib/engine/DuckDbEngine'
import type { AttachSpec } from '@/lib/engine/QueryEngine'
import { __setQueryEngineForTest, resolvedDialect } from '@/lib/engine/provisioning'
import { signSession } from '@/lib/session'
import { resetRateLimit, rateLimitKey } from '@/lib/rateLimiter'
import { getRecentAuditEvents } from '@/lib/auditLog'
import { POST, __setServiceFetchForTest } from '../route'

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

// ── Phase 4: NL2SQL_QUERY_RUNTIME=python cutover (mocked service fetch) ────────
//
// Proves the flag-on EXECUTION path (a) keeps ALL the TS hardening, (b) runs the
// guardSql RE-GUARD in TS BEFORE any service dispatch (a DELETE never reaches the
// service — the boundary stays TS, §1.3), (c) sends the correct request shape
// (bearer token + correlation id + tenantId/context + clamped maxRows + deadline)
// to /nl2sql/execute, (d) maps the {columns,rows,rowCount,truncated} response back
// to the route's client shape, (e) maps a service error envelope / transport
// failure onto a generic safeError 502 (H20), and (f) still writes the audit
// event. All with a MOCKED fetch (no live service, fully hermetic). The default
// 'ts' path is covered by every describe above; those run with the flag unset.

describe('POST /api/query — python runtime (NL2SQL_QUERY_RUNTIME=python)', () => {
  /** A service /nl2sql/execute success body (ExecuteResponse). */
  const SERVICE_SUCCESS = {
    columns: [
      { name: 'visitRef', type: 'INTEGER' },
      { name: 'patientRef', type: 'INTEGER' },
    ],
    rows: [
      { visitRef: 1, patientRef: 100 },
      { visitRef: 2, patientRef: 101 },
    ],
    rowCount: 2,
    truncated: false,
  }

  /** Build a mocked fetch returning a chosen status + JSON body, capturing the call. */
  function mockServiceFetch(status: number, body: unknown) {
    const calls: Array<{ url: string; init: RequestInit }> = []
    const fetchImpl = (async (url: unknown, init: unknown) => {
      calls.push({ url: String(url), init: init as RequestInit })
      return new Response(JSON.stringify(body), {
        status,
        headers: { 'content-type': 'application/json' },
      })
    }) as unknown as typeof fetch
    return { fetchImpl, calls }
  }

  beforeEach(() => {
    vi.stubEnv('NL2SQL_QUERY_RUNTIME', 'python')
    vi.stubEnv('NL2SQL_SERVICE_URL', 'http://nl2sql.test:8088')
    vi.stubEnv('NL2SQL_SERVICE_TOKEN', 'test-service-token')
  })

  afterEach(() => {
    __setServiceFetchForTest(null)
    vi.unstubAllEnvs()
  })

  it('keeps the auth hardening (401 unauthenticated) before ever calling the service', async () => {
    const { fetchImpl, calls } = mockServiceFetch(200, SERVICE_SUCCESS)
    __setServiceFetchForTest(fetchImpl)
    const res = await POST(makeReq({ authenticated: false }))
    expect(res.status).toBe(401)
    expect(calls).toHaveLength(0) // never reached the service
  })

  it('keeps the body-validation hardening (400 missing sql) before ever calling the service', async () => {
    const { fetchImpl, calls } = mockServiceFetch(200, SERVICE_SUCCESS)
    __setServiceFetchForTest(fetchImpl)
    const res = await POST(makeReq({ body: { database: 'mock' } }))
    expect(res.status).toBe(400)
    expect((await res.json()).error.code).toBe('VALIDATION')
    expect(calls).toHaveLength(0)
  })

  it('keeps the body-size hardening (413) before ever calling the service', async () => {
    const { fetchImpl, calls } = mockServiceFetch(200, SERVICE_SUCCESS)
    __setServiceFetchForTest(fetchImpl)
    const res = await POST(makeReq({ contentLength: 5 * 1024 * 1024 }))
    expect(res.status).toBe(413)
    expect(calls).toHaveLength(0)
  })

  it('keeps the rate-limit hardening (429) before ever calling the service', async () => {
    const { fetchImpl } = mockServiceFetch(200, SERVICE_SUCCESS)
    __setServiceFetchForTest(fetchImpl)
    let lastStatus = 0
    for (let i = 0; i < 31; i++) {
      // eslint-disable-next-line no-await-in-loop
      const res = await POST(makeReq())
      lastStatus = res.status
    }
    expect(lastStatus).toBe(429)
  })

  it('guardSql REJECTS a write (DELETE) in TS BEFORE any service dispatch (boundary stays TS)', async () => {
    const { fetchImpl, calls } = mockServiceFetch(200, SERVICE_SUCCESS)
    __setServiceFetchForTest(fetchImpl)
    const res = await POST(makeReq({ body: { sql: 'DELETE FROM mock.public."VisitMock"' } }))
    expect(res.status).toBe(422)
    expect((await res.json()).error.code).toBe('SCOPE')
    // The service was NEVER called — the DELETE never left the TS boundary.
    expect(calls).toHaveLength(0)
  })

  it('guardSql REJECTS a comment-prefixed write (B1 bypass) before dispatch', async () => {
    const { fetchImpl, calls } = mockServiceFetch(200, SERVICE_SUCCESS)
    __setServiceFetchForTest(fetchImpl)
    const res = await POST(makeReq({ body: { sql: `/* x */ DROP TABLE mock.public."VisitMock"` } }))
    expect(res.status).toBe(422)
    expect((await res.json()).error.code).toBe('SCOPE')
    expect(calls).toHaveLength(0)
  })

  it('sends the correct request shape (bearer, correlation id, tenantId, context, clamped maxRows, deadline)', async () => {
    const { fetchImpl, calls } = mockServiceFetch(200, SERVICE_SUCCESS)
    __setServiceFetchForTest(fetchImpl)
    const res = await POST(
      makeReq({
        orgId: 'orgX',
        userId: 'user-1',
        role: 'clinician',
        body: { sql: 'SELECT 1 AS n', database: 'mock', schema: 'public', limit: 999999 },
      })
    )
    expect(res.status).toBe(200)
    expect(calls).toHaveLength(1)

    const { url, init } = calls[0]
    expect(url).toBe('http://nl2sql.test:8088/nl2sql/execute')
    const headers = new Headers(init.headers)
    expect(headers.get('authorization')).toBe('Bearer test-service-token')
    expect(headers.get('x-correlation-id')).toBeTruthy()

    const sent = JSON.parse(init.body as string)
    expect(sent.sql).toBe('SELECT 1 AS n')
    expect(sent.tenantId).toBe('orgX')
    expect(sent.context).toEqual({ userId: 'user-1', activeOrgId: 'orgX', role: 'clinician' })
    expect(sent.database).toBe('mock')
    expect(sent.schema).toBe('public')
    // limit 999999 is clamped to MAX_QUERY_ROWS=5000 before the service call.
    expect(sent.maxRows).toBe(5000)
    expect(sent.deadlineMs).toBeGreaterThan(0)
  })

  it('forwards an inbound x-correlation-id unchanged to the service', async () => {
    const { fetchImpl, calls } = mockServiceFetch(200, SERVICE_SUCCESS)
    __setServiceFetchForTest(fetchImpl)
    const req = makeReq({ body: { sql: 'SELECT 1 AS n' } })
    req.headers.set('x-correlation-id', 'trace-abc-123')
    const res = await POST(req)
    expect(res.status).toBe(200)
    expect(new Headers(calls[0].init.headers).get('x-correlation-id')).toBe('trace-abc-123')
  })

  it('maps the service {columns,rows,rowCount,truncated} back to the route response shape', async () => {
    const { fetchImpl } = mockServiceFetch(200, SERVICE_SUCCESS)
    __setServiceFetchForTest(fetchImpl)
    const res = await POST(makeReq({ body: { sql: 'SELECT 1 AS n' } }))
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toContain('application/json')

    const json = await res.json()
    expect(json.rowCount).toBe(2)
    expect(json.truncated).toBe(false)
    expect(json.rows).toEqual(SERVICE_SUCCESS.rows)
    // engine {name,type} → client {key,label,type}.
    expect(json.columns).toEqual([
      { key: 'visitRef', label: 'visitRef', type: 'INTEGER' },
      { key: 'patientRef', label: 'patientRef', type: 'INTEGER' },
    ])
  })

  it('surfaces truncation from the service', async () => {
    const { fetchImpl } = mockServiceFetch(200, { ...SERVICE_SUCCESS, rowCount: 1, truncated: true })
    __setServiceFetchForTest(fetchImpl)
    const res = await POST(makeReq({ body: { sql: 'SELECT 1 AS n' } }))
    expect((await res.json()).truncated).toBe(true)
  })

  it('maps a service error envelope (502 engine) to a safeError 502 with NO leaked detail', async () => {
    const { fetchImpl } = mockServiceFetch(502, {
      error: { kind: 'engine', message: 'DuckDB Binder Error: no such column secret_internal_detail' },
    })
    __setServiceFetchForTest(fetchImpl)
    const res = await POST(makeReq({ body: { sql: 'SELECT 1 AS n' } }))
    expect(res.status).toBe(502)
    const json = await res.json()
    expect(json.error.code).toBe('UPSTREAM')
    // H20: the raw upstream message never reaches the client.
    expect(json.error.message).not.toMatch(/DuckDB|secret_internal_detail|Binder/i)
  })

  it('maps a service guard envelope (422) to a safeError 502 (defense-in-depth signal, not a client 422)', async () => {
    // The TS guard already passed (it is the boundary); a service-side guard
    // rejection is an internal inconsistency surfaced as a generic upstream 502.
    const { fetchImpl } = mockServiceFetch(422, {
      error: { kind: 'guard', message: 'rejected by read-only guard' },
    })
    __setServiceFetchForTest(fetchImpl)
    const res = await POST(makeReq({ body: { sql: 'SELECT 1 AS n' } }))
    expect(res.status).toBe(502)
    expect((await res.json()).error.code).toBe('UPSTREAM')
  })

  it('maps a transport failure to a safeError 502', async () => {
    const fetchImpl = (async () => {
      throw new TypeError('fetch failed')
    }) as unknown as typeof fetch
    __setServiceFetchForTest(fetchImpl)
    const res = await POST(makeReq({ body: { sql: 'SELECT 1 AS n' } }))
    expect(res.status).toBe(502)
    expect((await res.json()).error.code).toBe('UPSTREAM')
  })

  it('writes the QUERY_RUN audit event on the python success path', async () => {
    const { fetchImpl } = mockServiceFetch(200, SERVICE_SUCCESS)
    __setServiceFetchForTest(fetchImpl)
    const before = getRecentAuditEvents(50, 'orgAudit').length
    const res = await POST(
      makeReq({ orgId: 'orgAudit', body: { sql: `SELECT ${Math.floor(Math.random() * 1e6)} AS n` } })
    )
    expect(res.status).toBe(200)
    const events = getRecentAuditEvents(50, 'orgAudit')
    expect(events.length).toBeGreaterThan(before)
    expect(events[0].action).toBe('QUERY_RUN')
    expect(events[0].orgId).toBe('orgAudit')
    expect(events[0].rowsAffected).toBe(2)
  })

  it('writes the QUERY_FAILED audit event on the python error path', async () => {
    const { fetchImpl } = mockServiceFetch(502, { error: { kind: 'engine', message: 'boom' } })
    __setServiceFetchForTest(fetchImpl)
    const before = getRecentAuditEvents(50, 'orgFail').length
    const res = await POST(
      makeReq({ orgId: 'orgFail', body: { sql: `SELECT ${Math.floor(Math.random() * 1e6)} AS n` } })
    )
    expect(res.status).toBe(502)
    const events = getRecentAuditEvents(50, 'orgFail')
    expect(events.length).toBeGreaterThan(before)
    expect(events[0].action).toBe('QUERY_FAILED')
    expect(events[0].orgId).toBe('orgFail')
  })
})
