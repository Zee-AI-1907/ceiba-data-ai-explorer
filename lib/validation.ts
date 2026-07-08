/**
 * validation.ts — Request-body validation, body-size guard, pagination (WS-E).
 *
 * WHY:
 *   • N5 — routes called `req.json()` (and, in chart-suggest, `columns.map(...)`)
 *     with no try/catch and no shape check. Malformed JSON or a missing field
 *     threw to Next's default handler → generic 500, no audit, partial work done.
 *     `parseBody` wraps parse + zod validation uniformly → 400 on any bad input,
 *     with a SAFE message (never zod internals / stack).
 *   • §6a — no POST route capped request body size → large-body CPU/memory DoS
 *     (compounded by no rate limit). `enforceBodySize` rejects over-cap requests
 *     with 413 before the body is read.
 *   • §6a / H22 — list endpoints had no pagination and `limit` reached Trino
 *     unclamped. `parsePagination` / `clampLimit` give a hard-max, safe parse.
 *
 * STABLE CONTRACT — WS-F (SQL) and WS-H (AI egress) import from here.
 *
 * HOW WS-F / WS-H WIRE IT IN (they own the routes; this is the pattern):
 *
 *     import { parseBody, QueryBodySchema } from '@/lib/validation'
 *
 *     export async function POST(req: NextRequest) {
 *       const { session, error: authErr } = await requireAuth(req)
 *       if (authErr) return authErr
 *
 *       const sizeErr = enforceBodySize(req)          // 413 if too large
 *       if (sizeErr) return sizeErr
 *
 *       const { data, error } = await parseBody(req, QueryBodySchema)
 *       if (error) return error                        // 400, safe message
 *       // `data` is fully typed and validated from here on
 *     }
 */

import type { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { ErrorCodes, errorResponse } from '@/lib/errors'

// ─── Body-size guard (§6a) ────────────────────────────────────────────────────

/** Default max request body size: 1 MB. */
export const DEFAULT_MAX_BODY_BYTES = 1024 * 1024

/**
 * enforceBodySize — reject a request whose declared Content-Length exceeds the
 * cap, BEFORE the body is read. Returns a 413 NextResponse to return, or null
 * when the request is within the cap (or sent no Content-Length).
 *
 * NOTE: a client can omit / lie about Content-Length; this is a cheap first line
 * of defence against the honest large-body case. A hard streaming cap belongs at
 * the platform edge (documented for infra). `parseBody` is the real shape guard.
 */
export function enforceBodySize(
  req: NextRequest | Request,
  maxBytes: number = DEFAULT_MAX_BODY_BYTES
): NextResponse | null {
  const header = req.headers.get('content-length')
  if (!header) return null
  const declared = Number(header)
  if (!Number.isFinite(declared)) return null
  if (declared > maxBytes) {
    return errorResponse(
      413,
      ErrorCodes.PAYLOAD_TOO_LARGE,
      `Request body exceeds the ${Math.floor(maxBytes / 1024)} KB limit.`
    )
  }
  return null
}

// ─── Body parse + validate (N5) ───────────────────────────────────────────────

export type ParseSuccess<T> = { data: T; error: null }
export type ParseFailure = { data: null; error: NextResponse }
export type ParseResult<T> = ParseSuccess<T> | ParseFailure

/**
 * parseBody — parse a JSON request body and validate it against a zod schema.
 *
 * - Malformed / non-JSON body            → 400 VALIDATION ("Malformed JSON body.")
 * - Body fails the schema                → 400 VALIDATION (safe, generic message;
 *                                          field paths are included but NO zod
 *                                          internals, stack, or received values)
 * - Valid                                → `{ data: <typed>, error: null }`
 *
 * CHECK `error` FIRST (mirrors the lib/apiAuth.ts contract).
 */
export async function parseBody<T>(
  req: NextRequest | Request,
  schema: z.ZodType<T>
): Promise<ParseResult<T>> {
  let raw: unknown
  try {
    raw = await req.json()
  } catch {
    return {
      data: null,
      error: errorResponse(400, ErrorCodes.VALIDATION, 'Malformed JSON body.'),
    }
  }

  const result = schema.safeParse(raw)
  if (!result.success) {
    return {
      data: null,
      error: errorResponse(400, ErrorCodes.VALIDATION, summarizeIssues(result.error)),
    }
  }

  return { data: result.data, error: null }
}

/**
 * Build a SAFE, human-readable message from zod issues: field paths + rule only.
 * Never leaks received values (which could be PHI) or internal schema detail.
 */
function summarizeIssues(error: z.ZodError): string {
  const parts = error.issues.slice(0, 5).map((issue) => {
    const path = issue.path.length ? issue.path.join('.') : '(body)'
    return `${path}: ${issue.message}`
  })
  const more = error.issues.length > parts.length ? ` (+${error.issues.length - parts.length} more)` : ''
  return `Invalid request body — ${parts.join('; ')}${more}`
}

// ─── Pagination helpers (§6a / H22) ─────────────────────────────────────────────

/** Hard maximum number of rows any list endpoint / query may return. */
export const MAX_PAGE_LIMIT = 1000
/** Default page size when the caller does not specify one. */
export const DEFAULT_PAGE_LIMIT = 100

/**
 * clampLimit — coerce an arbitrary (possibly client-supplied) limit into a safe
 * integer within [1, max]. Non-numeric / missing → `fallback`. This is the H22
 * clamp used both for pagination and for the Trino `limit` param.
 */
export function clampLimit(
  value: unknown,
  { max = MAX_PAGE_LIMIT, fallback = DEFAULT_PAGE_LIMIT }: { max?: number; fallback?: number } = {}
): number {
  const n = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(n)) return fallback
  const int = Math.floor(n)
  if (int < 1) return 1
  if (int > max) return max
  return int
}

