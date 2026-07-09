/**
 * route.test.ts — POST /api/sql-generate as a thin always-python proxy
 * (docs/TS_RUNTIME_RETIREMENT_PLAN.md §6). The in-process TS generation runtime
 * (retriever + prompt assembly + OpenAI client + generateSql) has been RETIRED;
 * this route now does auth + rate-limit + body caps + validation + the org-scoped
 * cache, then POSTs to the Python service /nl2sql/generate.
 *
 * Fully hermetic: the service call is mocked via __setServiceFetchForTest (no live
 * FastAPI, no bundle, no DuckDB, no OpenAI, no network).
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { NextRequest } from 'next/server'
import { signSession } from '@/lib/session'
import { resetRateLimit, rateLimitKey } from '@/lib/rateLimiter'
import { __setUserResolverForTest, type User } from '@/lib/authStore'
import { POST, __setServiceFetchForTest } from '../route'

// Orgs these tests forge sessions into. requireAuthWithPermission re-resolves the
// effective role from the live store (multi-org plan §2.3), so a forged principal
// must be resolvable with a membership in each forged org (role 'clinician').
const FORGED_ORGS = ['orgA', 'orgB', 'orgP', 'orgX']

beforeAll(() => {
  process.env.SESSION_SECRET = process.env.SESSION_SECRET ?? 'test-session-secret-0123456789'
  __setUserResolverForTest((id: string): User => ({
    id,
    email: `${id}@test.local`,
    passwordHash: 'x',
    memberships: FORGED_ORGS.map((orgId) => ({ orgId, role: 'clinician' as const })),
    defaultOrgId: FORGED_ORGS[0],
    name: id,
    createdAt: new Date(0).toISOString(),
  }))
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
    body = { userMessage: 'patients admitted yesterday' },
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

  return new Request('http://localhost/api/sql-generate', {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  }) as unknown as NextRequest
}

/** A service /nl2sql/generate success body (mirrors SqlGenerateResponse + usage). */
const SERVICE_SUCCESS = {
  sql: `SELECT "patientRef" FROM mock.public."VisitMock" LIMIT 1000`,
  description: 'patients admitted yesterday',
  dialect: 'duckdb',
  retrieval: {
    tables: ['mock.public.VisitMock'],
    exemplarsUsed: ['ex_admitted'],
    cardinalityWarnings: ['VisitMock is large'],
  },
  cached: false,
  usage: {
    model: 'gpt-4o-mini',
    promptTokens: 320,
    completionTokens: 48,
    totalTokens: 368,
    llmCalls: 2,
    estimatedCostUsd: 0.0000768,
    latencyMs: 512,
  },
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
  resetRateLimit(rateLimitKey({ userId: 'user-1' }, 'sql-generate'))
  resetRateLimit(rateLimitKey({ userId: 'user-2' }, 'sql-generate'))
  vi.stubEnv('NL2SQL_SERVICE_URL', 'http://nl2sql.test:8088')
  vi.stubEnv('NL2SQL_SERVICE_TOKEN', 'test-service-token')
})

afterEach(() => {
  __setServiceFetchForTest(null)
  vi.unstubAllEnvs()
})

// ── hardening runs BEFORE any service dispatch ────────────────────────────────

describe('POST /api/sql-generate — hardening is preserved and gates before dispatch', () => {
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
  })

  it('400 when the body fails the schema (missing userMessage), never calls the service', async () => {
    const { fetchImpl, calls } = mockServiceFetch(200, SERVICE_SUCCESS)
    __setServiceFetchForTest(fetchImpl)
    const res = await POST(makeReq({ body: {} }))
    expect(res.status).toBe(400)
    expect(calls).toHaveLength(0)
  })

  it('413 when Content-Length exceeds the body-size cap', async () => {
    const { fetchImpl, calls } = mockServiceFetch(200, SERVICE_SUCCESS)
    __setServiceFetchForTest(fetchImpl)
    const res = await POST(makeReq({ contentLength: 5 * 1024 * 1024 }))
    expect(res.status).toBe(413)
    expect(calls).toHaveLength(0)
  })
})

// ── proxy request + JSON contract (H10) + dialect (H11) ───────────────────────

