/**
 * multiorg.idor.test.ts — Cross-tenant isolation gate (multi-org auth plan §5.2).
 *
 * The four IDOR tests that no phase merges without, plus the switch-org and
 * membership-provisioning contracts. Everything runs against the real route
 * handlers + real authStore + real repository with isolated data dirs (no
 * network, no PG).
 *
 * IDOR-1  member-of-only-A can never reach B (no switch possible).
 * IDOR-2  member-of-both, active on A, cannot touch B without switching.
 * IDOR-3  role is per active org (admin in A, analyst in B).
 * IDOR-4  switching to a non-member org is 403 (and a forged cookie is 401).
 */

import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

const AUTH_DIR = mkdtempSync(join(tmpdir(), 'ceiba-idor-auth-'))
const REPO_DIR = mkdtempSync(join(tmpdir(), 'ceiba-idor-repo-'))
process.env.CEIBA_AUTH_DATA_DIR = AUTH_DIR
process.env.CEIBA_DATA_DIR = REPO_DIR
process.env.AUTH_SEED_PASSWORD = 'TestSeedPassword!2026'
process.env.SESSION_SECRET = process.env.SESSION_SECRET ?? 'test-session-secret-0123456789'

/* eslint-disable import/first */
import {
  getUsers,
  findUserByEmail,
  grantMembership,
  revokeMembership,
  type User,
} from '@/lib/authStore'
import { SESSION_COOKIE_NAME, signSession } from '@/lib/session'
import { dashboardRepository } from '@/lib/repository'
import type { Session } from '@/lib/apiAuth'
import { POST as loginPOST } from '@/app/api/auth/login/route'
import { POST as switchPOST } from '@/app/api/auth/switch-org/route'
import { GET as meGET } from '@/app/api/auth/me/route'
import { POST as membershipsPOST, DELETE as membershipsDELETE } from '@/app/api/auth/memberships/route'
/* eslint-enable import/first */

const PASSWORD = 'TestSeedPassword!2026'

// ── helpers ───────────────────────────────────────────────────────────────

function cookieHeaderFor(userId: string, orgId: string, role: 'admin' | 'analyst' | 'clinician'): string {
  const value = signSession({ userId, orgId, role })
  return `${SESSION_COOKIE_NAME}=${encodeURIComponent(value)}`
}

/** Extract the freshly-set session cookie value from a route Response. */
function setCookieValue(res: Response): string | null {
  const raw = res.headers.get('set-cookie')
  if (!raw) return null
  const match = raw.match(new RegExp(`${SESSION_COOKIE_NAME}=([^;]+)`))
  return match ? decodeURIComponent(match[1]) : null
}

function jsonReq(url: string, body: unknown, cookie?: string, method: 'POST' | 'DELETE' = 'POST'): Request {
  const headers = new Headers({ 'Content-Type': 'application/json' })
  if (cookie) headers.set('cookie', cookie)
  const init: RequestInit = { method, headers, body: JSON.stringify(body) }
  return new Request(url, init)
}

/** Build a Session object from a signed cookie value (mirrors the route guard). */
function sessionFromCookieValue(value: string): Session {
  const [payloadB64] = value.split('.')
  const payload = JSON.parse(Buffer.from(payloadB64, 'base64url').toString('utf-8'))
  return { userId: payload.userId, orgId: payload.orgId, role: payload.role }
}

// Seed two extra test users so the IDOR matrix is deterministic:
//   only-A : [{org-A, analyst}]
//   both   : [{org-A, admin}, {org-B, analyst}]
let onlyA: User
let both: User

// Create the two IDOR fixtures directly through the store's public API.
beforeAll(async () => {
  getUsers() // seed the default set (also creates the file)
  const { addUser } = await import('@/lib/authStore')
  // only-A: single membership in org-A as analyst.
  if (!findUserByEmail('only-a@test.local')) {
    addUser({ email: 'only-a@test.local', password: PASSWORD, name: 'Only A', membership: { orgId: 'org-A', role: 'analyst' } })
  }
  // both: admin in org-A, analyst in org-B.
  if (!findUserByEmail('both@test.local')) {
    addUser({ email: 'both@test.local', password: PASSWORD, name: 'Both', membership: { orgId: 'org-A', role: 'admin' } })
    const created = findUserByEmail('both@test.local')!
    grantMembership(created.id, 'org-B', 'analyst')
  }
  onlyA = findUserByEmail('only-a@test.local')!
  both = findUserByEmail('both@test.local')!
})

