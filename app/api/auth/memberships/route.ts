import { NextResponse } from 'next/server'
import { requireAuthWithPermission } from '@/lib/apiAuth'
import { findUserById, grantMembership, revokeMembership } from '@/lib/authStore'
import { logAuditEvent } from '@/lib/auditLog'
import type { Role } from '@/lib/permissions'

const VALID_ROLES: Role[] = ['admin', 'analyst', 'clinician']

/**
 * Membership provisioning — governed by the PER-ACTIVE-ORG admin model.
 *
 * There is intentionally NO platform super-admin. `admin:manage` is resolved
 * against the caller's ACTIVE org (requireAuthWithPermission re-derives the
 * effective role from the active membership). The same-org rule below then
 * pins every grant/revoke to the caller's active org, so an admin of org-X can
 * only manage memberships INTO org-X — there is no cross-org escalation path.
 */

/**
 * POST /api/auth/memberships — grant (or update) a membership.
 * Body: { userId, orgId, role }. `orgId` MUST equal the caller's active org.
 */
export async function POST(req: Request) {
  const { session, error } = await requireAuthWithPermission(req, 'admin:manage')
  if (error) return error

  let body: { userId?: unknown; orgId?: unknown; role?: unknown }
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: 'Invalid request body' }, { status: 400 })
  }

  const userId = typeof body.userId === 'string' ? body.userId.trim() : ''
  const orgId = typeof body.orgId === 'string' ? body.orgId.trim() : ''
  const role = typeof body.role === 'string' ? (body.role as Role) : ''

  if (!userId || !orgId || !role) {
    return NextResponse.json(
      { error: 'userId, orgId and role are required' },
      { status: 400 }
    )
  }
  if (!VALID_ROLES.includes(role)) {
    return NextResponse.json(
      { error: `role must be one of: ${VALID_ROLES.join(', ')}` },
      { status: 400 }
    )
  }
  // Same-org rule: no cross-org escalation. An admin may only grant memberships
  // into the org they are actively administering.
  if (orgId !== session.orgId) {
    return NextResponse.json(
      { error: 'Forbidden', reason: 'cross_org_grant' },
      { status: 403 }
    )
  }

  const target = findUserById(userId)
  if (!target) {
    return NextResponse.json({ error: 'User not found' }, { status: 404 })
  }

  const updated = grantMembership(userId, orgId, role)
  if (!updated) {
    return NextResponse.json({ error: 'User not found' }, { status: 404 })
  }

  logAuditEvent({
    action: 'MEMBERSHIP_GRANTED',
    resourceType: 'auth',
    detail: `Membership granted to '${target.email}' in ${orgId} (role ${role}) by ${session.userId}`,
    severity: 'WARNING',
    userId: session.userId,
    orgId: session.orgId,
    userEmail: target.email,
  })

  return NextResponse.json({ user: updated }, { status: 200 })
}

/**
 * DELETE /api/auth/memberships — revoke a membership.
 * Body: { userId, orgId }. `orgId` MUST equal the caller's active org. Refuses
 * to remove a user's last membership (409).
 */
export async function DELETE(req: Request) {
  const { session, error } = await requireAuthWithPermission(req, 'admin:manage')
  if (error) return error

  let body: { userId?: unknown; orgId?: unknown }
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: 'Invalid request body' }, { status: 400 })
  }

  const userId = typeof body.userId === 'string' ? body.userId.trim() : ''
  const orgId = typeof body.orgId === 'string' ? body.orgId.trim() : ''

  if (!userId || !orgId) {
    return NextResponse.json(
      { error: 'userId and orgId are required' },
      { status: 400 }
    )
  }
  if (orgId !== session.orgId) {
    return NextResponse.json(
      { error: 'Forbidden', reason: 'cross_org_grant' },
      { status: 403 }
    )
  }

  const target = findUserById(userId)
  if (!target) {
    return NextResponse.json({ error: 'User not found' }, { status: 404 })
  }
  // Distinguish "not a member of that org" (nothing to revoke) from "would
  // remove the last membership" — both make revokeMembership return null.
  const isMember = target.memberships.some((m) => m.orgId === orgId)
  if (!isMember) {
    return NextResponse.json({ error: 'User is not a member of that org' }, { status: 404 })
  }

  const updated = revokeMembership(userId, orgId)
  if (!updated) {
    // The only remaining reason revoke returned null: it was the last membership.
    return NextResponse.json(
      { error: 'Cannot remove a user\'s last membership', reason: 'last_membership' },
      { status: 409 }
    )
  }

  logAuditEvent({
    action: 'MEMBERSHIP_REVOKED',
    resourceType: 'auth',
    detail: `Membership revoked from '${target.email}' in ${orgId} by ${session.userId}`,
    severity: 'WARNING',
    userId: session.userId,
    orgId: session.orgId,
    userEmail: target.email,
  })

  return NextResponse.json({ user: updated }, { status: 200 })
}
