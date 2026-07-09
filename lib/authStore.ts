/**
 * authStore.ts — Local user + organization (tenant) store.
 *
 * INTERIM AUTH (Phase 1 remediation, Workstream AUTH).
 * Replaces Clerk with a self-contained, flat-file, RBAC + multi-tenant store.
 * A later milestone may reintroduce a managed IdP (Clerk); this module is
 * intentionally small and well-typed so it can be swapped out cleanly.
 *
 * SERVER-ONLY. Never import from a client component — it reads bcrypt hashes
 * off disk. The file lives under `data/` which is gitignored (holds credentials).
 *
 * ── Org / tenant model (MULTI-ORG) ───────────────────────────────────────────
 * A user may belong to MULTIPLE organisations via `memberships` — a list of
 * `{ orgId, role }` pairs. A user always has ≥1 membership. At any moment the
 * user operates with exactly ONE ACTIVE org (chosen at login / switched at
 * runtime). The active org's id is the tenant key carried in every Session:
 * downstream scoping code (repository, cache, audit) still reads a single
 * `session.orgId`. Multi-org only changes HOW that key is chosen — it becomes
 * the active membership's org, and `session.role` becomes the role in THAT org.
 *
 * `defaultOrgId` records the last-active org so a returning user lands where
 * they left off. Orgs remain implicit — an org "exists" because a membership
 * references its id; ORG_REGISTRY holds human-readable display names.
 */

import fs from 'fs'
import path from 'path'
import { randomUUID } from 'crypto'
import bcrypt from 'bcryptjs'
import type { Role } from './permissions'

// ── Types ──────────────────────────────────────────────────────────────────

/** A user's role within one org. Role may differ per org. */
export type Membership = {
  orgId: string
  role: Role
}

export type User = {
  id: string
  email: string
  /** bcrypt hash — never a plaintext password. */
  passwordHash: string
  /** One or more org memberships. MUST contain ≥1 entry. */
  memberships: Membership[]
  /**
   * The org selected at login when the user does not pick one. Falls back to
   * memberships[0].orgId if unset/stale. Updated to the last-switched org so a
   * returning user lands where they left off ("last-active").
   */
  defaultOrgId: string
  name: string
  createdAt: string
}

/** Client-safe shape (no passwordHash). Drives the UI org-switcher. */
export type PublicUser = {
  id: string
  email: string
  name: string
  /** [{orgId, role}, ...] — powers the switcher. */
  memberships: Membership[]
  defaultOrgId: string
}

/** Human-readable org registry (display-only; the source of truth is memberships). */
export const ORG_REGISTRY: Record<string, string> = {
  'org-ceiba': 'Ceiba Healthcare',
  'org-demo': 'Demo Hospital',
}

// ── File path (gitignored `data/` dir) ───────────────────────────────────────

/**
 * Data directory. Defaults to `<cwd>/data` (gitignored). Resolved per-call so a
 * test can redirect it via CEIBA_AUTH_DATA_DIR without the value being frozen at
 * module load (mirrors repository.ts's CEIBA_DATA_DIR seam).
 */
function dataDir(): string {
  return process.env.CEIBA_AUTH_DATA_DIR || path.join(process.cwd(), 'data')
}

function usersFile(): string {
  return path.join(dataDir(), 'users.json')
}

function ensureDataDir(): void {
  const dir = dataDir()
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true })
  }
}

// ── Seed configuration ───────────────────────────────────────────────────────
//
// Seed users span 2 orgs so tenant isolation can be tested. One seed user is a
// cross-org CONSULTANT (admin in org-ceiba, analyst in org-demo) so the
// multi-org path is exercised from day one. Passwords come from
// AUTH_SEED_PASSWORD if set, otherwise a DEV-ONLY default that is clearly not a
// real secret. This is fine because the users.json file is gitignored and this
// is an interim dev/staging auth — production should set AUTH_SEED_PASSWORD and
// rotate seeded users.
const DEV_SEED_PASSWORD = 'ChangeMe!DevSeed2026'