afterAll(() => {
  rmSync(AUTH_DIR, { recursive: true, force: true })
  rmSync(REPO_DIR, { recursive: true, force: true })
})

// A dashboard owned in org-B, planted directly via the repository.
const sessionB: Session = { userId: 'seed-b', orgId: 'org-B', role: 'admin' }
beforeEach(async () => {
  // Ensure dash-B exists in org-B before each test.
  const existing = await dashboardRepository.get(sessionB, 'dash-B')
  if (!existing) {
    await dashboardRepository.upsert(sessionB, { id: 'dash-B', name: 'B dashboard', status: 'Draft' })
  }
})

describe('IDOR-1 — member-of-only-A can never reach B (no switch possible)', () => {
  it('cross-org read/write of B is null even at the repository seam', async () => {
    const sessionA: Session = { userId: onlyA.id, orgId: 'org-A', role: 'analyst' }
    expect(await dashboardRepository.get(sessionA, 'dash-B')).toBeNull()
    expect(await dashboardRepository.upsert(sessionA, { id: 'dash-B', name: 'hijack', status: 'Draft' })).toBeNull()
  })

  it('switch-org to B is 403 not_a_member', async () => {
    const cookie = cookieHeaderFor(onlyA.id, 'org-A', 'analyst')
    const res = await switchPOST(jsonReq('http://localhost/api/auth/switch-org', { orgId: 'org-B' }, cookie))
    expect(res.status).toBe(403)
    const body = await res.json()
    expect(body.reason).toBe('not_a_member')
  })
})

describe('IDOR-2 — member-of-both, active on A, cannot touch B without switching', () => {
  it('active on A: reading B is null; after switch to B the record is visible', async () => {
    // Log in as `both` → active org resolves to org-A (defaultOrgId).
    const loginRes = await loginPOST(
      jsonReq('http://localhost/api/auth/login', { email: 'both@test.local', password: PASSWORD })
    )
    expect(loginRes.status).toBe(200)
    const cookieA = setCookieValue(loginRes)!
    const sessA = sessionFromCookieValue(cookieA)
    expect(sessA.orgId).toBe('org-A')
    // Active on A → cannot read B's data even though `both` IS a B member.
    expect(await dashboardRepository.get(sessA, 'dash-B')).toBeNull()

    // Switch to B.
    const switchRes = await switchPOST(
      jsonReq('http://localhost/api/auth/switch-org', { orgId: 'org-B' }, `${SESSION_COOKIE_NAME}=${encodeURIComponent(cookieA)}`)
    )
    expect(switchRes.status).toBe(200)
    const cookieB = setCookieValue(switchRes)!
    const sessB = sessionFromCookieValue(cookieB)
    expect(sessB.orgId).toBe('org-B')
    expect(sessB.role).toBe('analyst') // per-org role flipped
    // Now — and only now — the B record is reachable.
    const rec = await dashboardRepository.get(sessB, 'dash-B')
    expect(rec).not.toBeNull()
    expect(rec!.name).toBe('B dashboard')
  })
})

describe('IDOR-3 — role is per active org', () => {
  it('admin:manage passes active on A but 403 active on B (analyst there)', async () => {
    // Active on A (admin): can grant a membership into org-A.
    const cookieA = cookieHeaderFor(both.id, 'org-A', 'admin')
    const grantA = await membershipsPOST(
      jsonReq('http://localhost/api/auth/memberships', { userId: onlyA.id, orgId: 'org-A', role: 'clinician' }, cookieA)
    )
    expect(grantA.status).toBe(200)

    // Active on B (analyst): admin:manage must be denied.
    const cookieB = cookieHeaderFor(both.id, 'org-B', 'analyst')
    const grantB = await membershipsPOST(
      jsonReq('http://localhost/api/auth/memberships', { userId: onlyA.id, orgId: 'org-B', role: 'clinician' }, cookieB)
    )
    expect(grantB.status).toBe(403)
  })
})

