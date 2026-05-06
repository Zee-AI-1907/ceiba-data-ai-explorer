/**
 * retentionPolicy.ts — Auto-purge stale localStorage items (G-003).
 *
 * Each store type has a configurable retention window. Items whose
 * `createdAt` or `updatedAt` timestamp exceeds the window are removed.
 *
 * Call enforceRetentionPolicies() from the root layout on mount.
 */

import { secureGetSync, secureSetSync, secureRemoveSync } from '@/lib/secureStorage'

// Retention windows in days per store key
const RETENTION_DAYS: Record<string, number> = {
  charts: 90,
  dashboards: 90,
  comments: 180,
  notifications: 30,
  alerts: 365,
  reports: 365,
}

type ItemWithTimestamps = {
  createdAt?: string
  updatedAt?: string
  [key: string]: unknown
}

function isExpired(item: ItemWithTimestamps, retentionDays: number): boolean {
  const ref = item.updatedAt ?? item.createdAt
  if (!ref) return false
  const age = Date.now() - new Date(ref).getTime()
  return age > retentionDays * 24 * 60 * 60 * 1000
}

/**
 * Enforce retention policies across all managed localStorage store keys.
 * Safe to call multiple times — no-ops when window is undefined (SSR).
 */
export function enforceRetentionPolicies(): void {
  if (typeof window === 'undefined') return

  for (const [storeKey, retentionDays] of Object.entries(RETENTION_DAYS)) {
    try {
      const items = secureGetSync<ItemWithTimestamps[]>(storeKey)
      if (!Array.isArray(items)) continue

      const before = items.length
      const filtered = items.filter((item) => !isExpired(item, retentionDays))

      if (filtered.length < before) {
        if (filtered.length === 0) {
          secureRemoveSync(storeKey)
        } else {
          secureSetSync(storeKey, filtered)
        }
        console.info(
          `[retentionPolicy] ${storeKey}: purged ${before - filtered.length} expired item(s) (>${retentionDays}d)`,
        )
      }
    } catch {
      // Never let retention enforcement crash the app
    }
  }
}
