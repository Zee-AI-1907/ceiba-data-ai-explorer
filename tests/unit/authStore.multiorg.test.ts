/**
 * authStore.multiorg.test.ts — Multi-org data model: migration + membership
 * helpers (Phase 1 of the multi-org auth plan).
 *
 * Proves:
 *   • A legacy single-org record `{orgId, role}` migrates to a one-membership
 *     user whose resolved active org + role are IDENTICAL to before (backward
 *     compat), and the migration is idempotent + written back once.
 *   • isMemberOf / roleInOrg / resolveActiveOrg honour the membership boundary.
 *   • grantMembership / revokeMembership / setDefaultOrg behave per spec,
 *     including the "cannot remove the last membership" invariant.
 *
 * Uses an isolated CEIBA_AUTH_DATA_DIR so it never touches the real data/ store.
 */

import { describe, it, expect, beforeEach, afterAll } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

const TMP_DATA_DIR = mkdtempSync(join(tmpdir(), 'ceiba-auth-test-'))
process.env.CEIBA_AUTH_DATA_DIR = TMP_DATA_DIR
// A deterministic seed password keeps bcrypt cost predictable in CI.
process.env.AUTH_SEED_PASSWORD = 'TestSeedPassword!2026'

// eslint-disable-next-line import/first
import {
  getUsers,
  findUserByEmail,
  isMemberOf,
  roleInOrg,
  resolveActiveOrg,
  grantMembership,
  revokeMembership,
  setDefaultOrg,
  toPublicUser,
  type User,
} from '@/lib/authStore'

const USERS_FILE = join(TMP_DATA_DIR, 'users.json')

function writeRaw(records: unknown[]): void {
  writeFileSync(USERS_FILE, JSON.stringify(records, null, 2), 'utf-8')
}

function readRaw(): unknown[] {
  return JSON.parse(readFileSync(USERS_FILE, 'utf-8'))
}

beforeEach(() => {
  // Clean slate: remove the store file before each test so getUsers() re-seeds
  // or we can plant a legacy file.
  if (existsSync(USERS_FILE)) rmSync(USERS_FILE)
})

afterAll(() => {
  rmSync(TMP_DATA_DIR, { recursive: true, force: true })
})

describe('legacy single-org migration (backward compatibility)', () => {
  const legacy = {
    id: 'legacy-1',
    email: 'legacy@ceiba-healthcare.com',
    passwordHash: 'hash',
    role: 'analyst',
    orgId: 'org-ceiba',
    name: 'Legacy User',
    createdAt: '2025-01-01T00:00:00.000Z',
  }

  it('upgrades a legacy record to a one-membership user with identical resolved session', () => {
    writeRaw([legacy])
    const users = getUsers()
    const user = users.find((u) => u.id === 'legacy-1')!

    expect(user.memberships).toEqual([{ orgId: 'org-ceiba', role: 'analyst' }])
    expect(user.defaultOrgId).toBe('org-ceiba')
    // The resolved active org + role are byte-identical to the old orgId/role.
    expect(resolveActiveOrg(user)).toBe('org-ceiba')
    expect(roleInOrg(user, 'org-ceiba')).toBe('analyst')
    // Preserved fields untouched.
    expect(user.email).toBe(legacy.email)
    expect(user.createdAt).toBe(legacy.createdAt)
  })

  it('writes the migrated shape back to disk once', () => {
    writeRaw([legacy])
    getUsers() // triggers migration + write-back
    const onDisk = readRaw() as User[]
    expect(Array.isArray(onDisk[0].memberships)).toBe(true)
    expect(onDisk[0]).not.toHaveProperty('role')
    expect(onDisk[0]).not.toHaveProperty('orgId')
  })

  it('is idempotent — a second read of an already-migrated file does not rewrite', () => {
    writeRaw([legacy])
    getUsers()
    const firstBytes = readFileSync(USERS_FILE, 'utf-8')
    // Second read: everything is already migrated → no mutation → identical bytes.
    getUsers()
    const secondBytes = readFileSync(USERS_FILE, 'utf-8')
    expect(secondBytes).toBe(firstBytes)
  })
})

