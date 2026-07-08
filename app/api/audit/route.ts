import { NextRequest, NextResponse } from 'next/server'
import { getRecentAuditEvents, verifyAuditLogIntegrity } from '@/lib/auditLog'
import { requireAuthWithPermission } from '@/lib/apiAuth'

/**
 * GET /api/audit — org-scoped audit log reader (AR1/H1).
 *
 * Requires the 'audit:read' permission (admins only, per lib/permissions.ts) —
 * not a bare authenticated session. Returned events are filtered to the caller's
 * own org; cross-org events are never exposed. The 500-event cap is preserved and
 * applied AFTER org filtering so an admin sees up to 500 of their own org's events.
 */
export async function GET(req: NextRequest) {
  const { session, error } = await requireAuthWithPermission(req, 'audit:read')
  if (error) return error

  // /api/audit?action=verify — integrity check over the full (global) chain.
  // Chain integrity is a whole-file property, so verification is not org-scoped;
  // it is still gated behind audit:read above.
  const { searchParams } = new URL(req.url)
  if (searchParams.get('action') === 'verify') {
    try {
      const result = verifyAuditLogIntegrity()
      return NextResponse.json(result)
    } catch (e) {
      return NextResponse.json({ error: String(e) }, { status: 500 })
    }
  }

  try {
    const events = getRecentAuditEvents(500, session.orgId)
    return NextResponse.json({ events })
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 500 })
  }
}
