import { NextResponse } from 'next/server'
import { requireAuthWithPermission } from '@/lib/apiAuth'
import { addUser, findUserById } from '@/lib/authStore'
import { logAuditEvent } from '@/lib/auditLog'
import type { Role } from '@/lib/permissions'

const VALID_ROLES: Role[] = ['admin', 'analyst', 'clinician']

/**
 * POST /api/auth/register — ADMIN-ONLY user creation (admin-invite flow).
 *
 * Self-signup is intentionally disabled for this clinical app: only an
 * authenticated admin ('admin:manage' permission — resolved for the admin's
 * ACTIVE org) can create users. New users are created with a single initial
 * membership in the ADMIN'S ACTIVE org. Any explicit body.orgId MUST equal the
 * active org (no cross-org escalation) — add further orgs via
 * POST /api/auth/memberships.
 *
 * Body: { email, password, name, role, orgId? }
 */
export async function POST(req: Request) {
  const { session, error } = await requireAuthWithPermission(req, 'admin:manage')
  if (error) return error

  let body: {
    email?: unknown
    password?: unknown
    name?: unknown
    role?: unknown
    orgId?: unknown
  }
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: 'Invalid request body' }, { status: 400 })
  }

  const email = typeof body.email === 'string' ? body.email.trim() : ''
  const password = typeof body.password === 'string' ? body.password : ''
  const name = typeof body.name === 'string' ? body.name.trim() : ''
  const role = typeof body.role === 'string' ? (body.role as Role) : ''
  // New users are created in the admin's ACTIVE org. An explicit body.orgId is
  // allowed only if it equals the active org — no cross-org creation.
  const orgId = typeof body.orgId === 'string' && body.orgId.trim()
    ? body.orgId.trim()
    : session.orgId

  if (!email || !password || !name || !role) {
    return NextResponse.json(
      { error: 'email, password, name and role are required' },
      { status: 400 }
    )
  }
  if (!VALID_ROLES.includes(role)) {
    return NextResponse.json(
      { error: `role must be one of: ${VALID_ROLES.join(', ')}` },
      { status: 400 }
    )
  }
  if (orgId !== session.orgId) {
    return NextResponse.json(
      { error: 'Forbidden', reason: 'cross_org_grant' },
      { status: 403 }
    )
  }
  if (password.length < 8) {
    return NextResponse.json({ error: 'password must be at least 8 characters' }, { status: 400 })
  }

  try {
    const created = addUser({ email, password, name, membership: { orgId, role } })
    // Attribute the audit event to the ACTING admin's real email (P3-5), not the
    // literal string 'admin'. Fall back to the userId if the admin record cannot
    // be re-read (should not happen — they just passed the permission gate).
    const actingAdmin = findUserById(session.userId)
    logAuditEvent({
      action: 'USER_CREATED',
      resourceType: 'auth',
      detail: `User created '${created.email}' (org ${orgId}, role ${role}) by ${session.userId}`,
      severity: 'WARNING',
      userId: session.userId,
      orgId: session.orgId,
      userEmail: actingAdmin?.email ?? session.userId,
    })
    return NextResponse.json({ user: created }, { status: 201 })
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 409 })
  }
}