describe('seed users (multi-org path exercised from day one)', () => {
  it('seeds a cross-org consultant with two memberships and differing roles', () => {
    getUsers() // seeds from empty
    const consultant = findUserByEmail('consultant@ceiba-healthcare.com')!
    expect(consultant.memberships).toHaveLength(2)
    expect(roleInOrg(consultant, 'org-ceiba')).toBe('admin')
    expect(roleInOrg(consultant, 'org-demo')).toBe('analyst')
    expect(consultant.defaultOrgId).toBe('org-ceiba')
  })

  it('single-org seed users keep exactly one membership', () => {
    getUsers()
    const admin = findUserByEmail('admin@ceiba-healthcare.com')!
    expect(admin.memberships).toEqual([{ orgId: 'org-ceiba', role: 'admin' }])
  })
})

describe('membership helpers', () => {
  it('isMemberOf / roleInOrg respect the boundary', () => {
    getUsers()
    const consultant = findUserByEmail('consultant@ceiba-healthcare.com')!
    expect(isMemberOf(consultant, 'org-ceiba')).toBe(true)
    expect(isMemberOf(consultant, 'org-demo')).toBe(true)
    expect(isMemberOf(consultant, 'org-nope')).toBe(false)
    expect(roleInOrg(consultant, 'org-nope')).toBeNull()
  })

  it('resolveActiveOrg never returns a non-member org', () => {
    getUsers()
    const single = findUserByEmail('admin@ceiba-healthcare.com')!
    // preferred is not a member → falls through to default/first (member) org.
    expect(resolveActiveOrg(single, 'org-demo')).toBe('org-ceiba')
    const consultant = findUserByEmail('consultant@ceiba-healthcare.com')!
    // preferred IS a member → honoured.
    expect(resolveActiveOrg(consultant, 'org-demo')).toBe('org-demo')
  })

  it('grantMembership adds a new org membership and is idempotent on role update', () => {
    getUsers()
    const analyst = findUserByEmail('analyst@ceiba-healthcare.com')!
    const granted = grantMembership(analyst.id, 'org-demo', 'clinician')!
    expect(granted.memberships).toContainEqual({ orgId: 'org-demo', role: 'clinician' })
    // Re-grant with a different role updates in place (no duplicate org).
    const regranted = grantMembership(analyst.id, 'org-demo', 'analyst')!
    const demo = regranted.memberships.filter((m) => m.orgId === 'org-demo')
    expect(demo).toEqual([{ orgId: 'org-demo', role: 'analyst' }])
  })

  it('revokeMembership refuses to remove the last membership', () => {
    getUsers()
    const admin = findUserByEmail('admin@ceiba-healthcare.com')!
    expect(revokeMembership(admin.id, 'org-ceiba')).toBeNull() // last one → refused
    // Still a member afterwards.
    const stillThere = findUserByEmail('admin@ceiba-healthcare.com')!
    expect(isMemberOf(stillThere, 'org-ceiba')).toBe(true)
  })

  it('revokeMembership removes a non-last membership and repoints defaultOrgId', () => {
    getUsers()
    const consultant = findUserByEmail('consultant@ceiba-healthcare.com')!
    // default is org-ceiba; revoke it → default repoints to the remaining org.
    const after = revokeMembership(consultant.id, 'org-ceiba')!
    expect(after.memberships).toEqual([{ orgId: 'org-demo', role: 'analyst' }])
    expect(after.defaultOrgId).toBe('org-demo')
  })

  it('setDefaultOrg persists last-active and ignores non-member orgs', () => {
    getUsers()
    const consultant = findUserByEmail('consultant@ceiba-healthcare.com')!
    setDefaultOrg(consultant.id, 'org-demo')
    expect(findUserByEmail('consultant@ceiba-healthcare.com')!.defaultOrgId).toBe('org-demo')
    // Non-member → no-op.
    setDefaultOrg(consultant.id, 'org-nope')
    expect(findUserByEmail('consultant@ceiba-healthcare.com')!.defaultOrgId).toBe('org-demo')
  })

  it('toPublicUser strips the password hash and carries memberships', () => {
    getUsers()
    const consultant = findUserByEmail('consultant@ceiba-healthcare.com')!
    const pub = toPublicUser(consultant)
    expect(pub).not.toHaveProperty('passwordHash')
    expect(pub.memberships).toHaveLength(2)
    expect(pub.defaultOrgId).toBe('org-ceiba')
  })
})
