import { randomUUID } from 'node:crypto'
import { NextRequest, NextResponse } from 'next/server'
import { sqlCache, tenantCacheKey } from '@/lib/cache'
import { requireAuthWithPermission } from '@/lib/apiAuth'
import { rateLimit } from '@/lib/rateLimiter'
import { enforceBodySize, parseBody, SqlGenerateBodySchema } from '@/lib/validation'
import { ErrorCodes, errorResponse, safeError } from '@/lib/errors'
import type { QueryEngine, SqlDialect } from '@/lib/engine/QueryEngine'
import { getQueryEngine, resolvedDialect } from '@/lib/engine/provisioning'
import { HybridRetriever } from '@/lib/rag/Retriever'
import { createLocalQueryEmbedder } from '@/lib/rag/queryEmbedder'
import {
  generateSql,
  GenerationError,
  type LlmClient,
  type SqlGenerateResponse,
} from '@/lib/rag/generate'
import {
  generateSqlViaService,
  Nl2sqlServiceError,
  type Nl2sqlGenerateResult,
} from '@/lib/nl2sqlServiceClient'
import { generateRuntime, warnIfRuntimesDiverge } from '@/lib/nl2sqlRuntime'

/**
 * POST /api/sql-generate — NL→SQL generation (NL2SQL_SPEC.md §5, §5.6; §P5).
 *
 * ── EGRESS MODEL (unchanged class, now explicit) ──────────────────────────────
 * This route sends the user's natural-language request + RETRIEVED SCHEMA
 * CONTEXT (table/column names, grains, glossary hits, cardinality warnings, and
 * few-shot NL→SQL exemplars) to the driving LLM. It sends NO patient-row values
 * — the retriever (lib/rag/Retriever.ts) draws from a PHI-classified artifact
 * bundle that holds metadata + aggregate/synthetic descriptors only. So this is
 * the same BAA-safe egress class the route always used; it is NOT behind the
 * OPENAI_BAA_SIGNED row-egress gate. lib/rag/generate.ts routes every LLM call
 * through its `callLlm` choke point so a future row-derived prompt would be
 * gated. What the model returns is UNTRUSTED output.
 *
 * ── SECURITY BOUNDARY IS DOWNSTREAM (unchanged, H25/§8.6) ─────────────────────
 * The generated SQL is NOT executed here. POST /api/query re-parses it through
 * guardSql (single statement, read-only, table/statement allowlist) before any
 * engine runs it. This route MUST NOT be trusted to have produced safe SQL. In
 * generation we additionally guardSql + cardinalityGuard + engine.EXPLAIN the
 * candidate (explain, never execute — no rows egress; SPEC §5.5) as a quality
 * gate + self-repair driver, but the query route remains the boundary.
 *
 * ── H10 (client contract) ─────────────────────────────────────────────────────
 * This route returns a proper JSON `SqlGenerateResponse` (application/json), NOT
 * an event-stream. The legacy client page (app/data-explorer/page.tsx) branches
 * on `content-type: text/event-stream` and, for JSON, only reads `scopeError` /
 * `error`. Its JSON branch already handles a non-stream response, but it does
 * not yet read the new `{ sql, dialect, retrieval, repair, cached }` shape —
 * updating that client to consume this JSON (set the SQL editor from
 * `json.sql`, surface `json.error === 'scope'`) is a follow-up (P-later, out of
 * this phase's scope). Server-side, H10 is addressed: one clean JSON contract,
 * correct content-type, dialect from the engine.
 *
 * ── H11 (dialect) ─────────────────────────────────────────────────────────────
 * `response.dialect` comes from the QueryEngine (engine.dialect(), or the
 * caller's optional `dialect` override), NOT the hardcoded "PostgreSQL" the old
 * prompt used.
 */

/** Env var naming the artifact bundle directory the retriever loads (SPEC §1.1). */
const BUNDLE_DIR_ENV = 'NL2SQL_BUNDLE_DIR'

// ── injectable dependency provider (test seam) ────────────────────────────────

/**
 * The dependencies generateSql needs. Assembled once and memoized (the bundle +
 * DuckDB engine + retriever are expensive to build). A test injects a stub set
 * via `__setGenerationDepsForTest` so the route runs fully hermetically (no
 * network, no live DB, no model download) — see the route test.
 */
