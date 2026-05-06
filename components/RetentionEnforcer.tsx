'use client'

/**
 * RetentionEnforcer — client-only component that runs enforceRetentionPolicies()
 * on mount and calls initCryptoKey() to pre-warm the AES-GCM key.
 * Renders nothing; purely a side-effect component.
 */

import { useEffect } from 'react'
import { enforceRetentionPolicies } from '@/lib/retentionPolicy'
import { initCryptoKey } from '@/lib/secureStorage'

export default function RetentionEnforcer() {
  useEffect(() => {
    // Pre-warm AES-GCM key so async get/set is fast from first use
    initCryptoKey().catch(() => {
      /* crypto unavailable in old browsers — graceful degradation */
    })
    // Purge stale localStorage items per retention policy
    enforceRetentionPolicies()
  }, [])

  return null
}
