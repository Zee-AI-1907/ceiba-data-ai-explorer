import { NextRequest, NextResponse } from 'next/server'
import { getRecentAuditEvents } from '@/lib/auditLog'
import { requireAuth } from '@/lib/apiAuth'

export async function GET(req: NextRequest) {
  const { error } = await requireAuth(req)
  if (error) return error

  try {
    const events = getRecentAuditEvents(500)
    return NextResponse.json({ events })
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 500 })
  }
}