function seedPassword(): string {
  return process.env.AUTH_SEED_PASSWORD || DEV_SEED_PASSWORD
}

type SeedSpec = {
  email: string
  name: string
  memberships: Membership[]
  defaultOrgId: string
}

const SEED_USERS: SeedSpec[] = [
  // Org 1 — Ceiba Healthcare (single-org users)
  { email: 'admin@ceiba-healthcare.com',     name: 'Ceiba Admin',      memberships: [{ orgId: 'org-ceiba', role: 'admin' }],     defaultOrgId: 'org-ceiba' },
  { email: 'analyst@ceiba-healthcare.com',   name: 'Ceiba Analyst',    memberships: [{ orgId: 'org-ceiba', role: 'analyst' }],   defaultOrgId: 'org-ceiba' },
  { email: 'clinician@ceiba-healthcare.com', name: 'Ceiba Clinician',  memberships: [{ orgId: 'org-ceiba', role: 'clinician' }], defaultOrgId: 'org-ceiba' },
  // Org 2 — Demo Hospital (single-org users, for tenant-isolation testing)
  { email: 'admin@demo-hospital.test',       name: 'Demo Admin',       memberships: [{ orgId: 'org-demo', role: 'admin' }],      defaultOrgId: 'org-demo' },
  { email: 'clinician@demo-hospital.test',   name: 'Demo Clinician',   memberships: [{ orgId: 'org-demo', role: 'clinician' }],  defaultOrgId: 'org-demo' },
  // MULTI-ORG consultant — admin in Ceiba, analyst in Demo. Exercises switching,
  // per-org role differences, and the same-org grant rule from day one.
  {
    email: 'consultant@ceiba-healthcare.com',
    name: 'Cross-Org Consultant',
    memberships: [
      { orgId: 'org-ceiba', role: 'admin' },
      { orgId: 'org-demo',  role: 'analyst' },
    ],
    defaultOrgId: 'org-ceiba',
  },
]

// ── Migration ──────────────────────────────────────────────────────────────
//
// Legacy records are single-org: `{ ..., role, orgId, ... }`. Migration is
// idempotent and lazy — run inside readAll() on first read after deploy, so it
// is invisible to callers. A migrated record's ONLY membership equals its old
// { orgId, role }, and defaultOrgId equals its old orgId, so its resolved
// session is byte-identical to before.

/** Legacy on-disk shape (pre multi-org). */
type LegacyUser = {
  id: string
  email: string
  passwordHash: string
  role: Role
  orgId: string
  name: string
  createdAt: string
}

/**
 * True iff a raw record is a usable multi-org User: it has a non-empty
 * `memberships` array in which every entry has a truthy orgId AND role, and a
 * truthy defaultOrgId. Records that fail this are corrupt and are quarantined
 * (dropped + warned) rather than served as a broken principal.
 */
function isValidUser(record: unknown): record is User {
  if (!record || typeof record !== 'object') return false
  const u = record as Partial<User>
  if (typeof u.id !== 'string' || !u.id) return false
  if (typeof u.defaultOrgId !== 'string' || !u.defaultOrgId) return false
  if (!Array.isArray(u.memberships) || u.memberships.length === 0) return false
  return u.memberships.every(
    (m) =>
      m !== null &&
      m !== undefined &&
      typeof m.orgId === 'string' &&
      m.orgId.length > 0 &&
      typeof m.role === 'string' &&
      m.role.length > 0
  )
}

/**
 * Normalise one raw legacy record to the multi-org User shape. Returns null if
 * the legacy record lacks the truthy orgId/role needed to build a valid single
 * membership (caller quarantines it) — this prevents producing a corrupt
 * `memberships: [{orgId: undefined, role: undefined}]` user.
 */
