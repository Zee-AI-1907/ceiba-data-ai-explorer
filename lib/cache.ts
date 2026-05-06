// Simple in-memory LRU cache for LLM responses
// Survives across requests in the same Next.js server process
// Key insight: same SQL request = zero LLM tokens spent

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

export function hashKey(...parts: string[]): string {
  // Simple djb2-style hash — no crypto needed for cache keys
  let h = 5381
  const str = parts.join('|')
  for (let i = 0; i < str.length; i++) {
    h = ((h << 5) + h) ^ str.charCodeAt(i)
    h = h >>> 0 // keep unsigned 32-bit
  }
  return h.toString(36)
}