describe('IDOR-4 — forged / stale cookie', () => {
  it('a cookie with a bad HMAC is rejected (401 at me)', async () => {
    const forged = `${SESSION_COOKIE_NAME}=eyJ1c2VySWQiOiJ4In0.not-a-valid-mac`
    const res = await meGET(new Request('http://localhost/api/auth/me', { headers: { cookie: forged } }))
    expect(res.status).toBe(401)
  })

  it('a revoked active membership on an otherwise-valid cookie → 401 at a permission gate', async () => {
    // `both` is admin in org-A. Sign a valid A-active cookie, then revoke A.
    const cookieA = cookieHeaderFor(both.id, 'org-A', 'admin')
    // Sanity: the gate passes before revocation.
    const before = await membershipsPOST(
      jsonReq('http://localhost/api/auth/memberships', { userId: onlyA.id, orgId: 'org-A', role: 'analyst' }, cookieA)
    )
    expect(before.status).toBe(200)

    // Revoke `both`'s org-A membership (they still have org-B, so revoke succeeds).
    expect(revokeMembership(both.id, 'org-A')).not.toBeNull()

    // The same still-signed A-active cookie now resolves no membership → 401.
    const after = await membershipsPOST(
      jsonReq('http://localhost/api/auth/memberships', { userId: onlyA.id, orgId: 'org-A', role: 'analyst' }, cookieA)
    )
    expect(after.status).toBe(401)

    // Restore for other tests / idempotency.
    grantMembership(both.id, 'org-A', 'admin')
  })
})

describe('switch-org & me contracts', () => {
  it('switching to the already-active org is a 200 no-op that re-issues the cookie', async () => {
    const cookie = cookieHeaderFor(both.id, 'org-A', 'admin')
    const res = await switchPOST(jsonReq('http://localhost/api/auth/switch-org', { orgId: 'org-A' }, cookie))
    expect(res.status).toBe(200)
    expect(setCookieValue(res)).not.toBeNull()
    const body = await res.json()
    expect(body.activeOrgId).toBe('org-A')
    expect(body.role).toBe('admin')
  })

  it('me returns memberships + activeOrgId + activeRole from the session', async () => {
    const cookie = cookieHeaderFor(both.id, 'org-B', 'analyst')
    const res = await meGET(new Request('http://localhost/api/auth/me', { headers: { cookie } }))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.activeOrgId).toBe('org-B')
    expect(body.activeRole).toBe('analyst')
    expect(body.user.memberships.map((m: { orgId: string }) => m.orgId).sort()).toEqual(['org-A', 'org-B'])
    // Each membership decorated with an orgName.
    expect(body.user.memberships.every((m: { orgName?: string }) => typeof m.orgName === 'string')).toBe(true)
  })
})

describe('membership provisioning — same-org rule (no cross-org escalation)', () => {
  it('cross_org_grant: an org-A admin cannot grant into org-B', async () => {
    const cookieA = cookieHeaderFor(both.id, 'org-A', 'admin')
    const res = await membershipsPOST(
      jsonReq('http://localhost/api/auth/memberships', { userId: onlyA.id, orgId: 'org-B', role: 'analyst' }, cookieA)
    )
    expect(res.status).toBe(403)
    expect((await res.json()).reason).toBe('cross_org_grant')
  })

  it('revoke refuses to remove a user\'s last membership (409)', async () => {
    // only-A has a single membership in org-A. Active-on-A admin `both` tries to
    // revoke it → 409 last_membership.
    const cookieA = cookieHeaderFor(both.id, 'org-A', 'admin')
    // First ensure only-A has EXACTLY the org-A membership (IDOR-3 may have added
    // it as clinician; that is still a single membership).
    const target = findUserByEmail('only-a@test.local')!
    // Remove any stray org-B membership if a prior test granted one (defensive).
    if (target.memberships.some((m) => m.orgId === 'org-B')) {
      revokeMembership(target.id, 'org-B')
    }
    const res = await membershipsDELETE(
      jsonReq('http://localhost/api/auth/memberships', { userId: target.id, orgId: 'org-A' }, cookieA, 'DELETE')
    )
    expect(res.status).toBe(409)
    expect((await res.json()).reason).toBe('last_membership')
  })
})
