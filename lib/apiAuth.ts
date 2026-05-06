import { auth } from '@clerk/nextjs/server'
import { NextResponse } from 'next/server'
import { hasPermission, type Permission, type Role } from '@/lib/permissions'

export async function requireAuth(_request: Request) {
  const { userId, sessionClaims } = await auth()
  if (!userId) {
    return {
      session: null,
      error: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }),
    }
  }
  // Build a session-like object for compatibility with existing code
  const session = {
    user: {
      id: userId,
      email: (sessionClaims?.email as string) ?? 'unknown',
      name: (sessionClaims?.name as string) ?? 'User',
      role: ((sessionClaims?.publicMetadata as Record<string, string>)?.role) ?? 'clinician',
    },
  }
  return { session, error: null }
}

/**
 * requireAuthWithPermission — Authenticate AND authorise in one call.
 *
 * Returns `{ session, error: null }` when the authenticated user's role
 * holds the requested permission, or `{ session: null, error: Response }`
 * with an appropriate 401 / 403 otherwise.
 */
export async function requireAuthWithPermission(
  request: Request,
  permission: Permission
): Promise<
  | { session: { user: { id: string; email: string; name: string; role: string } }; error: null }
  | { session: null; error: NextResponse }
> {
  const { session, error } = await requireAuth(request)
  if (error) return { session: null, error }

  const role = session!.user.role as Role | undefined

  if (!role || !hasPermission(role, permission)) {
    return {
      session: null,
      error: NextResponse.json(
        { error: 'Forbidden', required: permission, role: role ?? 'unknown' },
        { status: 403 }
      ),
    }
  }

  return { session: session!, error: null }
}