export interface Pagination {
  limit: number
  cursor: string | null
}

/**
 * parsePagination — read `limit` and `cursor` from a URL's search params for a
 * GET list endpoint, applying the hard max. Documented for WS-F/WS-H list routes.
 */
export function parsePagination(
  url: URL | string,
  { max = MAX_PAGE_LIMIT, defaultLimit = DEFAULT_PAGE_LIMIT }: { max?: number; defaultLimit?: number } = {}
): Pagination {
  const params = typeof url === 'string' ? new URL(url).searchParams : url.searchParams
  const limit = clampLimit(params.get('limit'), { max, fallback: defaultLimit })
  const cursorRaw = params.get('cursor')
  const cursor = cursorRaw && cursorRaw.length > 0 && cursorRaw.length <= 512 ? cursorRaw : null
  return { limit, cursor }
}

// ─── Shared request schemas (derived from the routes' current shapes) ────────────
// These match EXACTLY what each route destructures today (see the route files).
// WS-F/WS-H import these into their handlers via `parseBody(req, <Schema>)`.

/** Column descriptor as used by narrative/chart-suggest routes. */
export const ColumnSchema = z.object({
  key: z.string(),
  label: z.string(),
  type: z.string().optional(),
})

/** A data row is an open record of unknown-typed cells. */
export const RowSchema = z.record(z.string(), z.unknown())

/**
 * QueryBodySchema — POST /api/query (WS-F).
 * Route destructures `{ sql, database, schema, limit }`.
 * `database`/`schema` are optional; `limit` is optional and clamped downstream
 * (H22). `sql` must be a non-empty string.
 */
export const QueryBodySchema = z.object({
  sql: z.string().min(1, 'SQL is required'),
  database: z.string().optional(),
  schema: z.string().optional(),
  limit: z.number().int().positive().optional(),
})
export type QueryBody = z.infer<typeof QueryBodySchema>

/**
 * ChatBodySchema — POST /api/chat (WS-H).
 * Route destructures `{ message, context }`. `context` is an optional summary.
 */
export const ChatBodySchema = z.object({
  message: z.string().min(1, 'message is required').max(8000),
  context: z.string().max(20000).optional(),
})
export type ChatBody = z.infer<typeof ChatBodySchema>

/**
 * NarrativeBodySchema — POST /api/narrative (WS-H).
 * Route destructures `{ columns, rows, question }` and requires non-empty rows.
 */
export const NarrativeBodySchema = z.object({
  columns: z.array(ColumnSchema).min(1, 'at least one column is required'),
  rows: z.array(RowSchema).min(1, 'at least one row is required'),
  question: z.string().max(4000).optional(),
})
export type NarrativeBody = z.infer<typeof NarrativeBodySchema>

/**
 * ChartSuggestBodySchema — POST /api/chart-suggest (WS-H).
 * Route destructures `{ columns, rows, userMessage }` then calls `columns.map`
 * BEFORE its try block (the N5 crash) — this schema makes columns non-optional.
 */
export const ChartSuggestBodySchema = z.object({
  columns: z.array(ColumnSchema).min(1, 'at least one column is required'),
  rows: z.array(RowSchema),
  userMessage: z.string().min(1, 'userMessage is required').max(4000),
})
export type ChartSuggestBody = z.infer<typeof ChartSuggestBodySchema>

/**
 * SqlGenerateBodySchema — POST /api/sql-generate (WS-H).
 * Route destructures `{ userMessage, schemaHint }`.
 */
export const SqlGenerateBodySchema = z.object({
  userMessage: z.string().min(1, 'userMessage is required').max(4000),
  schemaHint: z.string().max(4000).optional(),
})
export type SqlGenerateBody = z.infer<typeof SqlGenerateBodySchema>