export interface GenerationDeps {
  engine: QueryEngine
  retriever: HybridRetriever
  llm: LlmClient
}

let cachedDeps: GenerationDeps | null = null
let cachedDepsPromise: Promise<GenerationDeps> | null = null

/** TEST-ONLY: inject a stub dependency set (bypasses bundle/engine/LLM construction). */
// eslint-disable-next-line no-underscore-dangle
export function __setGenerationDepsForTest(deps: GenerationDeps | null): void {
  cachedDeps = deps
  cachedDepsPromise = null
}

// ── runtime flag: TS (default) vs the Python NL→SQL service ───────────────────

/**
 * The generation runtime flag is resolved by lib/nl2sqlRuntime.ts:
 *   effective = NL2SQL_GENERATE_RUNTIME ?? NL2SQL_RUNTIME (umbrella) ?? 'ts'
 * (docs/PYTHON_NL2SQL_SERVICE_PLAN.md §5 Phase 3, §7.3). DEFAULT is 'ts', so
 * nothing changes unless an operator opts in; rollback is a single env flip.
 * All the TS hardening (auth → rate-limit → body-size → validate → org-scoped
 * cache) runs IDENTICALLY on both paths; only the generation step differs.
 * `warnIfRuntimesDiverge` emits a one-time boot warning if generate and query
 * runtimes disagree (mismatched flags reopen the dialect-mismatch window).
 */

/**
 * TEST-ONLY fetch seam for the Python-runtime path. When set, the service
 * client uses this instead of the global `fetch`, so the route test can assert
 * the exact request shape sent to the service and map a mocked response back —
 * fully hermetic (no live service). Mirrors the `__setGenerationDepsForTest`
 * seam used by the TS path.
 */
let serviceFetchForTest: typeof fetch | null = null

// eslint-disable-next-line no-underscore-dangle
export function __setServiceFetchForTest(fetchImpl: typeof fetch | null): void {
  serviceFetchForTest = fetchImpl
}

/**
 * Map the Python service's typed result onto the route's existing
 * `SqlGenerateResponse` shape (lib/sqlGenerateClient.ts stays UNCHANGED). The
 * additive `usage` block is surfaced through so per-query cost is visible to
 * the caller. `cached` is forced false: the service is cache-agnostic; the TS
 * route owns the org-scoped cache and sets `cached:true` on its own hits.
 */
function mapServiceResultToResponse(result: Nl2sqlGenerateResult): SqlGenerateResponse {
  return {
    sql: result.sql,
    description: result.description,
    dialect: result.dialect,
    retrieval: result.retrieval,
    repair: result.repair,
    cached: false,
    error: result.error,
    usage: result.usage,
  }
}

/**
 * OpenAI-backed LlmClient (the production driving model). Kept minimal: the
 * prompt is the assembled system+user text; the model is asked for SQL only.
 * H20: never forward a raw OpenAI error body — surface a generic upstream error.
 */
function createOpenAiLlmClient(apiKey: string): LlmClient {
  return {
    async complete(prompt: string): Promise<string> {
      const response = await fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          model: 'gpt-4o-mini',
          messages: [{ role: 'user', content: prompt }],
          max_tokens: 600,
          // temperature 0 (deterministic) — kept in sync with the Python
          // OpenAiLlmClient (ceiba_nl2sql/generation/llm.py LLM_TEMPERATURE) so
          // generation behaves identically on both runtimes.
          temperature: 0,
        }),
      })
      if (!response.ok) {
        await response.text().catch(() => '')
        throw new Error(`OpenAI status ${response.status}`)
      }
      const data = await response.json()
      return data.choices?.[0]?.message?.content ?? ''
    },
  }
}

