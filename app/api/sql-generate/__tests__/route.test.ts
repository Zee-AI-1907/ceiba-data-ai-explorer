/**
 * route.test.ts — POST /api/sql-generate refactor (NL2SQL_PLAN.md §P5, SPEC §5.6).
 *
 * Asserts the route KEEPS every piece of existing hardening (auth + permission,
 * rate limit, body-size, parseBody) AND returns a proper JSON SqlGenerateResponse
 * whose `dialect` comes from the engine (NOT the hardcoded "PostgreSQL", H11) and
 * whose cache is org-scoped (N4). Fully hermetic: the route's generation
 * dependencies (engine/retriever/llm) are injected as stubs via the test seam
 * `__setGenerationDepsForTest`, so no bundle, no DuckDB, no network, no BAA.
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { NextRequest } from 'next/server'
import type {
  EngineCapabilities,
  PlanOrError,
  QueryEngine,
  SqlDialect,
} from '@/lib/engine/QueryEngine'
import type { HybridRetriever, RetrieveOptions, SchemaContext } from '@/lib/rag/Retriever'
import type { LlmClient } from '@/lib/rag/generate'
import { signSession } from '@/lib/session'
import { resolvedDialect } from '@/lib/engine/provisioning'
import { sqlCache } from '@/lib/cache'
import { resetRateLimit, rateLimitKey } from '@/lib/rateLimiter'
import { __setUserResolverForTest, type User } from '@/lib/authStore'
import {
  POST,
  __setGenerationDepsForTest,
  __setServiceFetchForTest,
  type GenerationDeps,
} from '../route'

// Orgs these tests forge sessions into. requireAuthWithPermission now re-resolves
// the effective role from the live store (multi-org plan §2.3, revocation-safe),
// so a forged synthetic principal must be resolvable with a membership in each
// forged org (role 'clinician', matching every forged session in this file).
const FORGED_ORGS = ['orgA', 'orgB', 'orgP', 'orgX']

beforeAll(() => {
  // requireAuthWithPermission -> verifySession needs a signing secret.
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

// ── stub generation dependencies (no bundle / DuckDB / network) ───────────────

const DUCKDB_CAPS: EngineCapabilities = {
  supportsCrossCatalogJoin: true,
  identifierQuote: '"',
  intervalSyntax: 'ansi',
  supportsExplain: true,
}

/** Minimal QueryEngine stub: duckdb dialect + always-ok explain (no rows). */
function stubEngine(dialect: SqlDialect = 'duckdb'): QueryEngine {
  return {
    attach: async () => {},
    dispose: async () => {},
    execute: async () => ({ columns: [], rows: [], rowCount: 0, truncated: false }),
    explain: async (): Promise<PlanOrError> => ({ ok: true, plan: 'PLAN' }),
    dialect: () => dialect,
    capabilities: () => DUCKDB_CAPS,
    listCatalogs: async () => [],
    listSchemas: async () => [],
    listTables: async () => [],
    describeTable: async () => ({ columns: [], primaryKey: [], foreignKeys: [] }),
  }
}

/** Minimal retriever stub returning an empty (but valid) SchemaContext. */
function stubRetriever(dialect: SqlDialect = 'duckdb'): HybridRetriever {
  const context: SchemaContext = {
    tables: [],
    joinHints: [],
    cardinalityWarnings: [],
    glossaryHits: [],
    exemplars: [],
    tokenEstimate: 0,
    dialect,
  }
  const retriever = {
    load: async () => {},
    retrieve: async (_question: string, _opts: RetrieveOptions) => context,
    dispose: async () => {},
  }
  return retriever as unknown as HybridRetriever
}

/** Stub LLM returning a fixed, guard-passing, bounded read-only SELECT. */
function stubLlm(sql: string): LlmClient {
  return { complete: async () => sql }
}

const GOOD_SQL = `SELECT "patientRef" FROM mock.public."VisitMock" WHERE "admittedAt" >= now() - INTERVAL '1 day' LIMIT 1000`

function installStubDeps(overrides?: Partial<GenerationDeps>): void {
  __setGenerationDepsForTest({
    engine: overrides?.engine ?? stubEngine(),
    retriever: overrides?.retriever ?? stubRetriever(),
    llm: overrides?.llm ?? stubLlm(GOOD_SQL),
  })
}

