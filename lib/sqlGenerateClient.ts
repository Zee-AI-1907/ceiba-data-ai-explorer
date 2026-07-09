/**
 * sqlGenerateClient.ts — pure response-parsing helper for the
 * `app/data-explorer/page.tsx` client's call to `POST /api/sql-generate`
 * (GAP #3 remediation, NL2SQL_SPEC.md §5.2, §5.6; H10).
 *
 * WHY THIS EXISTS: the route (`app/api/sql-generate/route.ts`) now ALWAYS
 * returns JSON (never `text/event-stream`) — on success, a `SqlGenerateResponse`
 * (200); on failure, the standard `lib/errors.ts` envelope
 * `{ error: { code, message, correlationId? } }` at the documented status (422
 * SCOPE for out-of-clinical-scope / unrepairable generation, 400/413/429/500/502
 * for the other standard cases). The client used to expect a `text/event-stream`
 * SSE body and, on the JSON branch, only read a nonexistent `json.scopeError`
 * field — so a real 200 JSON success threw "Unexpected response" in the UI (the
 * bug this module fixes) and a real 422 was never actually decoded correctly
 * either (it happened to look for `json.error` as a STRING, but the envelope's
 * `error` is an OBJECT `{code, message}` — `String(json.error)` would have
 * rendered "[object Object]").
 *
 * `interpretSqlGenerateResponse` is factored out as a pure, framework-free
 * function (takes already-parsed JSON + the HTTP status, returns a discriminated
 * result) specifically so this response-handling logic is unit-testable without
 * a DOM/React environment (this repo's vitest config does not set up jsdom yet —
 * see vitest.config.ts's scope note) and without a live fetch.
 */

import type { SqlDialect } from '@/lib/engine/QueryEngine'
import type { ErrorCode } from '@/lib/errors'

/** Mirrors `lib/rag/generate.ts`'s `SqlGenerateResponse` (SPEC §5.2) — duplicated as a
 *  plain client-side type (not imported) so this module never pulls the server-only
 *  `lib/rag/**` module graph (DuckDB bindings, ONNX runtime, etc.) into the client bundle. */
export interface SqlGenerateSuccess {
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
  /** ADDITIVE (Phase 3): per-query LLM cost/token metering, present when the
   *  Python generation runtime served the request. Optional — the TS runtime
   *  does not emit it, so existing callers/tests are unaffected. */
  usage?: {
    model: string
    promptTokens: number
    completionTokens: number
    totalTokens: number
    llmCalls: number
    estimatedCostUsd: number
    latencyMs: number
  }
}

/** Mirrors `lib/errors.ts`'s `ErrorEnvelope` — duplicated as a plain client-side type for the same reason. */
export interface SqlGenerateErrorEnvelope {
  error: {
    code: ErrorCode | string
    message: string
    correlationId?: string
  }
}

export type SqlGenerateInterpretation =
  | { kind: 'success'; response: SqlGenerateSuccess }
  | { kind: 'scope'; message: string }
  | { kind: 'error'; message: string; code?: string }

/**
 * interpretSqlGenerateResponse — classify an already-`await res.json()`-parsed
 * body + its HTTP status into exactly one of: a successful generation, an
 * out-of-clinical-scope decline, or another error. Never throws for a
 * well-formed envelope of either shape; throws only if `body` matches NEITHER
 * the success shape NOR the error-envelope shape (a genuinely unexpected
 * response the caller should surface as a hard failure).
 *
 * `status` drives the scope/error split defensively (422 + `code === 'SCOPE'`
 * is the documented contract, lib/errors.ts), but a malformed/old-format body
 * that merely LOOKS like a scope decline (has a `message` and no `sql`) at any
 * non-2xx status is still treated as an error, never silently swallowed.
 */
export function interpretSqlGenerateResponse(status: number, body: unknown): SqlGenerateInterpretation {
  if (isSqlGenerateSuccess(body)) {
    return { kind: 'success', response: body }
  }

  if (isErrorEnvelope(body)) {
    const { code, message } = body.error
    if (status === 422 && code === 'SCOPE') {
      return { kind: 'scope', message }
    }
    return { kind: 'error', message, code }
  }

  throw new Error(`sql-generate: unexpected response shape (status ${status}): ${safePreview(body)}`)
}

function isSqlGenerateSuccess(body: unknown): body is SqlGenerateSuccess {
  if (typeof body !== 'object' || body === null) return false
  const b = body as Record<string, unknown>
  return typeof b.sql === 'string' && typeof b.dialect === 'string' && typeof b.cached === 'boolean'
}

function isErrorEnvelope(body: unknown): body is SqlGenerateErrorEnvelope {
  if (typeof body !== 'object' || body === null) return false
  const b = body as Record<string, unknown>
  if (typeof b.error !== 'object' || b.error === null) return false
  const err = b.error as Record<string, unknown>
  return typeof err.code === 'string' && typeof err.message === 'string'
}

function safePreview(body: unknown): string {
  try {
    return JSON.stringify(body).slice(0, 200)
  } catch {
    return String(body).slice(0, 200)
  }
}
