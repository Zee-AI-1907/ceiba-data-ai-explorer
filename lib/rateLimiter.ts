/**
 * rateLimiter.ts — In-memory rate limiter for login attempts (O-003, H-006).
 *
 * Tracks failed login attempts per composite key (typically `login:${ip}:${email}`).
 * Locks out after MAX_FAILURES within WINDOW_MS; lockout lasts LOCKOUT_MS.
 *
 * No Redis required for MVP — state lives in the Node.js process.
 * NOTE: In multi-replica deployments, replace with a Redis-backed store.
 */

const MAX_FAILURES = 5
const WINDOW_MS = 10 * 60 * 1000   // 10 minutes
const LOCKOUT_MS = 15 * 60 * 1000  // 15 minutes

interface AttemptRecord {
  /** Timestamps (ms) of recent failures within the window. */
  failures: number[]
  /** Unix-ms timestamp when the lockout expires (0 = not locked). */
  lockedUntil: number
}

const store = new Map<string, AttemptRecord>()

function getRecord(key: string): AttemptRecord {
  let record = store.get(key)
  if (!record) {
    record = { failures: [], lockedUntil: 0 }
    store.set(key, record)
  }
  return record
}

/**
 * Check whether a key is currently allowed to attempt login.
 * Returns { allowed: true } when the attempt can proceed,
 * or { allowed: false, retryAfter: <seconds> } when locked out.
 */
export function checkRateLimit(key: string): { allowed: boolean; retryAfter?: number } {
  const now = Date.now()
  const record = getRecord(key)

  // Active lockout?
  if (record.lockedUntil > now) {
    const retryAfter = Math.ceil((record.lockedUntil - now) / 1000)
    return { allowed: false, retryAfter }
  }

  // Expire old failures outside the sliding window
  record.failures = record.failures.filter((t) => now - t < WINDOW_MS)

  if (record.failures.length >= MAX_FAILURES) {
    // Threshold just hit — impose lockout
    record.lockedUntil = now + LOCKOUT_MS
    const retryAfter = Math.ceil(LOCKOUT_MS / 1000)
    return { allowed: false, retryAfter }
  }

  return { allowed: true }
}

/**
 * Record one failed login attempt for the given key.
 */
export function recordFailure(key: string): void {
  const now = Date.now()
  const record = getRecord(key)
  // Expire stale entries first
  record.failures = record.failures.filter((t) => now - t < WINDOW_MS)
  record.failures.push(now)
}

/**
 * Reset the failure counter for the given key (call on successful login).
 */
export function resetLimit(key: string): void {
  store.delete(key)
}
