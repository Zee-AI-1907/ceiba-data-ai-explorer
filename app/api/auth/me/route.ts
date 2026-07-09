import { NextResponse } from 'next/server'
import { getSession } from '@/lib/apiAuth'
import { findUserById, roleInOrg, toPublicUser, ORG_REGISTRY } from '@/lib/authStore'

/**
 * GET /api/auth/me
 * Returns the current authenticated user (public shape, incl. memberships) plus
 * the ACTIVE org/role, or 401 if there is no valid session OR the caller is no
 * longer a member of the session's active org.
 *
 * Used by client components (DataNav) to render identity + the org switcher.
 * `activeOrgId` comes from the SESSION (the source of truth for "what am I
 * scoped to right now"); `activeRole` is RE-RESOLVED from the live store so a
 * revoked/downgraded admin does not keep seeing the admin UI off a stale cookie
 * (revocation floor — mirrors the API guards). Each membership is decorated with
 * its human-readable orgName from ORG_REGISTRY.
 */
export async function GET(req: Request) {
  const session = await getSession(req)
  if (!session) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const user = findUserById(session.userId)
  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  // Re-resolve the active role from the live store. If the active membership is
  // gone (revoked mid-session), the session is invalid → 401.
  const activeRole = roleInOrg(user, session.orgId)
  if (activeRole === null) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const publicUser = toPublicUser(user)
  const membershipsWithNames = publicUser.memberships.map((m) => ({
    ...m,
    orgName: ORG_REGISTRY[m.orgId] ?? m.orgId,
  }))

  return NextResponse.json({
    user: { ...publicUser, memberships: membershipsWithNames },
    activeOrgId: session.orgId,
    activeRole,
    orgName: ORG_REGISTRY[session.orgId] ?? session.orgId,
  })
}
