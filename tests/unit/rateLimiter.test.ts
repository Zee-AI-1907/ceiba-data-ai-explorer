/**
 * Unit tests for lib/rateLimiter.ts — the per-user + route limiter (N3).
 *
 * Covers: allows under the limit, blocks over it (429 with Retry-After), and
 * resets when the window elapses. Uses an injected clock (`now`) so the window
 * behaviour is tested deterministically without real timers.
 */
import { describe, expect, it, beforeEach } from 'vitest'
import {
  checkRateLimit,
  resetRateLimit,
  rateLimit,
  rateLimitKey,
  ROUTE_LIMITS,
} from '@/lib/rateLimiter'
import type { Session } from '@/lib/apiAuth'

const session: Session = { userId: 'user-1', orgId: 'org-1', role: 'clinician' }

describe('checkRateLimit', () => {
  let clock = 0
  const now = () => clock
  const KEY = 'rl:test:user-1'

  beforeEach(() => {
    clock = 1_000_000
    resetRateLimit(KEY)
  })

  it('allows requests up to the limit', () => {
    const opts = { limit: 3, windowMs: 60_000, now }
    expect(checkRateLimit(KEY, opts)).toMatchObject({ allowed: true, remaining: 2 })
    expect(checkRateLimit(KEY, opts)).toMatchObject({ allowed: true, remaining: 1 })
    expect(checkRateLimit(KEY, opts)).toMatchObject({ allowed: true, remaining: 0 })
  })

  it('blocks the request over the limit and reports retryAfter', () => {
    const opts = { limit: 2, windowMs: 60_000, now }
    checkRateLimit(KEY, opts)
    checkRateLimit(KEY, opts)
    const blocked = checkRateLimit(KEY, opts)

    expect(blocked.allowed).toBe(false)
    expect(blocked.retryAfter).toBe(60) // full window remains
  })

  it('resets once the window has elapsed', () => {
    const opts = { limit: 1, windowMs: 60_000, now }
    expect(checkRateLimit(KEY, opts).allowed).toBe(true)
    expect(checkRateLimit(KEY, opts).allowed).toBe(false)

    // Advance past the window boundary.
    clock += 60_001
    const afterReset = checkRateLimit(KEY, opts)
    expect(afterReset.allowed).toBe(true)
    expect(afterReset.remaining).toBe(0)
  })

  it('counts down retryAfter as the window drains', () => {
    const opts = { limit: 1, windowMs: 60_000, now }
    checkRateLimit(KEY, opts) // opens window at clock
    clock += 30_000
    const blocked = checkRateLimit(KEY, opts)
    expect(blocked.allowed).toBe(false)
    expect(blocked.retryAfter).toBe(30)
  })
})

describe('rateLimitKey', () => {
  it('is scoped per user and route', () => {
    expect(rateLimitKey(session, 'narrative')).toBe('rl:narrative:user-1')
    expect(rateLimitKey({ userId: 'user-2' }, 'narrative')).toBe('rl:narrative:user-2')
  })
})

describe('rateLimit (convenience wrapper)', () => {
  beforeEach(() => {
    resetRateLimit(rateLimitKey(session, 'unit-test-route'))
  })

  it('returns null while under the limit', () => {
    expect(rateLimit(session, 'unit-test-route', { limit: 2, windowMs: 60_000 })).toBeNull()
    expect(rateLimit(session, 'unit-test-route', { limit: 2, windowMs: 60_000 })).toBeNull()
  })

  it('returns a 429 NextResponse with Retry-After once exceeded', async () => {
    const opts = { limit: 1, windowMs: 60_000 }
    expect(rateLimit(session, 'unit-test-route', opts)).toBeNull()
    const res = rateLimit(session, 'unit-test-route', opts)

    expect(res).not.toBeNull()
    expect(res!.status).toBe(429)
    expect(res!.headers.get('Retry-After')).toBeTruthy()
    const body = await res!.json()
    expect(body.error.code).toBe('RATE_LIMITED')
  })

  it('ships sensible default limits for the expensive AI/query routes', () => {
    expect(ROUTE_LIMITS.query.limit).toBeGreaterThan(0)
    expect(ROUTE_LIMITS.narrative.limit).toBeGreaterThan(0)
    expect(ROUTE_LIMITS['chart-suggest'].limit).toBeGreaterThan(0)
  })
})
