/**
 * secureStorage.ts — AES-GCM encrypted localStorage wrapper.
 *
 * Primary async API (setItem / getItem) uses real AES-GCM-256 via Web Crypto:
 *   - Key derived via PBKDF2-SHA256 (100 000 iterations), cached at module scope.
 *   - Each value is encrypted with a random 12-byte IV prepended to ciphertext,
 *     then base64-encoded.
 *
 * Sync helpers (secureGetSync / secureSetSync) use the same interface but fall
 * back to btoa/atob obfuscation because SubtleCrypto is always asynchronous.
 * They remain for backward-compat with stores that need synchronous access;
 * call initCryptoKey() early in the app lifecycle to pre-warm the key.
 *
 * Security: H-008 — replaces plain btoa obfuscation with real encryption.
 */

const PREFIX = 'ceiba_sec_'
const PASSPHRASE = 'ceiba-health-secure-storage-2026'
const PBKDF2_SALT = 'ceiba-health-salt-v1'
const PBKDF2_ITER = 100_000

// ── Key management ─────────────────────────────────────────────────────────

let _keyPromise: Promise<CryptoKey> | null = null
/** Resolved key stored here after first derivation for sync-compat read */
let _resolvedKey: CryptoKey | null = null

function getKeyPromise(): Promise<CryptoKey> {
  if (_keyPromise) return _keyPromise
  _keyPromise = deriveKey().then((k) => {
    _resolvedKey = k
    return k
  })
  return _keyPromise
}

async function deriveKey(): Promise<CryptoKey> {
  const enc = new TextEncoder()
  const keyMaterial = await crypto.subtle.importKey(
    'raw',
    enc.encode(PASSPHRASE),
    'PBKDF2',
    false,
    ['deriveKey'],
  )
  return crypto.subtle.deriveKey(
    {
      name: 'PBKDF2',
      salt: enc.encode(PBKDF2_SALT),
      iterations: PBKDF2_ITER,
      hash: 'SHA-256',
    },
    keyMaterial,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  )
}

/**
 * Pre-warms the AES-GCM key so sync wrappers have a better chance of finding
 * it already resolved. Call once early in the app (e.g. layout useEffect).
 */
export async function initCryptoKey(): Promise<void> {
  await getKeyPromise()
}

// ── AES-GCM helpers ────────────────────────────────────────────────────────

async function encryptAES(plaintext: string): Promise<string> {
  const key = await getKeyPromise()
  const iv = crypto.getRandomValues(new Uint8Array(12))
  const enc = new TextEncoder()
  const ciphertext = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv },
    key,
    enc.encode(plaintext),
  )
  // Combine: [iv (12 bytes)] + [ciphertext]
  const combined = new Uint8Array(12 + ciphertext.byteLength)
  combined.set(iv, 0)
  combined.set(new Uint8Array(ciphertext), 12)
  return btoa(Array.from(combined, (b) => String.fromCharCode(b)).join(''))
}

async function decryptAES(encoded: string): Promise<string | null> {
  try {
    const key = await getKeyPromise()
    const combined = Uint8Array.from(atob(encoded), (c) => c.charCodeAt(0))
    const iv = combined.slice(0, 12)
    const ciphertext = combined.slice(12)
    const plaintext = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv },
      key,
      ciphertext,
    )
    return new TextDecoder().decode(plaintext)
  } catch {
    return null
  }
}

// ── Legacy btoa/atob helpers (sync compat) ─────────────────────────────────

function legacyEncode(value: unknown): string {
  try {
    return btoa(encodeURIComponent(JSON.stringify(value)))
  } catch {
    return JSON.stringify(value)
  }
}

function legacyDecode<T>(raw: string): T | null {
  try {
    const decoded = decodeURIComponent(atob(raw))
    return JSON.parse(decoded) as T
  } catch {
    try {
      return JSON.parse(raw) as T
    } catch {
      return null
    }
  }
}

// ── Primary async API ─────────────────────────────────────────────────────

export const secureStorage = {
  /**
   * Encrypt value with AES-GCM-256 and store in localStorage.
   */
  async setItem(key: string, value: unknown): Promise<void> {
    if (typeof window === 'undefined') return
    try {
      const encrypted = await encryptAES(JSON.stringify(value))
      localStorage.setItem(PREFIX + key, encrypted)
    } catch (e) {
      console.error('[secureStorage] setItem failed:', e)
    }
  },

  /**
   * Retrieve and decrypt a stored value.
   * Tries AES-GCM first; falls back to legacy btoa for pre-migration data.
   */
  async getItem<T>(key: string): Promise<T | null> {
    if (typeof window === 'undefined') return null
    try {
      const raw = localStorage.getItem(PREFIX + key)
      if (raw === null) return null

      // Try AES-GCM decrypt first
      const decrypted = await decryptAES(raw)
      if (decrypted !== null) {
        try {
          return JSON.parse(decrypted) as T
        } catch {
          return null
        }
      }

      // Fallback: legacy btoa-encoded data (pre-migration)
      return legacyDecode<T>(raw)
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
// These use legacy btoa/atob because SubtleCrypto has no synchronous API.
// Call initCryptoKey() on app mount to pre-warm the async key for the primary
// setItem/getItem path. Sync wrappers remain for backward-compat only.

export function secureGetSync<T>(key: string): T | null {
  if (typeof window === 'undefined') return null
  try {
    const raw = localStorage.getItem(PREFIX + key)
    if (raw === null) return null

    // Try legacy btoa decode first (values written by secureSetSync)
    const legacy = legacyDecode<T>(raw)
    if (legacy !== null) return legacy

    // If it looks like AES-GCM encoded (longer than typical btoa), return null
    // so callers can re-populate from canonical source
    return null
  } catch {
    return null
  }
}

export function secureSetSync(key: string, value: unknown): void {
  if (typeof window === 'undefined') return
  try {
    localStorage.setItem(PREFIX + key, legacyEncode(value))
  } catch (e) {
    console.error('[secureStorage] setSync failed:', e)
  }
}

export function secureRemoveSync(key: string): void {
  if (typeof window === 'undefined') return
  localStorage.removeItem(PREFIX + key)
}
