import { NextResponse } from 'next/server'
import { requireAuthWithPermission } from '@/lib/apiAuth'
import { addUser } from '@/lib/authStore'
import { logAuditEvent } from '@/lib/auditLog'
import type { Role } from '@/lib/permissions'

const VALID_ROLES: Role[] = ['admin', 'analyst', 'clinician']

/**
 * POST /api/auth/register — ADMIN-ONLY user creation (admin-invite flow).
 *
 * Self-signup is intentionally disabled for this clinical app: only an
 * authenticated admin ('admin:manage' permission) can create users. New users
 * are created within the ADMIN'S OWN org (tenant isolation) unless an explicit
 * orgId is provided by the admin.
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
  // Default new users into the creating admin's org for tenant isolation.
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
  if (password.length < 8) {
    return NextResponse.json({ error: 'password must be at least 8 characters' }, { status: 400 })
  }

  try {
    const created = addUser({ email, password, name, role, orgId })
    logAuditEvent({
      action: 'LOGIN', // no dedicated USER_CREATE action in the audit taxonomy
      resourceType: 'auth',
      detail: `User created '${created.email}' (org ${created.orgId}, role ${created.role}) by ${session.userId}`,
      severity: 'INFO',
      userId: session.userId,
      userEmail: 'admin',
    })
    return NextResponse.json({ user: created }, { status: 201 })
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 409 })
  }
}
