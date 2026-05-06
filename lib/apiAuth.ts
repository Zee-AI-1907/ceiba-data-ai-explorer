import { getServerSession } from 'next-auth'
import { authOptions } from '@/lib/auth'
import { NextResponse } from 'next/server'
import { hasPermission, type Permission, type Role } from '@/lib/permissions'

export async function requireAuth(_request: Request) {
  const session = await getServerSession(authOptions)
  if (!session) {
    return {
      session: null,
      error: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }),
    }
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
  | { session: NonNullable<Awaited<ReturnType<typeof getServerSession>>>; error: null }
  | { session: null; error: NextResponse }
> {
  const { session, error } = await requireAuth(request)
  if (error) return { session: null, error }

  const role = (session!.user as { role?: string }).role as Role | undefined

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