function migrateLegacyRecord(legacy: LegacyUser): User | null {
  if (!legacy.orgId || !legacy.role) return null
  const migrated: User = {
    id: legacy.id,
    email: legacy.email,
    passwordHash: legacy.passwordHash,
    memberships: [{ orgId: legacy.orgId, role: legacy.role }],
    defaultOrgId: legacy.orgId,
    name: legacy.name,
    createdAt: legacy.createdAt,
  }
  return isValidUser(migrated) ? migrated : null
}

// ── Read / write ─────────────────────────────────────────────────────────────

/**
 * Read all users, migrating any legacy single-org records on the fly and
 * QUARANTINING any record that is malformed (missing/empty memberships, or a
 * membership missing orgId/role). Quarantined records are dropped from the
 * served set and console.warn'd — a corrupt record must never surface as a
 * broken principal (which would produce a silent 401 loop or, worse, an
 * unscoped session). If the served set differs from disk (a legacy record was
 * migrated OR a corrupt record was dropped), the cleaned array is written back
 * ONCE so subsequent reads short-circuit.
 */
function readAll(): User[] {
  ensureDataDir()
  const file = usersFile()
  if (!fs.existsSync(file)) return []
  let raw: Array<User | LegacyUser>
  try {
    raw = JSON.parse(fs.readFileSync(file, 'utf-8')) as Array<User | LegacyUser>
  } catch {
    return []
  }
  if (!Array.isArray(raw)) return []

  let mutated = false
  const cleaned: User[] = []
  for (const record of raw) {
    // Already-migrated record: keep only if it validates; else quarantine.
    if (Array.isArray((record as User).memberships)) {
      if (isValidUser(record)) {
        cleaned.push(record as User)
      } else {
        mutated = true
        console.warn(
          `[authStore] Quarantined malformed user record (invalid/empty memberships): id=${
            (record as Partial<User>).id ?? 'unknown'
          }`
        )
      }
      continue
    }
    // Legacy single-org record: migrate + validate; quarantine if unmigratable.
    mutated = true
    const migrated = migrateLegacyRecord(record as LegacyUser)
    if (migrated) {
      cleaned.push(migrated)
    } else {
      console.warn(
        `[authStore] Quarantined malformed legacy user record (missing orgId/role): id=${
          (record as Partial<LegacyUser>).id ?? 'unknown'
        }`
      )
    }
  }

  // Write-back-once: persist the cleaned shape the first time a legacy record is
  // migrated OR a corrupt record is dropped. Guarded by `mutated` so a fully
  // valid, already-migrated read never rewrites.
  if (mutated) {
    writeAll(cleaned)
  }
  return cleaned
}

/**
 * Persist the full user set ATOMICALLY: write to a unique temp file then rename
 * over the target. rename(2) is atomic on POSIX, so a crash mid-write can never
 * truncate/corrupt users.json — a reader sees either the old file or the new one
 * in full. This mirrors repository.ts's writeAll (the data-scoping seam) so both
 * flat-file stores share the same durability guarantee.
 */
function writeAll(users: User[]): void {
  ensureDataDir()
  const target = usersFile()
  const tmp = `${target}.${randomUUID()}.tmp`
  fs.writeFileSync(tmp, JSON.stringify(users, null, 2), 'utf-8')
  fs.renameSync(tmp, target)
}

/**
 * Serialize a read-modify-write mutation of the user store so concurrent admin
 * actions (grant/revoke/setDefault/addUser) cannot lost-update each other.
 *
 * Node is single-threaded and these mutators are fully SYNCHRONOUS (no `await`
 * between the read and the write), so within one process JS run-to-completion
 * already makes each mutation an indivisible critical section — one cannot
 * observe another's partial state, and a REVOKE can never be silently dropped by
 * a concurrent GRANT. This wrapper makes that invariant explicit and gives us a
 * single place to add cross-process locking (e.g. flock / advisory lock) when
 * this store moves off a single Node process. It MUST stay synchronous — adding
 * an `await` inside `mutator` would reintroduce the interleaving hazard.
 */
