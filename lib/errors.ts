/**
 * errors.ts — Standard error envelope + safe error handling (Workstream E).
 *
 * WHY: Fixes H20 (routes leaked Trino/OpenAI internals via `String(e)`), and the
 * §6a finding that AI/query routes returned inconsistent error shapes and status
 * codes, forcing clients to special-case each route.
 *
 * ── The envelope (STABLE CONTRACT — WS-F and WS-H code against this) ──────────
 * Every error response has EXACTLY this JSON body:
 *
 *     { "error": { "code": ErrorCode, "message": string, "correlationId"?: string } }
 *
 * `code` is a stable machine-readable string (see ErrorCode); clients switch on
 * it, not on the human message. `message` is ALWAYS safe to show a client — it
 * never contains upstream/internal detail. `correlationId` is present only on
 * 5xx responses produced by `safeError`, so a client/support can quote it and an
 * operator can grep the server logs for the full stack.
 *
 * ── Standard status-code convention (WS-F / WS-H MUST follow) ─────────────────
 *   400  VALIDATION      malformed JSON or a request body/params that fail schema
 *   401  UNAUTHENTICATED no / invalid session          (produced by lib/apiAuth.ts)
 *   403  FORBIDDEN       authenticated but lacks the permission (lib/apiAuth.ts)
 *   404  NOT_FOUND       resource does not exist (or not visible to this tenant)
 *   413  PAYLOAD_TOO_LARGE request body exceeded the size cap (see validation.ts)
 *   422  SCOPE           semantically rejected (e.g. AI out-of-clinical-scope,
 *                        SQL rejected by the guard) — request was well-formed
 *   429  RATE_LIMITED    per-user+route throttle exceeded (lib/rateLimiter.ts)
 *   500  INTERNAL        unexpected server-side failure — details logged, hidden
 *   502  UPSTREAM        a downstream dependency (Trino / OpenAI) failed or errored
 *
 * NOTE ON AUTH: lib/apiAuth.ts predates this module and returns its own 401/403
 * bodies (`{ error: 'Unauthorized' }` / `{ error: 'Forbidden', ... }`). Those are
 * a STABLE contract that routes already depend on, so this module does NOT change
 * them. Use `errorResponse`/`safeError` for every OTHER status you produce.
 */

import { NextResponse } from 'next/server'
import { randomUUID } from 'node:crypto'

/** Machine-readable, stable error codes. Clients switch on these. */
export const ErrorCodes = {
  VALIDATION: 'VALIDATION',
  UNAUTHENTICATED: 'UNAUTHENTICATED',
  FORBIDDEN: 'FORBIDDEN',
  NOT_FOUND: 'NOT_FOUND',
  PAYLOAD_TOO_LARGE: 'PAYLOAD_TOO_LARGE',
  SCOPE: 'SCOPE',
  RATE_LIMITED: 'RATE_LIMITED',
  INTERNAL: 'INTERNAL',
  UPSTREAM: 'UPSTREAM',
} as const

export type ErrorCode = (typeof ErrorCodes)[keyof typeof ErrorCodes]

/** The exact JSON body shape of every error response. */
export interface ErrorEnvelope {
  error: {
    code: ErrorCode
    message: string
    /** Present only on 5xx responses from `safeError`, to correlate with logs. */
    correlationId?: string
  }
}

/**
 * errorResponse — build a standard error envelope NextResponse.
 *
 * Use for any client-caused error (4xx) where the message is already safe to
 * expose. For 5xx / caught exceptions use `safeError` instead so internals are
 * scrubbed and a correlation id is attached.
 */
export function errorResponse(
  status: number,
  code: ErrorCode,
  message: string,
  extra?: { correlationId?: string; headers?: Record<string, string> }
): NextResponse<ErrorEnvelope> {
  const body: ErrorEnvelope = {
    error: {
      code,
      message,
      ...(extra?.correlationId ? { correlationId: extra.correlationId } : {}),
    },
  }
  return NextResponse.json(body, { status, headers: extra?.headers })
}

/**
 * safeError — log full detail server-side under a correlation id, return a
 * GENERIC client envelope. This is the H20 fix: NO Trino/OpenAI/stack detail
 * ever reaches the client.
 *
 * @param e         the caught error (any thrown value)
 * @param opts.context   short label for the log line (e.g. 'query', 'narrative')
 * @param opts.status    502 for a failed upstream dependency, else 500 (default)
 * @param opts.code      overrides the error code (defaults from status)
 * @param opts.message   overrides the generic client message
 * @returns a NextResponse carrying `{ error: { code, message, correlationId } }`
 *
 * The returned `correlationId` is logged alongside the full error so support can
 * cross-reference a client-reported id with the server log.
 */
export function safeError(
  e: unknown,
  opts?: {
    context?: string
    status?: 500 | 502
    code?: ErrorCode
    message?: string
  }
): NextResponse<ErrorEnvelope> {
  const status = opts?.status ?? 500
  const code = opts?.code ?? (status === 502 ? ErrorCodes.UPSTREAM : ErrorCodes.INTERNAL)
  const correlationId = randomUUID()

  const clientMessage =
    opts?.message ??
    (status === 502
      ? 'An upstream service failed to respond. Please try again.'
      : 'An unexpected error occurred. Please try again.')

  // Full detail server-side ONLY. Never returned to the client.
  const detail = e instanceof Error ? (e.stack ?? e.message) : String(e)
  console.error(
    `[error] correlationId=${correlationId} context=${opts?.context ?? 'unknown'} code=${code} status=${status} :: ${detail}`
  )

  return errorResponse(status, code, clientMessage, { correlationId })
}
