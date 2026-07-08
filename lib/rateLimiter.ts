/**
 * rateLimiter.ts — Per-user + route rate limiting (N3 fix, Workstream E).
 *
 * WHY: N3 — nothing was throttled. One authenticated `clinician` could loop
 * `/api/narrative` (PHI→OpenAI each call) or `/api/query` (Trino + O(n) audit
 * rewrite each call) without bound → runaway OpenAI spend, Trino saturation,
 * DoS from a single default-role account. The previous file was login-lockout
 * code with ZERO importers (dead). This rewrite is a general limiter WS-F and
 * WS-H call on their AI/query routes.
 *
 * ── MULTI-INSTANCE WARNING (READ THIS) ───────────────────────────────────────
 * The default store is an in-process Map. On Vercel / any multi-instance
 * deployment each instance has its OWN counters, so the EFFECTIVE limit is
 * (configured limit × instance count) and a client can be load-balanced across
 * buckets. This is acceptable as a first line of defence but is NOT a real
 * global limit. For production, inject a shared store (Redis/Upstash) via
 * `setRateLimitStore()` — the `RateLimitStore` interface below is the seam. The
 * algorithm (fixed window) is store-agnostic, so swapping is a store change only.
 *
 * ── Algorithm ────────────────────────────────────────────────────────────────
 * Fixed-window counter: within a `windowMs` window a key may make up to `limit`
 * requests; the (limit+1)-th is denied with `retryAfter` = seconds until the
 * window rolls over. Simple, cheap, and adequate for cost/DoS protection on
 * expensive routes. (Token-bucket would smooth bursts better but needs the same
 * store seam; fixed-window is chosen for auditability and clarity.)
 *
 * STABLE CONTRACT — WS-F / WS-H import `rateLimit(session, routeName)`.
 */

import type { NextResponse } from 'next/server'
import { ErrorCodes, errorResponse } from '@/lib/errors'
import type { Session } from '@/lib/apiAuth'

// ─── Swappable store seam ────────────────────────────────────────────────────

/** One fixed-window counter. */
export interface WindowRecord {
  /** Requests counted in the current window. */
  count: number
  /** Unix-ms timestamp when the current window ends (and count resets). */
  windowEndsAt: number
}

/**
 * RateLimitStore — the seam to swap in Redis/Upstash for multi-instance.
 * A production adapter would implement these against a shared backend
 * (ideally atomically, e.g. Redis INCR + EXPIRE).
 */
export interface RateLimitStore {
  get(key: string): WindowRecord | undefined
  set(key: string, record: WindowRecord): void
  delete(key: string): void
}

/** Default in-process store. Per-instance only — see the multi-instance warning. */
class InMemoryRateLimitStore implements RateLimitStore {
  private map = new Map<string, WindowRecord>()
  get(key: string): WindowRecord | undefined {
    return this.map.get(key)
  }
  set(key: string, record: WindowRecord): void {
    this.map.set(key, record)
  }
  delete(key: string): void {
    this.map.delete(key)
  }
}

let store: RateLimitStore = new InMemoryRateLimitStore()

/** Swap the backing store (e.g. a Redis adapter) for multi-instance deployments. */
export function setRateLimitStore(next: RateLimitStore): void {
  store = next
}

// ─── Core limiter ────────────────────────────────────────────────────────────

export interface RateLimitOptions {
  /** Max requests allowed per window. */
  limit: number
  /** Window length in milliseconds. */
  windowMs: number
  /** Injected clock, for tests. Defaults to Date.now. */
  now?: () => number
}

export interface RateLimitResult {
  allowed: boolean
  /** Seconds until the caller may retry (present only when `allowed` is false). */
  retryAfter?: number
  /** Requests remaining in the current window (present when allowed). */
  remaining?: number
}

/**
 * checkRateLimit — fixed-window check for an arbitrary key. Counts this request
 * when allowed. Returns `{ allowed, retryAfter?, remaining? }`.
 */
export function checkRateLimit(key: string, opts: RateLimitOptions): RateLimitResult {
  const now = (opts.now ?? Date.now)()
  const existing = store.get(key)

  // No window yet, or the previous window has fully elapsed → start fresh.
  if (!existing || now >= existing.windowEndsAt) {
    store.set(key, { count: 1, windowEndsAt: now + opts.windowMs })
    return { allowed: true, remaining: opts.limit - 1 }
  }

  if (existing.count >= opts.limit) {
    const retryAfter = Math.max(1, Math.ceil((existing.windowEndsAt - now) / 1000))
    return { allowed: false, retryAfter }
  }

  existing.count += 1
  store.set(key, existing)
  return { allowed: true, remaining: opts.limit - existing.count }
}

