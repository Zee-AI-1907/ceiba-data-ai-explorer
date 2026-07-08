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
 * ── Org / tenant model ──────────────────────────────────────────────────────
 * Every user belongs to exactly one organisation (`orgId`). The orgId is the
 * tenant key: it is carried in every Session and other Phase-1 workstreams
 * scope data by `orgId` (+ owner). Orgs are implicit — an org "exists" because
 * one or more users reference its id. To add an org, add users with a new
 * `orgId` (see ORG_REGISTRY below for human-readable names). There is no
 * separate orgs table for this interim implementation.
 */

import fs from 'fs'
import path from 'path'
import { randomUUID } from 'crypto'
import bcrypt from 'bcryptjs'
import type { Role } from './permissions'

// ── Types ──────────────────────────────────────────────────────────────────

export type User = {
  id: string
  email: string
  /** bcrypt hash — never a plaintext password. */
  passwordHash: string
  role: Role
  /** Tenant key. Every user belongs to exactly one org. */
  orgId: string
  name: string
  createdAt: string
}

/** User shape safe to expose to clients (no passwordHash). */
export type PublicUser = {
  id: string
  email: string
  role: Role
  orgId: string
  name: string
}

/** Human-readable org registry (display-only; the source of truth is user.orgId). */
export const ORG_REGISTRY: Record<string, string> = {
  'org-ceiba': 'Ceiba Healthcare',
  'org-demo': 'Demo Hospital',
}

// ── File path (gitignored `data/` dir) ───────────────────────────────────────

const DATA_DIR = path.join(process.cwd(), 'data')
const USERS_FILE = path.join(DATA_DIR, 'users.json')

function ensureDataDir(): void {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true })
  }
}

// ── Seed configuration ───────────────────────────────────────────────────────
//
// Seed users span 2 orgs so tenant isolation can be tested. Passwords come from
// AUTH_SEED_PASSWORD if set, otherwise a DEV-ONLY default that is clearly not a
// real secret. This is fine because the users.json file is gitignored and this
// is an interim dev/staging auth — production should set AUTH_SEED_PASSWORD and
// rotate seeded users.
const DEV_SEED_PASSWORD = 'ChangeMe!DevSeed2026'

function seedPassword(): string {
  return process.env.AUTH_SEED_PASSWORD || DEV_SEED_PASSWORD
}

type SeedSpec = { email: string; name: string; role: Role; orgId: string }

const SEED_USERS: SeedSpec[] = [
  // Org 1 — Ceiba Healthcare
  { email: 'admin@ceiba-healthcare.com',     name: 'Ceiba Admin',      role: 'admin',     orgId: 'org-ceiba' },
  { email: 'analyst@ceiba-healthcare.com',   name: 'Ceiba Analyst',    role: 'analyst',   orgId: 'org-ceiba' },
  { email: 'clinician@ceiba-healthcare.com', name: 'Ceiba Clinician',  role: 'clinician', orgId: 'org-ceiba' },
  // Org 2 — Demo Hospital (for tenant-isolation testing)
  { email: 'admin@demo-hospital.test',       name: 'Demo Admin',       role: 'admin',     orgId: 'org-demo' },
  { email: 'clinician@demo-hospital.test',   name: 'Demo Clinician',   role: 'clinician', orgId: 'org-demo' },
]

// ── Read / write ─────────────────────────────────────────────────────────────

function readAll(): User[] {
  ensureDataDir()
  if (!fs.existsSync(USERS_FILE)) return []
  try {
    return JSON.parse(fs.readFileSync(USERS_FILE, 'utf-8')) as User[]
  } catch {
    return []
  }
}

function writeAll(users: User[]): void {
  ensureDataDir()
  fs.writeFileSync(USERS_FILE, JSON.stringify(users, null, 2), 'utf-8')
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
    role: spec.role,
    orgId: spec.orgId,
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

export function findUserById(id: string): User | null {
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

/**
 * Add a new user (admin-invite / user-create flow). Hashes the password.
 * Throws if the email already exists.
 */
export function addUser(input: {
  email: string
  password: string
  role: Role
  orgId: string
  name: string
}): PublicUser {
  const users = getUsers()
  const email = input.email.trim().toLowerCase()
  if (users.some((u) => u.email === email)) {
    throw new Error(`User with email '${email}' already exists`)
  }
  const user: User = {
    id: randomUUID(),
    email,
    passwordHash: bcrypt.hashSync(input.password, 10),
    role: input.role,
    orgId: input.orgId,
    name: input.name,
    createdAt: new Date().toISOString(),
  }
  users.push(user)
  writeAll(users)
  return toPublicUser(user)
}

export function toPublicUser(user: User): PublicUser {
  return {
    id: user.id,
    email: user.email,
    role: user.role,
    orgId: user.orgId,
    name: user.name,
  }
}
