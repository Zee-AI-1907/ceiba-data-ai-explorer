/**
 * apiAuth.ts — Server-side auth guards for App Router route handlers.
 *
 * INTERIM LOCAL AUTH (Phase 1 remediation, Workstream AUTH). Clerk-free.
 * This is the STABLE contract other Phase-1 workstreams (API hardening, SQL
 * safety, AI egress, data owner-scoping) build on. DO NOT change the exported
 * names or return shapes without coordinating — routes are coded against them.
 *
 * ── Session shape ────────────────────────────────────────────────────────────
 * A Session always carries a tenant key (`orgId`). Data-scoping workstreams
 * filter by `session.orgId` (+ owner). Every guard below either returns a
 * Session or an error Response — never a partial session.
 *
 * ── Return contract (discriminated union — CHECK `error` FIRST) ───────────────
 * Every guard returns `{ session, error }`:
 *   - success  →  { session: Session, error: null }
 *   - failure  →  { session: null,    error: NextResponse }   // 401 or 403
 *
 * Usage in a route handler:
 *     const { session, error } = await requireAuth(req)
 *     if (error) return error            // 401 NextResponse
 *     // session.userId / session.orgId / session.role are all present here
 *
 * `getSession` is the exception: it returns `Session | null` directly (no error
 * Response) for callers that want to branch without producing an HTTP response.
 *
 * ── How a user maps to an org, and how to add orgs ───────────────────────────
 * See lib/authStore.ts. Each user record has an `orgId`; the signed session
 * copies it verbatim. Orgs are implicit (a set of users sharing an orgId);
 * ORG_REGISTRY in authStore.ts holds human-readable names. To add an org,
 * create users with a new orgId via authStore.addUser().
 */

import { cookies } from 'next/headers'
import { NextResponse } from 'next/server'
import { hasPermission, type Permission, type Role } from '@/lib/permissions'
import { findUserById, roleInOrg } from '@/lib/authStore'
import {
  SESSION_COOKIE_NAME,
  verifySession,
  type SessionPayload,
} from '@/lib/session'

/** The authenticated session as seen by route handlers. */
export type Session = {
  userId: string
  orgId: string
  role: Role
}

export type AuthSuccess = { session: Session; error: null }
export type AuthFailure = { session: null; error: NextResponse }
export type AuthResult = AuthSuccess | AuthFailure

function unauthorized(): AuthFailure {
  return {
    session: null,
    error: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }),
  }
}

function forbidden(permission: Permission, role: Role | 'unknown'): AuthFailure {
  return {
    session: null,
    error: NextResponse.json(
      { error: 'Forbidden', required: permission, role },
      { status: 403 }
    ),
  }
}

/**
 * Read the raw session cookie value from either an explicit Request (preferred
 * in route handlers that receive one) or the ambient Next cookie store.
 */
async function readSessionCookie(request?: Request): Promise<string | undefined> {
  if (request) {
    const header = request.headers.get('cookie')
    if (header) {
      for (const part of header.split(';')) {
        const eq = part.indexOf('=')
        if (eq === -1) continue
        const name = part.slice(0, eq).trim()
        if (name === SESSION_COOKIE_NAME) {
          return decodeURIComponent(part.slice(eq + 1).trim())
        }
      }
    }
    // Fall through to the ambient store if the request had no matching cookie.
  }
  try {
    const store = await cookies()
    return store.get(SESSION_COOKIE_NAME)?.value
  } catch {
    // cookies() throws outside a request scope (e.g. certain edge contexts).
    return undefined
  }
}

/**
 * getSession — Validate the session cookie server-side and return the payload,
 * or null if there is no valid session. Does NOT produce an HTTP response.
 */
export async function getSession(request?: Request): Promise<Session | null> {
  const raw = await readSessionCookie(request)
  const payload: SessionPayload | null = verifySession(raw)
  if (!payload) return null
  return { userId: payload.userId, orgId: payload.orgId, role: payload.role }
}

/**
 * requireAuth — 401 if there is no valid session.
 * Returns `{ session, error: null }` on success. CHECK `error` FIRST.
 */
export async function requireAuth(request?: Request): Promise<AuthResult> {
  const session = await getSession(request)
  if (!session) return unauthorized()
  return { session, error: null }
}

/**
 * requireOrg — same as requireAuth, but additionally guarantees the session
 * carries a tenant key (`orgId`). Use in any route that scopes data by org.
 * (In practice every session has an orgId; this makes the intent explicit and
 * guards against a malformed/legacy cookie.)
 */
export async function requireOrg(request?: Request): Promise<AuthResult> {
  const { session, error } = await requireAuth(request)
  if (error) return { session: null, error }
  if (!session.orgId) return unauthorized()
  return { session, error: null }
}

/**
 * requireAuthWithPermission — Authenticate AND authorise in one call.
 *
 * MULTI-ORG: the effective role is re-resolved from the user's ACTIVE-org
 * membership at check time (defence-in-depth against a stale cookie), then
 * `hasPermission` is applied to that fresh role. This makes authorization
 * revocation-safe: if the membership for the active org was revoked/downgraded
 * mid-session, the old cookie can no longer ride its stale role.
 *
 * - No session            → 401.
 * - Active membership gone → 401 (the session is now invalid, not merely
 *   forbidden — the user is no longer a member of the org they are scoped to).
 * - Role lacks permission  → 403.
 *
 * The single scoping key `session.orgId` (= active org) is unchanged; only the
 * ROLE is re-derived. The returned session carries the freshly-resolved role so
 * downstream reads current truth.
 */
export async function requireAuthWithPermission(
  request: Request | undefined,
  permission: Permission
): Promise<AuthResult> {
  const { session, error } = await requireAuth(request)
  if (error) return { session: null, error }

  // Re-resolve the effective role against the live store (revocation-safe).
  const user = findUserById(session.userId)
  const effectiveRole: Role | null = user ? roleInOrg(user, session.orgId) : null
  if (!user || effectiveRole === null) {
    // Membership for the active org was revoked → treat the session as invalid.
    return unauthorized()
  }

  if (!hasPermission(effectiveRole, permission)) {
    return forbidden(permission, effectiveRole)
  }
  // Return the freshly-resolved role so downstream reads the current truth.
  return { session: { ...session, role: effectiveRole }, error: null }
}
