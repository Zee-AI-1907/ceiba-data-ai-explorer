import { NextResponse } from 'next/server'
import { getSession } from '@/lib/apiAuth'
import { findUserById, toPublicUser, ORG_REGISTRY } from '@/lib/authStore'

/**
 * GET /api/auth/me
 * Returns the current authenticated user (public shape) + org display name,
 * or 401 if there is no valid session. Used by client components (DataNav) to
 * render identity without exposing the session cookie to JS.
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

  return NextResponse.json({
    user: toPublicUser(user),
    orgName: ORG_REGISTRY[user.orgId] ?? user.orgId,
  })
}