function withStoreMutation<T>(mutator: () => T): T {
  return mutator()
}

/**
 * Ensure the store is seeded on first use. Idempotent: only seeds when the
 * file is empty / missing. Safe to call before every read.
 */
function ensureSeeded(): User[] {
  const existing = readAll()
  if (existing.length > 0) return existing

  const now = new Date().toISOString()
  const pw = seedPassword()
  const hash = bcrypt.hashSync(pw, 10)
  const seeded: User[] = SEED_USERS.map((spec) => ({
    id: randomUUID(),
    email: spec.email.toLowerCase(),
    passwordHash: hash,
    memberships: spec.memberships.map((m) => ({ ...m })),
    defaultOrgId: spec.defaultOrgId,
    name: spec.name,
    createdAt: now,
  }))
  writeAll(seeded)
  return seeded
}

// ── Public API ───────────────────────────────────────────────────────────────

export function getUsers(): User[] {
  return ensureSeeded()
}

/**
 * TEST-ONLY resolver override. When set, findUserById consults it FIRST so unit
 * tests that forge signed sessions (route handler tests) can make their synthetic
 * principal resolvable by `requireAuthWithPermission`'s live-role re-resolution
 * (Section 2.3 of the multi-org plan) without touching the on-disk store. Never
 * set in production code paths. `__setUserResolverForTest(null)` clears it.
 */
let testUserResolver: ((id: string) => User | null) | null = null

export function __setUserResolverForTest(resolver: ((id: string) => User | null) | null): void {
  // Hard production guard: this seam lets a caller inject an attacker-chosen
  // principal (total auth bypass). It must NEVER be reachable in production.
  if (process.env.NODE_ENV === 'production') {
    throw new Error('__setUserResolverForTest is not available in production')
  }
  testUserResolver = resolver
}

export function findUserById(id: string): User | null {
  // Never consult the test resolver in production, even if one was somehow set —
  // defence-in-depth against the auth-bypass seam (P2-1).
  if (testUserResolver && process.env.NODE_ENV !== 'production') {
    const resolved = testUserResolver(id)
    if (resolved) return resolved
  }
  return getUsers().find((u) => u.id === id) ?? null
}

export function findUserByEmail(email: string): User | null {
  const target = email.trim().toLowerCase()
  return getUsers().find((u) => u.email === target) ?? null
}

/**
 * Verify an email + plaintext password against the store.
 * Returns the User on success, null on any failure (unknown email or bad pw).
 */
export function verifyCredentials(email: string, password: string): User | null {
  const user = findUserByEmail(email)
  if (!user) return null
  const ok = bcrypt.compareSync(password, user.passwordHash)
  return ok ? user : null
}

// ── Membership helpers (the membership-boundary primitives) ──────────────────

/** True iff the user has a membership in orgId. The membership-boundary check. */
export function isMemberOf(user: User, orgId: string): boolean {
  return user.memberships.some((m) => m.orgId === orgId)
}

/** Resolve the role of a user in a given org, or null if not a member. */
export function roleInOrg(user: User, orgId: string): Role | null {
  return user.memberships.find((m) => m.orgId === orgId)?.role ?? null
}

/**
 * Thrown when a user with zero memberships reaches org resolution. A valid User
 * always has ≥1 membership (enforced at load/migrate time), so this indicates a
 * corrupt record slipped through; the login route maps it to a clean 500 rather
 * than letting an index-out-of-bounds TypeError escape.
 */
export class NoMembershipError extends Error {
  constructor(userId: string) {
    super(`User '${userId}' has no memberships — cannot resolve an active org`)
    this.name = 'NoMembershipError'
  }
}

