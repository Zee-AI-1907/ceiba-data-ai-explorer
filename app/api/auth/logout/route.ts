import { NextResponse } from 'next/server'
import { getSession } from '@/lib/apiAuth'
import { findUserById } from '@/lib/authStore'
import { SESSION_COOKIE_NAME, sessionCookieOptions } from '@/lib/session'
import { logAuditEvent } from '@/lib/auditLog'

/**
 * POST /api/auth/logout
 * Clears the session cookie. Always succeeds (idempotent).
 */
export async function POST(req: Request) {
  const session = await getSession(req)
  if (session) {
    const user = findUserById(session.userId)
    const forwarded = req.headers.get('x-forwarded-for')
    const ip = forwarded?.split(',')[0]?.trim() ?? req.headers.get('x-real-ip') ?? 'unknown'
    logAuditEvent({
      action: 'LOGOUT',
      resourceType: 'auth',
      detail: `Logout for '${user?.email ?? session.userId}'`,
      severity: 'INFO',
      userId: session.userId,
      userEmail: user?.email ?? 'unknown',
      ipAddress: ip,
      userAgent: req.headers.get('user-agent') ?? undefined,
    })
  }

  const res = NextResponse.json({ ok: true })
  // Overwrite with an immediately-expiring cookie to clear it.
  res.cookies.set(SESSION_COOKIE_NAME, '', { ...sessionCookieOptions(), maxAge: 0 })
  return res
}
