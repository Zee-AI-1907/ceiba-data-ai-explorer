/**
 * route.test.ts — POST /api/query as a thin always-python proxy
 * (docs/TS_RUNTIME_RETIREMENT_PLAN.md §6). The in-process TS DuckDbEngine and the
 * TS guardSql re-guard have been RETIRED; this route now does auth + RBAC + org
 * scoping + rate-limit + body caps + the catalog/schema allowlist, then POSTs to
 * the Python service's /nl2sql/execute and runs the audit/anomaly post-pipeline.
 *
 * The read-only SECURITY BOUNDARY is now the service's own guard_sql (verified in
 * ceiba_nl2sql_service/tests/test_execute.py + ceiba_nl2sql/tests/test_sqlguard.py).
 * A rejected write/DDL comes back as an error envelope kind:"guard", which this
 * route maps to 422 SCOPE (preserving the historical client contract).
 *
 * Fully hermetic: the service call is mocked via the __setServiceFetchForTest seam
 * (no live FastAPI, no DuckDB, no network).
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { NextRequest } from 'next/server'
import { signSession } from '@/lib/session'
import { resetRateLimit, rateLimitKey } from '@/lib/rateLimiter'
import { getRecentAuditEvents } from '@/lib/auditLog'
import { __setUserResolverForTest, type User } from '@/lib/authStore'
import { POST, __setServiceFetchForTest } from '../route'

// Orgs these tests forge sessions into. requireAuthWithPermission re-resolves the
// effective role from the live store (multi-org plan §2.3, revocation-safe), so a
// forged principal must be resolvable with a membership in each forged org.
const FORGED_ORGS = ['orgA', 'orgX', 'orgAudit', 'orgFail']

function allOrgsResolver() {
  __setUserResolverForTest((id: string): User => ({
    id,
    email: `${id}@test.local`,
    passwordHash: 'x',
    memberships: FORGED_ORGS.map((orgId) => ({ orgId, role: 'clinician' as const })),
    defaultOrgId: FORGED_ORGS[0],
    name: id,
    createdAt: new Date(0).toISOString(),
  }))
}

beforeAll(() => {
  process.env.SESSION_SECRET = process.env.SESSION_SECRET ?? 'test-session-secret-0123456789'
  allOrgsResolver()
})

afterAll(() => {
  __setUserResolverForTest(null)
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
  resetRateLimit(rateLimitKey({ userId: 'user-1' }, 'query'))
  resetRateLimit(rateLimitKey({ userId: 'user-2' }, 'query'))
  vi.stubEnv('NL2SQL_SERVICE_URL', 'http://nl2sql.test:8088')
  vi.stubEnv('NL2SQL_SERVICE_TOKEN', 'test-service-token')
})

afterEach(() => {
  __setServiceFetchForTest(null)
  vi.unstubAllEnvs()
})

// ── happy path: proxy to the service ──────────────────────────────────────────

describe('POST /api/query — proxies execution to the Python service', () => {
  it('executes a read-only SELECT and maps the service response to the client shape', async () => {
    const { fetchImpl } = mockServiceFetch(200, SERVICE_SUCCESS)
    __setServiceFetchForTest(fetchImpl)
    const res = await POST(makeReq({ body: { sql: 'SELECT "visitRef","patientRef" FROM mock.public."VisitMock"' } }))
    expect(res.status).toBe(200)
    const json = await res.json()
    expect(json.rowCount).toBe(2)
    expect(json.rows).toEqual(SERVICE_SUCCESS.rows)
    // engine {name,type} → client {key,label,type}
    expect(json.columns).toEqual([
      { key: 'visitRef', label: 'visitRef', type: 'INTEGER' },
      { key: 'patientRef', label: 'patientRef', type: 'INTEGER' },
    ])
  })

  it('surfaces truncation from the service', async () => {
    const { fetchImpl } = mockServiceFetch(200, { ...SERVICE_SUCCESS, rowCount: 1, truncated: true })
    __setServiceFetchForTest(fetchImpl)
    const res = await POST(makeReq())
    expect((await res.json()).truncated).toBe(true)
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
    const req = makeReq()
    req.headers.set('x-correlation-id', 'trace-abc-123')
    const res = await POST(req)
    expect(res.status).toBe(200)
    expect(new Headers(calls[0].init.headers).get('x-correlation-id')).toBe('trace-abc-123')
  })
})

// ── the relocated read-only boundary: service kind:"guard" → 422 SCOPE ────────

describe('POST /api/query — write/DDL rejected by the service guard → 422 SCOPE', () => {
  it('maps a service guard envelope (422 kind:"guard") to 422 SCOPE', async () => {
    const { fetchImpl } = mockServiceFetch(422, {
      error: { kind: 'guard', message: 'SQL rejected by the read-only guard.' },
    })
    __setServiceFetchForTest(fetchImpl)
    const res = await POST(makeReq({ body: { sql: 'DELETE FROM mock.public."VisitMock"' } }))
    expect(res.status).toBe(422)
    const json = await res.json()
    expect(json.error.code).toBe('SCOPE')
    expect(json.error.message).not.toMatch(/stack|at Object/i)
  })

  it('writes a QUERY_FAILED audit line for a guard rejection (audit chain keeps guard events)', async () => {
    const { fetchImpl } = mockServiceFetch(422, {
      error: { kind: 'guard', message: 'SQL rejected by the read-only guard.' },
    })
    __setServiceFetchForTest(fetchImpl)
    const before = getRecentAuditEvents(50, 'orgFail').length
    const res = await POST(makeReq({ orgId: 'orgFail', body: { sql: 'DROP TABLE mock.public."VisitMock"' } }))
    expect(res.status).toBe(422)
    const events = getRecentAuditEvents(50, 'orgFail')
    expect(events.length).toBeGreaterThan(before)
    expect(events[0].action).toBe('QUERY_FAILED')
    expect(events[0].orgId).toBe('orgFail')
  })
})

// ── error mapping (non-guard) ─────────────────────────────────────────────────

describe('POST /api/query — service/transport errors → safeError 502 (H20)', () => {
  it('maps a service engine error (502) to a safeError 502 with NO leaked detail', async () => {
    const { fetchImpl } = mockServiceFetch(502, {
      error: { kind: 'engine', message: 'DuckDB Binder Error: no such column secret_internal_detail' },
    })
    __setServiceFetchForTest(fetchImpl)
    const res = await POST(makeReq())
    expect(res.status).toBe(502)
    const json = await res.json()
    expect(json.error.code).toBe('UPSTREAM')
    expect(json.error.message).not.toMatch(/DuckDB|secret_internal_detail|Binder/i)
  })

  it('maps a transport failure to a safeError 502', async () => {
    const fetchImpl = (async () => {
      throw new TypeError('fetch failed')
    }) as unknown as typeof fetch
    __setServiceFetchForTest(fetchImpl)
    const res = await POST(makeReq())
    expect(res.status).toBe(502)
    expect((await res.json()).error.code).toBe('UPSTREAM')
  })
})

// ── catalog/schema allowlist (H22 identifier injection) — stays TS-side ───────

describe('POST /api/query — catalog/schema allowlist (coordination control)', () => {
  it('an unknown database alias falls back to the safe default (not forwarded verbatim)', async () => {
    const { fetchImpl, calls } = mockServiceFetch(200, SERVICE_SUCCESS)
    __setServiceFetchForTest(fetchImpl)
    const res = await POST(
      makeReq({ body: { sql: 'SELECT 1 AS n', database: 'evil; DROP TABLE x', schema: 'public' } })
    )
    expect(res.status).toBe(200)
    // the injected alias is NOT forwarded; the safe default 'mock' is.
    expect(JSON.parse(calls[0].init.body as string).database).toBe('mock')
  })

  it('an unknown schema falls back to the default schema', async () => {
    const { fetchImpl, calls } = mockServiceFetch(200, SERVICE_SUCCESS)
    __setServiceFetchForTest(fetchImpl)
    const res = await POST(makeReq({ body: { sql: 'SELECT 1 AS n', database: 'mock', schema: 'not a schema' } }))
    expect(res.status).toBe(200)
    expect(JSON.parse(calls[0].init.body as string).schema).toBe('public')
  })
})

// ── hardening runs BEFORE any service dispatch ────────────────────────────────

describe('POST /api/query — hardening is preserved and gates before dispatch', () => {
  it('401 when unauthenticated (never calls the service)', async () => {
    const { fetchImpl, calls } = mockServiceFetch(200, SERVICE_SUCCESS)
    __setServiceFetchForTest(fetchImpl)
    const res = await POST(makeReq({ authenticated: false }))
    expect(res.status).toBe(401)
    expect(calls).toHaveLength(0)
  })

  it('401 when the live store shows the caller is NOT a member of the forged org', async () => {
    __setUserResolverForTest((id: string): User => ({
      id,
      email: `${id}@test.local`,
      passwordHash: 'x',
      memberships: [{ orgId: 'some-other-org', role: 'clinician' as const }],
      defaultOrgId: 'some-other-org',
      name: id,
      createdAt: new Date(0).toISOString(),
    }))
    try {
      const res = await POST(makeReq({ orgId: 'orgA' }))
      expect(res.status).toBe(401)
    } finally {
      allOrgsResolver()
    }
  })

  it('400 when the body fails the schema (missing sql), never calls the service', async () => {
    const { fetchImpl, calls } = mockServiceFetch(200, SERVICE_SUCCESS)
    __setServiceFetchForTest(fetchImpl)
    const res = await POST(makeReq({ body: { database: 'mock' } }))
    expect(res.status).toBe(400)
    expect((await res.json()).error.code).toBe('VALIDATION')
    expect(calls).toHaveLength(0)
  })

  it('413 when Content-Length exceeds the body-size cap', async () => {
    const { fetchImpl, calls } = mockServiceFetch(200, SERVICE_SUCCESS)
    __setServiceFetchForTest(fetchImpl)
    const res = await POST(makeReq({ contentLength: 5 * 1024 * 1024 }))
    expect(res.status).toBe(413)
    expect(calls).toHaveLength(0)
  })

  it('429 once the per-user rate limit is exceeded', async () => {
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
})

// ── audit / anomaly post-pipeline (stays TS-side) ─────────────────────────────

describe('POST /api/query — audit events (TS-side hash chain)', () => {
  it('writes the QUERY_RUN audit event on the success path', async () => {
    const { fetchImpl } = mockServiceFetch(200, SERVICE_SUCCESS)
    __setServiceFetchForTest(fetchImpl)
    const before = getRecentAuditEvents(50, 'orgAudit').length
    const res = await POST(makeReq({ orgId: 'orgAudit', body: { sql: `SELECT ${Math.floor(Math.random() * 1e6)} AS n` } }))
    expect(res.status).toBe(200)
    const events = getRecentAuditEvents(50, 'orgAudit')
    expect(events.length).toBeGreaterThan(before)
    expect(events[0].action).toBe('QUERY_RUN')
    expect(events[0].orgId).toBe('orgAudit')
    expect(events[0].rowsAffected).toBe(2)
  })

  it('writes the QUERY_FAILED audit event on the error path', async () => {
    const { fetchImpl } = mockServiceFetch(502, { error: { kind: 'engine', message: 'boom' } })
    __setServiceFetchForTest(fetchImpl)
    const before = getRecentAuditEvents(50, 'orgFail').length
    const res = await POST(makeReq({ orgId: 'orgFail', body: { sql: `SELECT ${Math.floor(Math.random() * 1e6)} AS n` } }))
    expect(res.status).toBe(502)
    const events = getRecentAuditEvents(50, 'orgFail')
    expect(events.length).toBeGreaterThan(before)
    expect(events[0].action).toBe('QUERY_FAILED')
    expect(events[0].orgId).toBe('orgFail')
  })
})
