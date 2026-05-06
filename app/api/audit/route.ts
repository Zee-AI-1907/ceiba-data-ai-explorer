import { NextResponse } from 'next/server'
import { getRecentAuditEvents } from '@/lib/auditLog'

export async function GET() {
  try {
    const events = getRecentAuditEvents(500)
    return NextResponse.json({ events })
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 500 })
  }
}