// ── request builder ────────────────────────────────────────────────────────

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

beforeEach(() => {
  installStubDeps()
  resetRateLimit(rateLimitKey({ userId: 'user-1' }, 'sql-generate'))
  resetRateLimit(rateLimitKey({ userId: 'user-2' }, 'sql-generate'))
})

afterEach(() => {
  __setGenerationDepsForTest(null)
  vi.unstubAllEnvs()
})

describe('POST /api/sql-generate — hardening is preserved', () => {
  it('401 when unauthenticated', async () => {
    const res = await POST(makeReq({ authenticated: false }))
    expect(res.status).toBe(401)
  })

  it('401 when the live store shows the caller is NOT a member of the forged org (membership boundary, not just HMAC)', async () => {
    // Prove the route enforces LIVE membership, not merely a validly-signed
    // cookie: the synthetic user has NO membership in the forged org, so
    // requireAuthWithPermission's re-resolution finds no role → 401.
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

  it('400 when the body fails the schema (missing userMessage)', async () => {
    const res = await POST(makeReq({ body: { notUserMessage: 'x' } }))
    expect(res.status).toBe(400)
    const json = await res.json()
    expect(json.error.code).toBe('VALIDATION')
  })

  it('413 when Content-Length exceeds the body-size cap', async () => {
    const res = await POST(makeReq({ contentLength: 5 * 1024 * 1024 }))
    expect(res.status).toBe(413)
  })

  it('429 once the per-user rate limit is exceeded', async () => {
    // sql-generate limit is 20/min; drain it, then the next call is limited.
    let lastStatus = 0
    for (let i = 0; i < 21; i++) {
      // eslint-disable-next-line no-await-in-loop
      const res = await POST(makeReq())
      lastStatus = res.status
    }
    expect(lastStatus).toBe(429)
  })
})

describe('POST /api/sql-generate — JSON contract (H10) + dialect (H11)', () => {
  it('returns JSON (not event-stream) with a SqlGenerateResponse shape', async () => {
    const res = await POST(makeReq())
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toContain('application/json')
    expect(res.headers.get('content-type')).not.toContain('text/event-stream')

    const json = await res.json()
    expect(typeof json.sql).toBe('string')
    expect(json.sql).toContain('VisitMock')
    expect(json).toHaveProperty('dialect')
    expect(json).toHaveProperty('retrieval')
    expect(json).toHaveProperty('cached')
  })

  it('dialect comes from the engine (duckdb), never the hardcoded "PostgreSQL"', async () => {
    const res = await POST(makeReq())
    const json = await res.json()
    expect(json.dialect).toBe('duckdb')
    expect(json.dialect).not.toBe('PostgreSQL')
    expect(json.dialect).not.toBe('postgres')
  })

  it('default response dialect equals the shared execution dialect (P1: no mismatch)', async () => {
    // /api/query executes on getQueryEngine() (dialect = resolvedDialect()). With no
    // override, /api/sql-generate labels the response with deps.engine.dialect(), and
    // in production deps.engine IS getQueryEngine(). Both therefore agree on 'duckdb'.
    const res = await POST(makeReq())
    const json = await res.json()
    expect(json.dialect).toBe(resolvedDialect())
  })

  it('honors a caller-supplied dialect override in the response', async () => {
    installStubDeps({ engine: stubEngine('duckdb') })
    const res = await POST(makeReq({ body: { userMessage: 'patients admitted yesterday', dialect: 'postgres' } }))
    const json = await res.json()
    expect(json.dialect).toBe('postgres')
  })
})

describe('POST /api/sql-generate — cache is org-scoped (N4)', () => {
  it('a second identical request from the SAME org hits the cache (cached:true)', async () => {
    // Unique message so this test's cache entry never collides with another test.
    const message = `cache-same-org ${Math.random()}`
    const first = await POST(makeReq({ orgId: 'orgA', userId: 'user-1', body: { userMessage: message } }))
    expect((await first.json()).cached).toBe(false)

    // Second identical request — different user, SAME org → cache hit.
    const second = await POST(makeReq({ orgId: 'orgA', userId: 'user-2', body: { userMessage: message } }))
    expect((await second.json()).cached).toBe(true)
  })

  it('a DIFFERENT org never reads the first org’s cached SQL (cached:false)', async () => {
    sqlCache.stats() // touch to ensure module loaded
    const message = `cache-cross-org ${Math.random()}`
    await POST(makeReq({ orgId: 'orgA', userId: 'user-1', body: { userMessage: message } }))
    const otherOrg = await POST(makeReq({ orgId: 'orgB', userId: 'user-2', body: { userMessage: message } }))
    expect((await otherOrg.json()).cached).toBe(false)
  })
})

describe('POST /api/sql-generate — safe errors', () => {
  it('422 SCOPE when generation cannot produce safe SQL (write-only stub, exhausts repair)', async () => {
    installStubDeps({ llm: stubLlm('DELETE FROM mock.public."VisitMock"') })
    // Unique message so a prior test's cached good SQL cannot satisfy this one.
    const res = await POST(makeReq({ body: { userMessage: `write-only ${Math.random()}` } }))
    expect(res.status).toBe(422)
    const json = await res.json()
    expect(json.error.code).toBe('SCOPE')
    // No internal leakage — the message is the safe generic one.
    expect(json.error.message).not.toMatch(/DELETE|stack|at Object/i)
  })

  it('422 SCOPE when the model declines (out-of-clinical-scope sentinel)', async () => {
    installStubDeps({ llm: stubLlm('{"error": "scope"}') })
    const res = await POST(makeReq({ body: { userMessage: 'what is the weather' } }))
    expect(res.status).toBe(422)
    expect((await res.json()).error.code).toBe('SCOPE')
  })
})

// ── Phase 3: NL2SQL_GENERATE_RUNTIME=python cutover (mocked service fetch) ─────
//
// Asserts the flag-on path (a) keeps ALL the TS hardening, (b) sends the correct
// request shape to the Python service (bearer token + correlation id + body),
// (c) maps the service's success response back to the route's JSON contract and
// surfaces the additive `usage` block, and (d) maps the error envelope onto the
// existing status codes via safeError — all with a MOCKED fetch (no live
// service, fully hermetic). The default 'ts' path is covered by every describe
// above; those run with the flag unset.

describe('POST /api/sql-generate — python runtime (NL2SQL_GENERATE_RUNTIME=python)', () => {
  /** A service /nl2sql/generate success body (SqlGenerateResponse + usage). */
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
    vi.stubEnv('NL2SQL_GENERATE_RUNTIME', 'python')
    vi.stubEnv('NL2SQL_SERVICE_URL', 'http://nl2sql.test:8088')
    vi.stubEnv('NL2SQL_SERVICE_TOKEN', 'test-service-token')
  })

  afterEach(() => {
    __setServiceFetchForTest(null)
  })

  it('keeps the auth hardening (401 unauthenticated) before ever calling the service', async () => {
    const { fetchImpl, calls } = mockServiceFetch(200, SERVICE_SUCCESS)
    __setServiceFetchForTest(fetchImpl)
    const res = await POST(makeReq({ authenticated: false }))
    expect(res.status).toBe(401)
    expect(calls).toHaveLength(0) // never reached the service
  })

  it('keeps the body-size hardening (413) before ever calling the service', async () => {
    const { fetchImpl, calls } = mockServiceFetch(200, SERVICE_SUCCESS)
    __setServiceFetchForTest(fetchImpl)
    const res = await POST(makeReq({ contentLength: 5 * 1024 * 1024 }))
    expect(res.status).toBe(413)
    expect(calls).toHaveLength(0)
  })

  it('sends the correct request shape (bearer token, correlation id, tenantId, context) to the service', async () => {
    const { fetchImpl, calls } = mockServiceFetch(200, SERVICE_SUCCESS)
    __setServiceFetchForTest(fetchImpl)
    const res = await POST(
      makeReq({ orgId: 'orgX', userId: 'user-1', role: 'clinician', body: { userMessage: `py-shape ${Math.random()}` } })
    )
    expect(res.status).toBe(200)
    expect(calls).toHaveLength(1)

    const { url, init } = calls[0]
    expect(url).toBe('http://nl2sql.test:8088/nl2sql/generate')
    const headers = new Headers(init.headers)
    expect(headers.get('authorization')).toBe('Bearer test-service-token')
    expect(headers.get('x-correlation-id')).toBeTruthy()

    const sent = JSON.parse(init.body as string)
    expect(sent.question).toContain('py-shape')
    expect(sent.tenantId).toBe('orgX')
    expect(sent.context).toEqual({ userId: 'user-1', activeOrgId: 'orgX', role: 'clinician' })
  })

  it('maps the service success response back to the route JSON contract and surfaces usage', async () => {
    const { fetchImpl } = mockServiceFetch(200, SERVICE_SUCCESS)
    __setServiceFetchForTest(fetchImpl)
    const res = await POST(makeReq({ body: { userMessage: `py-success ${Math.random()}` } }))
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toContain('application/json')

    const json = await res.json()
    expect(json.sql).toContain('VisitMock')
    expect(json.dialect).toBe('duckdb')
    expect(json.retrieval.tables).toContain('mock.public.VisitMock')
    // The additive usage block is surfaced to the caller (per-query cost).
    expect(json.usage).toBeDefined()
    expect(json.usage.model).toBe('gpt-4o-mini')
    expect(json.usage.totalTokens).toBe(368)
    expect(json.usage.llmCalls).toBe(2)
    expect(json.usage.estimatedCostUsd).toBeCloseTo(0.0000768)
  })

  it('honors a caller dialect override on the python path', async () => {
    const { fetchImpl, calls } = mockServiceFetch(200, { ...SERVICE_SUCCESS, dialect: 'duckdb' })
    __setServiceFetchForTest(fetchImpl)
    const res = await POST(
      makeReq({ body: { userMessage: `py-dialect ${Math.random()}`, dialect: 'postgres' } })
    )
    const json = await res.json()
    expect(json.dialect).toBe('postgres')
    // The override is forwarded to the service too.
    expect(JSON.parse(calls[0].init.body as string).dialect).toBe('postgres')
  })

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
    const res = await POST(makeReq({ body: { userMessage: `py-scope ${Math.random()}` } }))
    expect(res.status).toBe(422)
    expect((await res.json()).error.code).toBe('SCOPE')
  })

  it('maps a service "generation" error envelope (422) to 422 SCOPE', async () => {
    const { fetchImpl } = mockServiceFetch(422, {
      error: { kind: 'generation', message: 'repair budget exhausted', detail: { rounds: 2 } },
    })
    __setServiceFetchForTest(fetchImpl)
    const res = await POST(makeReq({ body: { userMessage: `py-gen ${Math.random()}` } }))
    expect(res.status).toBe(422)
    expect((await res.json()).error.code).toBe('SCOPE')
  })

  it('maps a service "engine" error envelope (502) to a safeError 502 with NO leaked detail', async () => {
    const { fetchImpl } = mockServiceFetch(502, {
      error: { kind: 'engine', message: 'DuckDB Binder Error: no such column secret_internal_detail' },
    })
    __setServiceFetchForTest(fetchImpl)
    const res = await POST(makeReq({ body: { userMessage: `py-engine ${Math.random()}` } }))
    expect(res.status).toBe(502)
    const json = await res.json()
    expect(json.error.code).toBe('UPSTREAM')
    // H20: the raw upstream message never reaches the client.
    expect(json.error.message).not.toMatch(/DuckDB|secret_internal_detail|Binder/i)
  })

  it('maps a transport failure to a safeError 502', async () => {
    const fetchImpl = (async () => {
      throw new TypeError('fetch failed')
    }) as unknown as typeof fetch
    __setServiceFetchForTest(fetchImpl)
    const res = await POST(makeReq({ body: { userMessage: `py-transport ${Math.random()}` } }))
    expect(res.status).toBe(502)
    expect((await res.json()).error.code).toBe('UPSTREAM')
  })

  it('a second identical request from the same org still hits the TS cache (cache is runtime-independent)', async () => {
    const { fetchImpl, calls } = mockServiceFetch(200, SERVICE_SUCCESS)
    __setServiceFetchForTest(fetchImpl)
    const message = `py-cache ${Math.random()}`
    const first = await POST(makeReq({ orgId: 'orgP', userId: 'user-1', body: { userMessage: message } }))
    expect((await first.json()).cached).toBe(false)
    const second = await POST(makeReq({ orgId: 'orgP', userId: 'user-2', body: { userMessage: message } }))
    expect((await second.json()).cached).toBe(true)
    // Only the first (cache-miss) request reached the service.
    expect(calls).toHaveLength(1)
  })
})
