import { NextRequest, NextResponse } from 'next/server'
import { getLicenses, isLicenseActive } from '@/lib/licenseStore'

/**
 * Lightweight endpoint called by middleware for license enforcement.
 * Also callable by the UI for status display.
 *
 * Accessible without user auth (middleware calls it with x-internal-license-check header).
 */
export async function GET(_req: NextRequest) {
  try {
    const licenses = getLicenses()
    const hasActive = licenses.some((l) => l.status === 'active' || l.status === 'trial')
    const hasGrace  = licenses.some(
      (l) => l.status === 'grace_period' && isLicenseActive(l)
    )
    return NextResponse.json({ hasActive, hasGrace })
  } catch {
    // Fail open
    return NextResponse.json({ hasActive: true, hasGrace: false })
  }
}