/** Build + memoize the real generation dependencies. Throws if the bundle isn't configured. */
async function getGenerationDeps(): Promise<GenerationDeps> {
  if (cachedDeps) return cachedDeps
  if (cachedDepsPromise) return cachedDepsPromise

  cachedDepsPromise = (async () => {
    const bundleDir = process.env[BUNDLE_DIR_ENV]
    if (!bundleDir) {
      throw new Error(`${BUNDLE_DIR_ENV} is not set; no NL2SQL artifact bundle is configured.`)
    }
    const apiKey = process.env.OPENAI_API_KEY
    if (!apiKey) {
      throw new Error('OPENAI_API_KEY is not set; the driving LLM is not configured.')
    }

    // Use the SHARED runtime engine (lib/engine/provisioning.ts). This is the SAME
    // engine instance /api/query executes against, so the dialect this route
    // EXPLAIN-validates candidate SQL against is IDENTICAL to the dialect execution
    // runs it on (the P1 dialect-mismatch fix — one engine, one dialect, one attach
    // topology). Trino stays swappable behind this seam via NL2SQL_ENGINE.
    const engine = await getQueryEngine()
    // Production query embedding is not wired up yet (vssClient.ts documents the
    // local-only options (a)/(b)); this throwing embedder fails loudly rather
    // than silently returning garbage vectors. A real local embedder replaces it.
    const retriever = new HybridRetriever({
      embedQuery: createLocalQueryEmbedder(),
      dialect: engine.dialect(),
    })
    await retriever.load(bundleDir)

    const deps: GenerationDeps = { engine, retriever, llm: createOpenAiLlmClient(apiKey) }
    cachedDeps = deps
    return deps
  })()

  return cachedDepsPromise
}

export async function POST(req: NextRequest) {
  // 0. Runtime-divergence guard (§7.3): warn ONCE if generate/query runtimes
  //    disagree (a misconfiguration that reopens the dialect-mismatch window).
  warnIfRuntimesDiverge()

  // 1. auth (+permission) — UNCHANGED hardened wrapper.
  const { session, error } = await requireAuthWithPermission(req, 'query:run')
  if (error) return error

  // 2. rate limit — UNCHANGED.
  const limited = rateLimit(session, 'sql-generate')
  if (limited) return limited

  // 3. body size — UNCHANGED.
  const sizeErr = enforceBodySize(req)
  if (sizeErr) return sizeErr

  // 4. parse + validate (schema additively extended with sourceScope/dialect).
  const { data, error: parseErr } = await parseBody(req, SqlGenerateBodySchema)
  if (parseErr) return parseErr
  const { userMessage, sourceScope, dialect: dialectOverride } = data

  const runtime = generateRuntime()

  // The TS path needs the in-process deps to label the response dialect from
  // its engine. The Python path derives the dialect WITHOUT building a local
  // engine (resolvedDialect() — no DSNs required), because the actual engine
  // lives in the service; the override still wins when supplied.
  let deps: GenerationDeps | null = null
  let targetDialect: SqlDialect
  if (runtime === 'ts') {
    try {
      deps = await getGenerationDeps()
    } catch {
      return errorResponse(500, ErrorCodes.INTERNAL, 'AI service is not configured.')
    }
    targetDialect = dialectOverride ?? deps.engine.dialect()
  } else {
    targetDialect = dialectOverride ?? resolvedDialect()
  }

  // Tenant-scoped cache key (N4): include session.orgId (via tenantCacheKey) so
  // one org can never read another's cached SQL. Keyed on the question AND the
  // resolved dialect + source scope so a duckdb vs postgres (H11) request or a
  // scoped request never collides with a differently-targeted one. IDENTICAL on
  // both runtimes — the cache is a TS concern in front of the service (§6).
  const cacheKey = tenantCacheKey(
    session,
    'sql-generate',
    userMessage,
    targetDialect,
    (sourceScope ?? []).join(',')
  )
  const cached = sqlCache.get(cacheKey)
  if (cached) {
    const cachedResponse: SqlGenerateResponse = {
      sql: cached.sql,
      description: cached.description,
      dialect: targetDialect,
      retrieval: { tables: [], exemplarsUsed: [], cardinalityWarnings: [] },
      cached: true,
    }
    return NextResponse.json(cachedResponse)
  }

  if (runtime === 'python') {
    return generateViaPythonService({
      req,
      session,
      userMessage,
      sourceScope,
      dialectOverride,
      targetDialect,
      cacheKey,
    })
  }

  // ── in-process TS runtime (default) — UNCHANGED ─────────────────────────────
  try {
    const result = await generateSql({
      question: userMessage,
      engine: deps!.engine,
      retriever: deps!.retriever,
      llm: deps!.llm,
      dialect: targetDialect,
      options: {
        retrieve: sourceScope ? { sourceScope } : undefined,
      },
    })

    // Out-of-clinical-scope — the model declined (422, unchanged semantics).
    if (result.error === 'scope') {
      return errorResponse(422, ErrorCodes.SCOPE, 'I can only generate clinical and healthcare SQL.')
    }

    // Cache the (untrusted) SQL for this org; re-guarded at /api/query on execute.
    sqlCache.set(cacheKey, { sql: result.sql, description: result.description }, 30 * 60 * 1000)

    return NextResponse.json(result satisfies SqlGenerateResponse)
  } catch (e) {
    if (e instanceof GenerationError) {
      // Well-formed request, but no safe SQL could be produced in the repair
      // budget — a semantic 422, not a server fault. No internal leakage.
      return errorResponse(
        422,
        ErrorCodes.SCOPE,
        'Could not generate a safe, bounded SQL query for that request. Try rephrasing or narrowing it.'
      )
    }
    return safeError(e, { context: 'sql-generate', status: 502 })
  }
}

