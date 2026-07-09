import { randomUUID } from 'node:crypto'
import { NextRequest, NextResponse } from 'next/server'
import { sqlCache, tenantCacheKey } from '@/lib/cache'
import { requireAuthWithPermission } from '@/lib/apiAuth'
import { rateLimit } from '@/lib/rateLimiter'
import { enforceBodySize, parseBody, SqlGenerateBodySchema } from '@/lib/validation'
import { ErrorCodes, errorResponse, safeError } from '@/lib/errors'
import {
  generateSqlViaService,
  Nl2sqlServiceError,
  type Nl2sqlGenerateResult,
  type SqlDialect,
} from '@/lib/nl2sqlServiceClient'

/**
 * POST /api/sql-generate — NL→SQL generation, a thin always-python proxy
 * (docs/TS_RUNTIME_RETIREMENT_PLAN.md §4). The in-process TS generation runtime
 * (retriever + prompt assembly + OpenAI client + generateSql) has been RETIRED.
 *
 * ── WHAT THIS ROUTE DOES NOW ──────────────────────────────────────────────────
 * Coordination/compliance only: auth (+permission) → rate-limit → body-size cap →
 * body validation → org-scoped cache lookup → POST to the Python service
 * /nl2sql/generate → cache + return. It owns NO retriever, LLM, engine, or dialect
 * logic; those live in the Python service (ceiba_nl2sql_service / ceiba_nl2sql).
 *
 * ── EGRESS MODEL ──────────────────────────────────────────────────────────────
 * The LLM prompt is assembled INSIDE the service from a PHI-classified artifact
 * bundle (schema/metadata/aggregate descriptors only — no patient rows). The
 * OpenAI egress gate (OPENAI_BAA_SIGNED) is enforced Python-side
 * (ceiba_nl2sql/compliance/egress.py). What the model returns is UNTRUSTED.
 *
 * ── SECURITY BOUNDARY IS DOWNSTREAM (unchanged) ───────────────────────────────
 * The generated SQL is NOT executed here. POST /api/query proxies execution to
 * the service, whose guard_sql is the read-only boundary before DuckDB. This
 * route must not be trusted to have produced safe SQL.
 *
 * ── H10 (client contract) / H11 (dialect) ────────────────────────────────────
 * Returns a JSON body (application/json) matching the historical
 * SqlGenerateResponse shape. `dialect` comes from the service response (or the
 * caller's optional `dialect` override), never a hardcoded value.
 */

/**
 * TEST-ONLY fetch seam for the service call. When set, the service client uses
 * this instead of the global `fetch`, so the route test asserts the exact request
 * shape and maps a mocked response back — fully hermetic (no live service).
 */
let serviceFetchForTest: typeof fetch | null = null

// eslint-disable-next-line no-underscore-dangle
export function __setServiceFetchForTest(fetchImpl: typeof fetch | null): void {
  serviceFetchForTest = fetchImpl
}

/**
 * The dialect the org-scoped cache key is bucketed by when the caller does not
 * override it. The engine is Python-only and defaults to duckdb
 * (ceiba_nl2sql_service settings). The response dialect always reflects what the
 * service actually echoes; this constant only stabilizes the cache key.
 */
const DEFAULT_DIALECT: SqlDialect = 'duckdb'

export async function POST(req: NextRequest) {
  // 1. auth (+permission)
  const { session, error } = await requireAuthWithPermission(req, 'query:run')
  if (error) return error

  // 2. rate limit
  const limited = rateLimit(session, 'sql-generate')
  if (limited) return limited

  // 3. body size
  const sizeErr = enforceBodySize(req)
  if (sizeErr) return sizeErr

  // 4. parse + validate
  const { data, error: parseErr } = await parseBody(req, SqlGenerateBodySchema)
  if (parseErr) return parseErr
  const { userMessage, sourceScope, dialect: dialectOverride } = data

  // Cache-key dialect: the caller's override, else the default bucket. The engine
  // now lives in the service; TS does not build one to ask its dialect.
  const cacheDialect = dialectOverride ?? DEFAULT_DIALECT

  // 5. Tenant-scoped cache key (N4): include session.orgId (via tenantCacheKey) so
  // one org can never read another's cached SQL. Keyed on question + dialect +
  // source scope so differently-targeted requests never collide. The org-scoped
  // cache is a TS coordination concern in front of the service (§4).
  const cacheKey = tenantCacheKey(
    session,
    'sql-generate',
    userMessage,
    cacheDialect,
    (sourceScope ?? []).join(',')
  )
  const cached = sqlCache.get(cacheKey)
  if (cached) {
    return NextResponse.json({
      sql: cached.sql,
      description: cached.description,
      dialect: cacheDialect,
      retrieval: { tables: [], exemplarsUsed: [], cardinalityWarnings: [] },
      cached: true,
    })
  }

  // Correlation id: forwarded to the service so one NL→SQL request traces
  // Next → FastAPI (§7.7). Reuse an inbound id if the caller set one.
  const correlationId = req.headers.get('x-correlation-id') ?? randomUUID()

  // 6. Generate via the Python service (the only runtime).
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

    // Out-of-clinical-scope — the model declined (in-band 200 body error:'scope').
    if (result.error === 'scope') {
      return errorResponse(422, ErrorCodes.SCOPE, 'I can only generate clinical and healthcare SQL.')
    }

    // Cache the (untrusted) SQL for this org; re-guarded by the service on execute.
    sqlCache.set(cacheKey, { sql: result.sql, description: result.description }, 30 * 60 * 1000)

    return NextResponse.json(buildResponse(result, dialectOverride, cacheDialect))
  } catch (e) {
    if (e instanceof Nl2sqlServiceError) {
      // scope / generation are semantic 422s (the request was well-formed but no
      // safe SQL could be produced / it is out of clinical scope).
      if (e.kind === 'scope' || e.kind === 'generation') {
        return errorResponse(
          422,
          ErrorCodes.SCOPE,
          'Could not generate a safe, bounded SQL query for that request. Try rephrasing or narrowing it.'
        )
      }
      // guard/engine/internal/auth/unavailable → generic 502; raw detail logged
      // server-side only (H20), never returned to the client.
      return safeError(e, { context: 'sql-generate', status: 502 })
    }
    return safeError(e, { context: 'sql-generate', status: 502 })
  }
}

/**
 * Map the service's typed result onto the client response body. The additive
 * `usage` block is surfaced for per-query cost visibility; `cached` is false (the
 * service is cache-agnostic — the route owns the org-scoped cache). The response
 * dialect reflects the caller's override when supplied, else what the service
 * echoed (falling back to the cache-key default only if the service omitted it).
 */
function buildResponse(
  result: Nl2sqlGenerateResult,
  dialectOverride: SqlDialect | undefined,
  fallbackDialect: SqlDialect
) {
  return {
    sql: result.sql,
    description: result.description,
    dialect: dialectOverride ?? result.dialect ?? fallbackDialect,
    retrieval: result.retrieval,
    repair: result.repair,
    cached: false,
    error: result.error,
    usage: result.usage,
  }
}
