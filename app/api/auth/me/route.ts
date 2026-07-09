import { NextResponse } from 'next/server'
import { getSession } from '@/lib/apiAuth'
import { findUserById, toPublicUser, ORG_REGISTRY } from '@/lib/authStore'

/**
 * GET /api/auth/me
 * Returns the current authenticated user (public shape, incl. memberships) plus
 * the ACTIVE org/role from the session, or 401 if there is no valid session.
 *
 * Used by client components (DataNav) to render identity + the org switcher.
 * `activeOrgId`/`activeRole` come from the SESSION (the source of truth for
 * "what am I scoped to right now"), NOT from defaultOrgId. Each membership is
 * decorated with its human-readable orgName from ORG_REGISTRY.
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

  const publicUser = toPublicUser(user)
  const membershipsWithNames = publicUser.memberships.map((m) => ({
    ...m,
    orgName: ORG_REGISTRY[m.orgId] ?? m.orgId,
  }))

  return NextResponse.json({
    user: { ...publicUser, memberships: membershipsWithNames },
    activeOrgId: session.orgId,
    activeRole: session.role,
    orgName: ORG_REGISTRY[session.orgId] ?? session.orgId,
  })
}