// ── Python-service generation path (NL2SQL_GENERATE_RUNTIME=python) ───────────

interface PythonPathArgs {
  req: NextRequest
  session: { orgId: string; userId: string; role: string }
  userMessage: string
  sourceScope: string[] | undefined
  dialectOverride: SqlDialect | undefined
  targetDialect: SqlDialect
  cacheKey: string
}

/**
 * generateViaPythonService — the flag-on branch. All hardening + the org-scoped
 * cache already ran in POST; this only performs the service call, maps the
 * error envelope onto lib/errors.ts codes (plan §2.4), and — on success —
 * caches the (untrusted) SQL and surfaces the additive `usage` block.
 *
 * Error mapping (§2.4):
 *   scope / generation  → 422 SCOPE           (semantic decline / repair budget)
 *   guard / engine / internal / auth / unavailable / timeout → 502 (safeError)
 * NO raw service/upstream detail ever reaches the client (H20).
 */
async function generateViaPythonService(args: PythonPathArgs): Promise<NextResponse> {
  const { req, session, userMessage, sourceScope, dialectOverride, targetDialect, cacheKey } = args

  // Correlation id: forwarded to the service so one NL→SQL request traces
  // Next → FastAPI (§7.7). Reuse an inbound id if the caller set one.
  const correlationId = req.headers.get('x-correlation-id') ?? randomUUID()

  try {
    const result = await generateSqlViaService(
      {
        question: userMessage,
        tenantId: session.orgId,
        context: { userId: session.userId, activeOrgId: session.orgId, role: session.role },
        dialect: dialectOverride,
        sourceScope,
        // options omitted → the service applies its own documented defaults.
      },
      { correlationId, fetchImpl: serviceFetchForTest ?? undefined }
    )

    // Out-of-clinical-scope — the model declined (in-band, 200 body error:'scope').
    if (result.error === 'scope') {
      return errorResponse(422, ErrorCodes.SCOPE, 'I can only generate clinical and healthcare SQL.')
    }

    // Cache the (untrusted) SQL for this org; re-guarded at /api/query on execute.
    sqlCache.set(cacheKey, { sql: result.sql, description: result.description }, 30 * 60 * 1000)

    // Ensure the response dialect reflects the request's resolved target even
    // if the service echoed a different default (override wins), and surface
    // the additive usage block for per-query cost visibility.
    const response = mapServiceResultToResponse(result)
    if (dialectOverride) response.dialect = dialectOverride
    else response.dialect = result.dialect ?? targetDialect
    return NextResponse.json(response satisfies SqlGenerateResponse)
  } catch (e) {
    if (e instanceof Nl2sqlServiceError) {
      // scope / generation are semantic 422s (same as the TS GenerationError path).
      if (e.kind === 'scope' || e.kind === 'generation') {
        return errorResponse(
          422,
          ErrorCodes.SCOPE,
          'Could not generate a safe, bounded SQL query for that request. Try rephrasing or narrowing it.'
        )
      }
      // guard/engine/internal/auth/unavailable → generic 502; raw detail logged
      // server-side only (H20), never returned to the client.
      return safeError(e, { context: 'sql-generate:python', status: 502 })
    }
    return safeError(e, { context: 'sql-generate:python', status: 502 })
  }
}
