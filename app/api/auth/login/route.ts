import { NextResponse } from 'next/server'
import {
  verifyCredentials,
  toPublicUser,
  resolveActiveOrg,
  roleInOrg,
  setDefaultOrg,
} from '@/lib/authStore'
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
  let body: { email?: unknown; password?: unknown; orgId?: unknown }
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: 'Invalid request body' }, { status: 400 })
  }

  const email = typeof body.email === 'string' ? body.email : ''
  const password = typeof body.password === 'string' ? body.password : ''
  // Optional: a multi-org user may request a specific active org at login.
  // resolveActiveOrg ignores it if the user is not a member (never leaks scope).
  const preferredOrgId = typeof body.orgId === 'string' ? body.orgId : undefined

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

  // MULTI-ORG: choose the active org (preferred → default → first membership),
  // then resolve the effective role FOR that active org. resolveActiveOrg never
  // returns a non-member org, so the session is always scoped to a member org.
  const activeOrgId = resolveActiveOrg(user, preferredOrgId)
  const activeRole = roleInOrg(user, activeOrgId)!
  // Persist last-active so a returning user lands where they left off.
  setDefaultOrg(user.id, activeOrgId)

  const cookieValue = signSession({
    userId: user.id,
    orgId: activeOrgId,
    role: activeRole,
  })

  logAuditEvent({
    action: 'LOGIN',
    resourceType: 'auth',
    detail: `Login for '${user.email}' (org ${activeOrgId}, role ${activeRole})`,
    severity: 'INFO',
    userId: user.id,
    orgId: activeOrgId,
    userEmail: user.email,
    ipAddress: ip,
    userAgent,
  })

  const res = NextResponse.json({ user: toPublicUser(user) })
  res.cookies.set(SESSION_COOKIE_NAME, cookieValue, sessionCookieOptions())
  return res
}
