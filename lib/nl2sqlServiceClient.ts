/**
 * nl2sqlServiceClient.ts — the typed TS client for the Python NL→SQL FastAPI
 * service (docs/PYTHON_NL2SQL_SERVICE_PLAN.md §2, §5 Phase 3).
 *
 * WHY THIS EXISTS: Phase 3 makes the Python generation runtime AVAILABLE behind
 * a flag (NL2SQL_GENERATE_RUNTIME=python). When the flag is 'python', the
 * `app/api/sql-generate/route.ts` route KEEPS all its TS hardening
 * (auth → rate-limit → body-size → validate → cache) and, instead of the
 * in-process `generateSql`, POSTs to `POST /nl2sql/generate` on this service.
 * This module is the ONLY new networking surface: it owns the base URL, the
 * internal Bearer token, the timeout, the correlation-id header, and the
 * error-envelope → typed-result mapping. It NEVER re-implements auth/RBAC/cache
 * (those stay in the route, §1.2).
 *
 * ── Transport / auth (§2.1) ──────────────────────────────────────────────────
 *   • Base URL  from NL2SQL_SERVICE_URL (e.g. http://127.0.0.1:8088).
 *   • Auth      `Authorization: Bearer ${NL2SQL_SERVICE_TOKEN}` — a SERVICE
 *               credential (not a user credential). The user identity/RBAC is
 *               already resolved in TS and passed as trusted-but-scoped data
 *               (tenantId/context) in the body.
 *   • Timeout   NL2SQL_SERVICE_TIMEOUT_MS (default 60s) via AbortController.
 *   • Trace     forwards an `X-Correlation-Id` header so a single NL→SQL request
 *               traces Next → FastAPI → DuckDB (§7.7).
 *
 * ── The response contract (§2.2, additive) ───────────────────────────────────
 * The service's /nl2sql/generate response mirrors `SqlGenerateResponse`
 * (lib/rag/generate.ts) verbatim, PLUS an additive `usage` block (Phase 3
 * per-query cost metering). This module returns that shape unchanged so the
 * route can hand it back to the client with lib/sqlGenerateClient.ts unchanged.
 *
 * ── The error envelope (§2.4) ─────────────────────────────────────────────────
 * On a non-2xx the service returns `{ error: { kind, message, detail? } }`. This
 * module parses it into a typed `Nl2sqlServiceError` carrying the `kind`, so the
 * route maps `kind` deterministically onto lib/errors.ts codes. A transport
 * failure / timeout / non-JSON body becomes a `Nl2sqlServiceError` of kind
 * 'unavailable'. NO raw upstream body is ever surfaced (H20).
 */

import type { SqlDialect } from '@/lib/engine/QueryEngine'

/** The additive per-query cost/token metering block (Phase 3). */
export interface Nl2sqlUsage {
  model: string
  promptTokens: number
  completionTokens: number
  totalTokens: number
  llmCalls: number
  estimatedCostUsd: number
  latencyMs: number
}

/** The /nl2sql/generate success body (mirrors SqlGenerateResponse + usage). */
export interface Nl2sqlGenerateResult {
  sql: string
  description: string
  dialect: SqlDialect
  retrieval: {
    tables: string[]
    exemplarsUsed: string[]
    cardinalityWarnings: string[]
  }
  repair?: { rounds: number; lastError?: string }
  cached: boolean
  error?: 'scope'
  usage?: Nl2sqlUsage
}

/** The service's error-envelope `kind` vocabulary (§2.4) + a transport sentinel. */
export type Nl2sqlServiceErrorKind =
  | 'scope'
  | 'generation'
  | 'guard'
  | 'engine'
  | 'bad_request'
  | 'internal'
  | 'auth'
  | 'unavailable' // transport failure / timeout / non-JSON (client-side sentinel)

/**
 * A typed error from the service call. `kind` is authoritative for the route's
 * status mapping; `message` is safe-to-log but the route decides what (if
 * anything) reaches the client.
 */
export class Nl2sqlServiceError extends Error {
  readonly kind: Nl2sqlServiceErrorKind
  readonly detail?: unknown

  constructor(kind: Nl2sqlServiceErrorKind, message: string, detail?: unknown) {
    super(message)
    this.name = 'Nl2sqlServiceError'
    this.kind = kind
    this.detail = detail
  }
}

/** The request body for POST /nl2sql/generate (§2.2). */
export interface Nl2sqlGenerateRequest {
  question: string
  tenantId?: string
  context?: { userId?: string; activeOrgId?: string; role?: string }
  dialect?: SqlDialect
  sourceScope?: string[]
  options?: {
    maxRepairRounds?: number
    defaultLimit?: number
    tokenBudget?: number
    maxTables?: number
  }
}