/** Reset the counter for a key (e.g. tests, or after a privileged action). */
export function resetRateLimit(key: string): void {
  store.delete(key)
}

// ─── Route policy + convenience wrapper ──────────────────────────────────────

/**
 * Per-route default limits. Expensive AI/query routes are throttled tightest.
 * Tune per product needs; keys are logical route names (not URL paths) so WS-F/
 * WS-H pass a stable label.
 */
export const ROUTE_LIMITS: Record<string, RateLimitOptions> = {
  // Trino + O(n) audit-chain rewrite per call.
  query: { limit: 30, windowMs: 60_000 },
  // Each call ships (scrubbed) rows to OpenAI.
  narrative: { limit: 15, windowMs: 60_000 },
  chat: { limit: 20, windowMs: 60_000 },
  'chart-suggest': { limit: 20, windowMs: 60_000 },
  'sql-generate': { limit: 20, windowMs: 60_000 },
}

/** Fallback for any route not listed in ROUTE_LIMITS. */
export const DEFAULT_ROUTE_LIMIT: RateLimitOptions = { limit: 60, windowMs: 60_000 }

/** Build the limiter key: per user, per route (server-derived userId). */
export function rateLimitKey(session: Pick<Session, 'userId'>, routeName: string): string {
  return `rl:${routeName}:${session.userId}`
}

/**
 * rateLimit — convenience guard for a route handler. Checks the per-user+route
 * limit and, when exceeded, returns a 429 NextResponse (standard error envelope,
 * `Retry-After` header set). Returns null when the request may proceed.
 *
 *     const limited = rateLimit(session, 'narrative')
 *     if (limited) return limited
 */
export function rateLimit(
  session: Pick<Session, 'userId'>,
  routeName: string,
  overrides?: Partial<RateLimitOptions>
): NextResponse | null {
  const base = ROUTE_LIMITS[routeName] ?? DEFAULT_ROUTE_LIMIT
  const opts: RateLimitOptions = { ...base, ...overrides }
  const result = checkRateLimit(rateLimitKey(session, routeName), opts)

  if (!result.allowed) {
    return errorResponse(
      429,
      ErrorCodes.RATE_LIMITED,
      'Rate limit exceeded. Please slow down and try again shortly.',
      { headers: { 'Retry-After': String(result.retryAfter ?? 60) } }
    )
  }
  return null
}

// ─── Login-lockout compatibility layer ───────────────────────────────────────
// The original module exposed a login-attempt lockout API. It had no importers,
// but keep an equivalent, clearly-scoped helper set so a future auth-lockout
// caller has a home and does not collide with the generic limiter above.

const LOGIN_MAX_FAILURES = 5
const LOGIN_WINDOW_MS = 10 * 60 * 1000 // 10 minutes
const LOGIN_LOCKOUT_MS = 15 * 60 * 1000 // 15 minutes

interface LoginAttemptRecord {
  failures: number[]
  lockedUntil: number
}

const loginStore = new Map<string, LoginAttemptRecord>()

function getLoginRecord(key: string): LoginAttemptRecord {
  let record = loginStore.get(key)
  if (!record) {
    record = { failures: [], lockedUntil: 0 }
    loginStore.set(key, record)
  }
  return record
}

/** Check whether a login key (e.g. `login:${ip}:${email}`) is allowed to attempt. */
export function checkLoginRateLimit(key: string): { allowed: boolean; retryAfter?: number } {
  const now = Date.now()
  const record = getLoginRecord(key)

  if (record.lockedUntil > now) {
    return { allowed: false, retryAfter: Math.ceil((record.lockedUntil - now) / 1000) }
  }

  record.failures = record.failures.filter((t) => now - t < LOGIN_WINDOW_MS)

  if (record.failures.length >= LOGIN_MAX_FAILURES) {
    record.lockedUntil = now + LOGIN_LOCKOUT_MS
    return { allowed: false, retryAfter: Math.ceil(LOGIN_LOCKOUT_MS / 1000) }
  }

  return { allowed: true }
}

/** Record one failed login attempt for the key. */
export function recordLoginFailure(key: string): void {
  const now = Date.now()
  const record = getLoginRecord(key)
  record.failures = record.failures.filter((t) => now - t < LOGIN_WINDOW_MS)
  record.failures.push(now)
}

/** Clear a login key's failures (call on successful login). */
export function resetLoginLimit(key: string): void {
  loginStore.delete(key)
}
