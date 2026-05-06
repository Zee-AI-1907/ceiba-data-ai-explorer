import { NextRequest, NextResponse } from 'next/server'
import { getRecentAuditEvents, verifyAuditLogIntegrity } from '@/lib/auditLog'
import { requireAuth } from '@/lib/apiAuth'

export async function GET(req: NextRequest) {
  const { error } = await requireAuth(req)
  if (error) return error

  // /api/audit?action=verify
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
    const events = getRecentAuditEvents(500)
    return NextResponse.json({ events })
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 500 })
  }
}