/**
 * Choose the active org at login: preferred (if a member), else defaultOrgId
 * (if still a member), else the first membership. NEVER returns an org the
 * user is not a member of — this is a session-issuance isolation boundary.
 *
 * Defensive: a User should always carry ≥1 membership (validated on load), but
 * if an empty-memberships record ever reaches here we throw a typed
 * NoMembershipError instead of indexing `memberships[0]` (TypeError).
 */
export function resolveActiveOrg(user: User, preferred?: string): string {
  if (preferred && isMemberOf(user, preferred)) return preferred
  if (isMemberOf(user, user.defaultOrgId)) return user.defaultOrgId
  const first = user.memberships[0]
  if (!first) throw new NoMembershipError(user.id)
  return first.orgId
}

/**
 * Add or update a membership (admin provisioning). Idempotent on orgId: if a
 * membership for that org already exists, its role is updated. Returns the
 * updated PublicUser, or null if the user does not exist.
 */
export function grantMembership(userId: string, orgId: string, role: Role): PublicUser | null {
  return withStoreMutation(() => {
    const users = getUsers()
    const idx = users.findIndex((u) => u.id === userId)
    if (idx === -1) return null
    const user = users[idx]
    const existing = user.memberships.find((m) => m.orgId === orgId)
    if (existing) {
      existing.role = role
    } else {
      user.memberships.push({ orgId, role })
    }
    writeAll(users)
    return toPublicUser(user)
  })
}

/**
 * Remove a membership. Refuses to remove the last one (a user must keep ≥1) —
 * returns null in that case. Returns null too if the user or membership does
 * not exist. If the removed org was the defaultOrgId, defaultOrgId is repointed
 * to the first remaining membership.
 */
export function revokeMembership(userId: string, orgId: string): PublicUser | null {
  return withStoreMutation(() => {
    const users = getUsers()
    const idx = users.findIndex((u) => u.id === userId)
    if (idx === -1) return null
    const user = users[idx]
    if (!user.memberships.some((m) => m.orgId === orgId)) return null
    // Refuse to remove the last membership — a user must always keep ≥1.
    if (user.memberships.length <= 1) return null
    user.memberships = user.memberships.filter((m) => m.orgId !== orgId)
    if (user.defaultOrgId === orgId) {
      user.defaultOrgId = user.memberships[0].orgId
    }
    writeAll(users)
    return toPublicUser(user)
  })
}

/** Persist last-active org after a switch. No-op if not a member (defence-in-depth). */
export function setDefaultOrg(userId: string, orgId: string): void {
  withStoreMutation(() => {
    const users = getUsers()
    const idx = users.findIndex((u) => u.id === userId)
    if (idx === -1) return
    const user = users[idx]
    if (!isMemberOf(user, orgId)) return
    if (user.defaultOrgId === orgId) return
    user.defaultOrgId = orgId
    writeAll(users)
  })
}

/**
 * Add a new user (admin-invite / user-create flow). Hashes the password and
 * seeds the user with a SINGLE initial membership. Throws if the email already
 * exists. Adding further orgs to an existing user is done via grantMembership.
 */
export function addUser(input: {
  email: string
  password: string
  name: string
  membership: Membership
}): PublicUser {
  return withStoreMutation(() => {
    const users = getUsers()
    const email = input.email.trim().toLowerCase()
    if (users.some((u) => u.email === email)) {
      throw new Error(`User with email '${email}' already exists`)
    }
    const user: User = {
      id: randomUUID(),
      email,
      passwordHash: bcrypt.hashSync(input.password, 10),
      memberships: [{ orgId: input.membership.orgId, role: input.membership.role }],
      defaultOrgId: input.membership.orgId,
      name: input.name,
      createdAt: new Date().toISOString(),
    }
    users.push(user)
    writeAll(users)
    return toPublicUser(user)
  })
}

export function toPublicUser(user: User): PublicUser {
  return {
    id: user.id,
    email: user.email,
    name: user.name,
    memberships: user.memberships.map((m) => ({ ...m })),
    defaultOrgId: user.defaultOrgId,
  }
}