describe('POST /api/sql-generate — proxies generation to the Python service', () => {
  it('sends the correct request shape (bearer, correlation id, tenantId, context)', async () => {
    const { fetchImpl, calls } = mockServiceFetch(200, SERVICE_SUCCESS)
    __setServiceFetchForTest(fetchImpl)
    const res = await POST(
      makeReq({ orgId: 'orgX', userId: 'user-1', role: 'clinician', body: { userMessage: `shape ${Math.random()}` } })
    )
    expect(res.status).toBe(200)
    expect(calls).toHaveLength(1)

    const { url, init } = calls[0]
    expect(url).toBe('http://nl2sql.test:8088/nl2sql/generate')
    const headers = new Headers(init.headers)
    expect(headers.get('authorization')).toBe('Bearer test-service-token')
    expect(headers.get('x-correlation-id')).toBeTruthy()

    const sent = JSON.parse(init.body as string)
    expect(sent.question).toContain('shape')
    expect(sent.tenantId).toBe('orgX')
    expect(sent.context).toEqual({ userId: 'user-1', activeOrgId: 'orgX', role: 'clinician' })
  })

  it('maps the service success response to the JSON contract and surfaces usage', async () => {
    const { fetchImpl } = mockServiceFetch(200, SERVICE_SUCCESS)
    __setServiceFetchForTest(fetchImpl)
    const res = await POST(makeReq({ body: { userMessage: `success ${Math.random()}` } }))
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toContain('application/json')

    const json = await res.json()
    expect(json.sql).toContain('VisitMock')
    expect(json.dialect).toBe('duckdb')
    expect(json.cached).toBe(false)
    expect(json.retrieval.tables).toContain('mock.public.VisitMock')
    expect(json.usage).toBeDefined()
    expect(json.usage.model).toBe('gpt-4o-mini')
    expect(json.usage.totalTokens).toBe(368)
    expect(json.usage.llmCalls).toBe(2)
    expect(json.usage.estimatedCostUsd).toBeCloseTo(0.0000768)
  })

  it('honors a caller dialect override (and forwards it to the service)', async () => {
    const { fetchImpl, calls } = mockServiceFetch(200, { ...SERVICE_SUCCESS, dialect: 'duckdb' })
    __setServiceFetchForTest(fetchImpl)
    const res = await POST(makeReq({ body: { userMessage: `dialect ${Math.random()}`, dialect: 'postgres' } }))
    const json = await res.json()
    expect(json.dialect).toBe('postgres')
    expect(JSON.parse(calls[0].init.body as string).dialect).toBe('postgres')
  })
})

// ── scope / error mapping ─────────────────────────────────────────────────────

describe('POST /api/sql-generate — scope + error mapping', () => {
  it('maps a service scope decline (200 body error:scope) to 422 SCOPE', async () => {
    const { fetchImpl } = mockServiceFetch(200, {
      sql: '',
      description: '',
      dialect: 'duckdb',
      retrieval: { tables: [], exemplarsUsed: [], cardinalityWarnings: [] },
      cached: false,
      error: 'scope',
    })
    __setServiceFetchForTest(fetchImpl)
    const res = await POST(makeReq({ body: { userMessage: `scope ${Math.random()}` } }))
    expect(res.status).toBe(422)
    expect((await res.json()).error.code).toBe('SCOPE')
  })

  it('maps a service "generation" error envelope (422) to 422 SCOPE', async () => {
    const { fetchImpl } = mockServiceFetch(422, {
      error: { kind: 'generation', message: 'repair budget exhausted', detail: { rounds: 2 } },
    })
    __setServiceFetchForTest(fetchImpl)
    const res = await POST(makeReq({ body: { userMessage: `gen ${Math.random()}` } }))
    expect(res.status).toBe(422)
    expect((await res.json()).error.code).toBe('SCOPE')
  })

  it('maps a service "engine" error envelope (502) to a safeError 502 with NO leaked detail', async () => {
    const { fetchImpl } = mockServiceFetch(502, {
      error: { kind: 'engine', message: 'DuckDB Binder Error: no such column secret_internal_detail' },
    })
    __setServiceFetchForTest(fetchImpl)
    const res = await POST(makeReq({ body: { userMessage: `engine ${Math.random()}` } }))
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
    const res = await POST(makeReq({ body: { userMessage: `transport ${Math.random()}` } }))
    expect(res.status).toBe(502)
    expect((await res.json()).error.code).toBe('UPSTREAM')
  })
})

// ── org-scoped cache (N4) ─────────────────────────────────────────────────────

describe('POST /api/sql-generate — cache is org-scoped and runtime-independent', () => {
  it('a second identical request from the same org hits the cache (only first reaches the service)', async () => {
    const { fetchImpl, calls } = mockServiceFetch(200, SERVICE_SUCCESS)
    __setServiceFetchForTest(fetchImpl)
    const message = `cache ${Math.random()}`
    const first = await POST(makeReq({ orgId: 'orgP', userId: 'user-1', body: { userMessage: message } }))
    expect((await first.json()).cached).toBe(false)
    const second = await POST(makeReq({ orgId: 'orgP', userId: 'user-2', body: { userMessage: message } }))
    expect((await second.json()).cached).toBe(true)
    expect(calls).toHaveLength(1)
  })

  it('a different org does NOT read another org\'s cached SQL', async () => {
    const { fetchImpl, calls } = mockServiceFetch(200, SERVICE_SUCCESS)
    __setServiceFetchForTest(fetchImpl)
    const message = `cross-org ${Math.random()}`
    await POST(makeReq({ orgId: 'orgA', body: { userMessage: message } }))
    await POST(makeReq({ orgId: 'orgB', body: { userMessage: message } }))
    // both orgs missed their own bucket → two service calls
    expect(calls).toHaveLength(2)
  })
})
