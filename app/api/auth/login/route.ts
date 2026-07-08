import { NextResponse } from 'next/server'
import { verifyCredentials, toPublicUser } from '@/lib/authStore'
import {
  SESSION_COOKIE_NAME,
  signSession,
  sessionCookieOptions,
} from '@/lib/session'
import { logAuditEvent } from '@/lib/auditLog'

/**
 * POST /api/auth/login
 * Body: { email, password }
 * On success: sets the signed httpOnly session cookie and returns the public user.
 * On failure: 401 (no user enumeration in the message).
 */
export async function POST(req: Request) {
  let body: { email?: unknown; password?: unknown }
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: 'Invalid request body' }, { status: 400 })
  }

  const email = typeof body.email === 'string' ? body.email : ''
  const password = typeof body.password === 'string' ? body.password : ''

  if (!email || !password) {
    return NextResponse.json({ error: 'Email and password are required' }, { status: 400 })
  }

  const forwarded = req.headers.get('x-forwarded-for')
  const ip = forwarded?.split(',')[0]?.trim() ?? req.headers.get('x-real-ip') ?? 'unknown'
  const userAgent = req.headers.get('user-agent') ?? undefined

  const user = verifyCredentials(email, password)
  if (!user) {
    logAuditEvent({
      action: 'LOGIN_FAILED',
      resourceType: 'auth',
      detail: `Failed login for '${email}'`,
      severity: 'WARNING',
      userId: 'unauthenticated',
      orgId: '', // no authenticated org for a failed login
      userEmail: email,
      ipAddress: ip,
      userAgent,
    })
    return NextResponse.json({ error: 'Invalid email or password' }, { status: 401 })
  }

  const cookieValue = signSession({
    userId: user.id,
    orgId: user.orgId,
    role: user.role,
  })

  logAuditEvent({
    action: 'LOGIN',
    resourceType: 'auth',
    detail: `Login for '${user.email}' (org ${user.orgId}, role ${user.role})`,
    severity: 'INFO',
    userId: user.id,
    orgId: user.orgId,
    userEmail: user.email,
    ipAddress: ip,
    userAgent,
  })

  const res = NextResponse.json({ user: toPublicUser(user) })
  res.cookies.set(SESSION_COOKIE_NAME, cookieValue, sessionCookieOptions())
  return res
}
