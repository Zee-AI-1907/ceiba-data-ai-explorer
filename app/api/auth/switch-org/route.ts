import { NextResponse } from 'next/server'
import { requireAuth } from '@/lib/apiAuth'
import {
  findUserById,
  isMemberOf,
  roleInOrg,
  setDefaultOrg,
  ORG_REGISTRY,
} from '@/lib/authStore'
import {
  SESSION_COOKIE_NAME,
  signSession,
  sessionCookieOptions,
} from '@/lib/session'
import { logAuditEvent } from '@/lib/auditLog'

/**
 * POST /api/auth/switch-org — Switch the caller's ACTIVE org.
 *
 * Body: { orgId }
 *
 * This is the ONLY endpoint that mutates the active org (`activeOrgId`), and the
 * membership-boundary enforcement point: it returns 403 unless the caller is a
 * member of the requested org. On success it re-issues the signed session cookie
 * with the new active org + the effective role FOR that org, persists last-active,
 * and audits an ORG_SWITCH event into the DESTINATION org's trail.
 *
 * Because the cookie is HMAC-signed and this handler is the only mutator, the
 * single scoping key `session.orgId` can never carry a non-member org.
 */
export async function POST(req: Request) {
  const { session, error } = await requireAuth(req)
  if (error) return error

  let body: { orgId?: unknown }
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: 'Invalid request body' }, { status: 400 })
  }

  const targetOrgId = typeof body.orgId === 'string' ? body.orgId.trim() : ''
  if (!targetOrgId) {
    return NextResponse.json({ error: 'orgId is required' }, { status: 400 })
  }

  const user = findUserById(session.userId)
  if (!user) {
    // Session references a user that no longer exists → session invalid.
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  // Membership-boundary check: refuse to activate an org the user is not in.
  if (!isMemberOf(user, targetOrgId)) {
    return NextResponse.json(
      { error: 'Forbidden', reason: 'not_a_member' },
      { status: 403 }
    )
  }

  const newRole = roleInOrg(user, targetOrgId)!

  // Same-org switch → clean no-op: do NOT re-audit (log noise) and do NOT
  // re-issue the cookie (which would reset the 8h TTL). Return the current
  // active org/role so the client stays consistent.
  if (targetOrgId === session.orgId) {
    return NextResponse.json({
      activeOrgId: targetOrgId,
      role: newRole,
      orgName: ORG_REGISTRY[targetOrgId] ?? targetOrgId,
    })
  }

  const previousOrgId = session.orgId
  const previousRole = session.role

  // Persist last-active so a returning user lands here next login.
  setDefaultOrg(user.id, targetOrgId)

  // Audit into the DESTINATION org's trail (orgId = the new active org), so an
  // auditor reading that org's log sees exactly when the user entered.
  const forwarded = req.headers.get('x-forwarded-for')
  const ip = forwarded?.split(',')[0]?.trim() ?? req.headers.get('x-real-ip') ?? 'unknown'
  logAuditEvent({
    action: 'ORG_SWITCH',
    resourceType: 'auth',
    detail: `Switched from ${previousOrgId} to ${targetOrgId} (role ${previousRole}→${newRole})`,
    severity: 'INFO',
    userId: user.id,
    orgId: targetOrgId,
    userEmail: user.email,
    ipAddress: ip,
    userAgent: req.headers.get('user-agent') ?? undefined,
  })

  const cookieValue = signSession({
    userId: user.id,
    orgId: targetOrgId,
    role: newRole,
  })

  const res = NextResponse.json({
    activeOrgId: targetOrgId,
    role: newRole,
    orgName: ORG_REGISTRY[targetOrgId] ?? targetOrgId,
  })
  res.cookies.set(SESSION_COOKIE_NAME, cookieValue, sessionCookieOptions())
  return res
}
