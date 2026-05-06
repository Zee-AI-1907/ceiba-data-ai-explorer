/**
 * secureStorage.ts — Obfuscated localStorage wrapper.
 *
 * Uses btoa/atob base64 obfuscation to prevent plain-text PHI in localStorage.
 * This is NOT true encryption — it provides basic obfuscation so values are
 * not immediately human-readable in DevTools.
 *
 * TODO: Upgrade to proper async AES-GCM encryption via Web Crypto API:
 *   const key = await crypto.subtle.importKey(...)
 *   const encrypted = await crypto.subtle.encrypt({ name:'AES-GCM', iv }, key, data)
 * The API below mirrors the async interface so the migration is a drop-in swap.
 */

const PREFIX = 'ceiba_sec_'

function encode(value: unknown): string {
  try {
    return btoa(encodeURIComponent(JSON.stringify(value)))
  } catch {
    // Fallback: store as plain JSON if encoding fails
    return JSON.stringify(value)
  }
}

function decode<T>(raw: string): T | null {
  try {
    // Try to detect if stored as obfuscated (base64) or plain JSON
    const decoded = decodeURIComponent(atob(raw))
    return JSON.parse(decoded) as T
  } catch {
    // Try plain JSON fallback (for values stored before obfuscation was added)
    try {
      return JSON.parse(raw) as T
    } catch {
      return null
    }
  }
}

export const secureStorage = {
  /**
   * Store a value under `key` using base64 obfuscation.
   * Returns a resolved Promise for forward compatibility with the async crypto upgrade.
   */
  async setItem(key: string, value: unknown): Promise<void> {
    if (typeof window === 'undefined') return
    try {
      localStorage.setItem(PREFIX + key, encode(value))
    } catch (e) {
      console.error('[secureStorage] setItem failed:', e)
    }
  },

  /**
   * Retrieve and decode a stored value.
   * Returns null if not found or if decoding fails.
   */
  async getItem<T>(key: string): Promise<T | null> {
    if (typeof window === 'undefined') return null
    try {
      const raw = localStorage.getItem(PREFIX + key)
      if (raw === null) return null
      return decode<T>(raw)
    } catch {
      return null
    }
  },

  /**
   * Remove an item from storage.
   */
  removeItem(key: string): void {
    if (typeof window === 'undefined') return
    localStorage.removeItem(PREFIX + key)
  },
}

// ── Synchronous helpers ───────────────────────────────────────────────────────
// Convenience wrappers for stores that need synchronous read/write semantics.

export function secureGetSync<T>(key: string): T | null {
  if (typeof window === 'undefined') return null
  try {
    const raw = localStorage.getItem(PREFIX + key)
    if (raw === null) return null
    return decode<T>(raw)
  } catch {
    return null
  }
}

export function secureSetSync(key: string, value: unknown): void {
  if (typeof window === 'undefined') return
  try {
    localStorage.setItem(PREFIX + key, encode(value))
  } catch (e) {
    console.error('[secureStorage] setSync failed:', e)
  }
}

export function secureRemoveSync(key: string): void {
  if (typeof window === 'undefined') return
  localStorage.removeItem(PREFIX + key)
}
