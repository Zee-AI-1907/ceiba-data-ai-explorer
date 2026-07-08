// Simple in-memory LRU cache for LLM responses
// Survives across requests in the same Next.js server process
// Key insight: same request (same tenant) = zero LLM tokens spent
//
// N4 (cross-tenant AI cache leak): cache keys MUST be derived with
// `tenantCacheKey(session, ...)` (lib/cacheKey.ts), which prefixes the
// server-verified `session.orgId` and hashes the variable parts with SHA-256.
// The old djb2 `hashKey` had NO tenant component and a forgeable 32-bit space,
// so two tenants issuing the same NL string collided on one entry — Tenant B
// could read Tenant A's PHI-derived AI output, and a cache hit bypassed the LLM
// scope check. `hashKey` is intentionally removed; `tenantCacheKey` is re-exported
// here so route handlers import their cache + key helper from one place.

export { tenantCacheKey } from '@/lib/cacheKey'

type CacheEntry<T> = { value: T; expiresAt: number }

class LRUCache<T> {
  private map = new Map<string, CacheEntry<T>>()
  constructor(private maxSize: number = 500) {}

  get(key: string): T | null {
    const entry = this.map.get(key)
    if (!entry) return null
    if (Date.now() > entry.expiresAt) { this.map.delete(key); return null }
    // Move to end (most recently used)
    this.map.delete(key)
    this.map.set(key, entry)
    return entry.value
  }

  set(key: string, value: T, ttlMs: number): void {
    if (this.map.size >= this.maxSize) {
      // Evict oldest
      const firstKey = this.map.keys().next().value
      if (firstKey !== undefined) {
        this.map.delete(firstKey)
      }
    }
    this.map.set(key, { value, expiresAt: Date.now() + ttlMs })
  }

  stats() {
    return { size: this.map.size, maxSize: this.maxSize }
  }
}

// Singleton caches (persist across requests in same process)
export const sqlCache = new LRUCache<{ sql: string; description: string }>(300)
export const chartCache = new LRUCache<Record<string, unknown>>(500)