export interface Nl2sqlClientConfig {
  baseUrl: string
  token: string
  timeoutMs: number
}

const DEFAULT_TIMEOUT_MS = 60_000

/**
 * resolveNl2sqlClientConfig — read the service client's config from env.
 * Throws (caught by the route → generic 502/500) if the required vars are
 * absent, so a misconfigured 'python' runtime fails loudly rather than posting
 * to `undefined` with no token.
 */
export function resolveNl2sqlClientConfig(): Nl2sqlClientConfig {
  const baseUrl = process.env.NL2SQL_SERVICE_URL
  const token = process.env.NL2SQL_SERVICE_TOKEN
  if (!baseUrl) {
    throw new Nl2sqlServiceError('unavailable', 'NL2SQL_SERVICE_URL is not configured.')
  }
  if (!token) {
    throw new Nl2sqlServiceError('unavailable', 'NL2SQL_SERVICE_TOKEN is not configured.')
  }
  const timeoutRaw = Number(process.env.NL2SQL_SERVICE_TIMEOUT_MS)
  const timeoutMs = Number.isFinite(timeoutRaw) && timeoutRaw > 0 ? timeoutRaw : DEFAULT_TIMEOUT_MS
  return { baseUrl: baseUrl.replace(/\/+$/, ''), token, timeoutMs }
}

interface ServiceErrorEnvelope {
  error: { kind: string; message: string; detail?: unknown }
}

function isServiceErrorEnvelope(body: unknown): body is ServiceErrorEnvelope {
  if (typeof body !== 'object' || body === null) return false
  const err = (body as Record<string, unknown>).error
  if (typeof err !== 'object' || err === null) return false
  const e = err as Record<string, unknown>
  return typeof e.kind === 'string' && typeof e.message === 'string'
}

function coerceErrorKind(kind: string): Nl2sqlServiceErrorKind {
  switch (kind) {
    case 'scope':
    case 'generation':
    case 'guard':
    case 'engine':
    case 'bad_request':
    case 'internal':
    case 'auth':
      return kind
    default:
      return 'internal'
  }
}

/**
 * generateSqlViaService — POST the NL→SQL generation request to the Python
 * service and return the typed success result. Throws `Nl2sqlServiceError` on
 * any error-envelope response, transport failure, timeout, or unexpected body.
 *
 * The `fetchImpl` param is injectable purely so the route test can supply a
 * mocked fetch (no live service) — production passes the global `fetch`.
 */
export async function generateSqlViaService(
  request: Nl2sqlGenerateRequest,
  options: { config?: Nl2sqlClientConfig; correlationId?: string; fetchImpl?: typeof fetch } = {}
): Promise<Nl2sqlGenerateResult> {
  const config = options.config ?? resolveNl2sqlClientConfig()
  const fetchImpl = options.fetchImpl ?? fetch
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), config.timeoutMs)

  let response: Response
  try {
    response = await fetchImpl(`${config.baseUrl}/nl2sql/generate`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${config.token}`,
        ...(options.correlationId ? { 'X-Correlation-Id': options.correlationId } : {}),
      },
      body: JSON.stringify(request),
      signal: controller.signal,
    })
  } catch (e) {
    // Network error / abort (timeout). NEVER surface the raw cause (H20).
    const reason = e instanceof Error && e.name === 'AbortError' ? 'timed out' : 'is unreachable'
    throw new Nl2sqlServiceError('unavailable', `The NL→SQL service ${reason}.`)
  } finally {
    clearTimeout(timer)
  }

  let body: unknown
  try {
    body = await response.json()
  } catch {
    throw new Nl2sqlServiceError('unavailable', 'The NL→SQL service returned a non-JSON response.')
  }

  if (!response.ok) {
    if (isServiceErrorEnvelope(body)) {
      const { kind, message, detail } = body.error
      throw new Nl2sqlServiceError(coerceErrorKind(kind), message, detail)
    }
    throw new Nl2sqlServiceError('unavailable', `The NL→SQL service returned HTTP ${response.status}.`)
  }

  // A 200 body may still carry `error:'scope'` (an in-band decline, NOT an
  // error envelope) — that is a valid success-shaped result the route maps to
  // 422 SCOPE, so it is returned as data, not thrown.
  if (!isGenerateResult(body)) {
    throw new Nl2sqlServiceError('unavailable', 'The NL→SQL service returned an unexpected response shape.')
  }
  return body
}

function isGenerateResult(body: unknown): body is Nl2sqlGenerateResult {
  if (typeof body !== 'object' || body === null) return false
  const b = body as Record<string, unknown>
  return typeof b.sql === 'string' && typeof b.dialect === 'string' && typeof b.cached === 'boolean'
}
