/**
 * auditLog.ts — Server-side append-only PHI access audit logger.
 *
 * H-007: Tamper-evident hash chaining.
 *   Each entry carries:
 *     previousHash — SHA-256 hash of the previous raw JSON line
 *                    (genesis entry uses '0'.repeat(64))
 *     hash         — SHA-256 of (previousHash + JSON.stringify(entryWithoutHash))
 *
 * IMPORTANT: This module is SERVER-ONLY. Never import it in client components.
 */

import fs from 'fs'
import path from 'path'
import crypto from 'crypto'
import { getSession } from '@/lib/apiAuth'
import { findUserById } from '@/lib/authStore'

// ── Types ─────────────────────────────────────────────────────────────────────

export type AuditAction =
  | 'QUERY_RUN'
  | 'DATA_EXPORT_CSV'
  | 'DATA_EXPORT_EXCEL'
  | 'DATA_VIEW'
  | 'LOGIN'
  | 'LOGOUT'
  | 'LOGIN_FAILED'
  | 'QUERY_FAILED'
  | 'NARRATIVE_GENERATED'
  | 'USER_CREATED'          // admin created a user (was overloaded onto LOGIN)
  | 'ORG_SWITCH'            // user switched their active org
  | 'MEMBERSHIP_GRANTED'    // admin granted a user a membership in the active org
  | 'MEMBERSHIP_REVOKED'    // admin revoked a user's membership in the active org

export type AuditResourceType =
  | 'patient_data'
  | 'query'
  | 'dashboard'
  | 'chart'
  | 'auth'
  | 'export'

export type AuditSeverity = 'INFO' | 'WARNING' | 'CRITICAL'

export type AuditEvent = {
  id: string
  timestamp: string         // ISO 8601
  userId: string            // from session (or 'anonymous')
  /**
   * Tenant key from the session (AR1/H1). Optional at the type level for
   * backward-compat: log lines written before org-scoping have no orgId and are
   * normalised to '' ('legacy') on read — see readAllEvents(). New writes always
   * populate it via logWithSession (or an explicit orgId on logAuditEvent).
   */
  orgId: string
  userEmail: string
  action: AuditAction
  resourceType: AuditResourceType
  detail: string            // e.g. "SQL query executed: SELECT * FROM Patients..."
  rowsAffected?: number     // rows returned
  ipAddress?: string
  userAgent?: string
  sessionId?: string
  severity: AuditSeverity
  /** SHA-256 hash of the previous log line (genesis = '0'.repeat(64)) */
  previousHash: string
  /** SHA-256 of (previousHash + JSON.stringify(entryWithoutHash)) */
  hash: string
}

// ── Log file path ─────────────────────────────────────────────────────────────

const LOG_DIR = path.join(process.cwd(), 'logs')
const LOG_FILE = path.join(LOG_DIR, 'audit.log')

function ensureLogDir(): void {
  if (!fs.existsSync(LOG_DIR)) {
    fs.mkdirSync(LOG_DIR, { recursive: true })
  }
}

// ── Hash helpers ──────────────────────────────────────────────────────────────

const GENESIS_HASH = '0'.repeat(64)

function sha256(data: string): string {
  return crypto.createHash('sha256').update(data, 'utf8').digest('hex')
}

/**
 * Compute the tamper-chain hash for an entry.
 * entryWithoutHash = the full event object minus the `hash` field.
 */
function computeEntryHash(
  previousHash: string,
  entryWithoutHash: Omit<AuditEvent, 'hash'>,
): string {
  return sha256(previousHash + JSON.stringify(entryWithoutHash))
}

/**
 * Read the last non-empty line and return its sha256 hash.
 * Returns GENESIS_HASH if the file is empty or does not exist.
 */
function getLastLineHash(): string {
  try {
    ensureLogDir()
    if (!fs.existsSync(LOG_FILE)) return GENESIS_HASH
    const content = fs.readFileSync(LOG_FILE, 'utf8')
    const lines = content.split('\n').filter((l) => l.trim())
    if (lines.length === 0) return GENESIS_HASH
    const lastLine = lines[lines.length - 1]
    return sha256(lastLine)
  } catch {
    return GENESIS_HASH
  }
}

// ── Write ─────────────────────────────────────────────────────────────────────

/**
 * logWithSession — Preferred audit helper.
 * Extracts userId, userEmail, ipAddress, and userAgent from the incoming
 * request and the current local session, then calls logAuditEvent.
 */
export async function logWithSession(
  request: Request,
  event: Omit<AuditEvent, 'id' | 'timestamp' | 'userId' | 'orgId' | 'userEmail' | 'ipAddress' | 'userAgent' | 'previousHash' | 'hash'>
): Promise<void> {
  const session = await getSession(request)
  const user = session ? findUserById(session.userId) : null
  const email = user?.email ?? 'unknown'
  const forwarded = request.headers.get('x-forwarded-for')
  const ip = forwarded?.split(',')[0]?.trim() ?? request.headers.get('x-real-ip') ?? 'unknown'
  const userAgent = request.headers.get('user-agent') ?? undefined
  logAuditEvent({
    ...event,
    userId: session?.userId ?? 'unauthenticated',
    // Stamp the tenant key from the session (AR1/H1) so the audit route can scope.
    orgId: session?.orgId ?? '',
    userEmail: email,
    ipAddress: ip,
    userAgent,
  })
}

/**
 * Append a single audit event to audit.log (JSON-lines format) with
 * tamper-evident hash chaining.
 */
export function logAuditEvent(
  // orgId is optional here for backward-compat: callers that pass identity
  // explicitly (auth routes) SHOULD supply orgId; older/egress callers that omit
  // it are normalised to '' below. logWithSession always supplies it.
  event: Omit<AuditEvent, 'id' | 'timestamp' | 'orgId' | 'previousHash' | 'hash'> & { orgId?: string }
): void {
  try {
    ensureLogDir()

    const previousHash = getLastLineHash()

    // Build event without hash first
    const withoutHash: Omit<AuditEvent, 'hash'> = {
      ...event,
      orgId: event.orgId ?? '',
      id: crypto.randomUUID(),
      timestamp: new Date().toISOString(),
      previousHash,
    }

    const hash = computeEntryHash(previousHash, withoutHash)

    const fullEvent: AuditEvent = { ...withoutHash, hash }
    const line = JSON.stringify(fullEvent) + '\n'
    fs.appendFileSync(LOG_FILE, line, 'utf8')
  } catch (err) {
    // Log errors should never crash the application
    console.error('[auditLog] Failed to write audit event:', err)
  }
}

// ── Read ──────────────────────────────────────────────────────────────────────

/**
 * Read all lines from the log file and return parsed events.
 */
function readAllEvents(): AuditEvent[] {
  try {
    ensureLogDir()
    if (!fs.existsSync(LOG_FILE)) return []
    const content = fs.readFileSync(LOG_FILE, 'utf8')
    const lines = content.split('\n').filter((l) => l.trim())
    const events: AuditEvent[] = []
    for (const line of lines) {
      try {
        const parsed = JSON.parse(line) as AuditEvent
        // Backward-compat: pre-org-scoping lines have no orgId. Normalise to ''
        // (treated as 'legacy') so old records neither crash nor leak across orgs.
        if (typeof parsed.orgId !== 'string') parsed.orgId = ''
        events.push(parsed)
      } catch {
        // Skip malformed lines
      }
    }
    return events
  } catch {
    return []
  }
}

/**
 * Return the N most-recent audit events (default 500).
 *
 * When `orgId` is provided, events are filtered to that tenant BEFORE the cap is
 * applied, so a caller always gets up to N of *their own* org's events (AR1/H1) —
 * not N global events that may all belong to other orgs. Pass undefined only for
 * trusted, non-tenant-scoped callers.
 */
export function getRecentAuditEvents(limit = 500, orgId?: string): AuditEvent[] {
  let all = readAllEvents()
  if (orgId !== undefined) {
    all = all.filter((e) => e.orgId === orgId)
  }
  return all.slice(-limit).reverse()
}

export type AuditLogFilters = {
  userId?: string
  action?: AuditAction
  severity?: AuditSeverity
  resourceType?: AuditResourceType
  since?: Date
  until?: Date
}

/**
 * Filter audit events by structured filters object.
 */
export function searchAuditLog(filters: AuditLogFilters = {}): AuditEvent[] {
  let events = readAllEvents()

  if (filters.userId) {
    events = events.filter((e) => e.userId === filters.userId)
  }
  if (filters.action) {
    events = events.filter((e) => e.action === filters.action)
  }
  if (filters.severity) {
    events = events.filter((e) => e.severity === filters.severity)
  }
  if (filters.resourceType) {
    events = events.filter((e) => e.resourceType === filters.resourceType)
  }
  if (filters.since) {
    const sinceMs = filters.since.getTime()
    events = events.filter((e) => new Date(e.timestamp).getTime() >= sinceMs)
  }
  if (filters.until) {
    const untilMs = filters.until.getTime()
    events = events.filter((e) => new Date(e.timestamp).getTime() <= untilMs)
  }

  return events.reverse()
}

// ── Integrity verification ────────────────────────────────────────────────────

export type IntegrityResult = {
  valid: boolean
  tamperedAt?: number
  totalEntries: number
}

/**
 * Verify the full audit log chain.
 * Re-derives each entry's expected hash and confirms it matches the stored hash.
 * Also verifies each entry's previousHash matches the SHA-256 of the prior raw line.
 */
export function verifyAuditLogIntegrity(): IntegrityResult {
  try {
    ensureLogDir()
    if (!fs.existsSync(LOG_FILE)) {
      return { valid: true, totalEntries: 0 }
    }

    const content = fs.readFileSync(LOG_FILE, 'utf8')
    const lines = content.split('\n').filter((l) => l.trim())

    if (lines.length === 0) {
      return { valid: true, totalEntries: 0 }
    }

    let expectedPreviousHash = GENESIS_HASH

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]
      let entry: AuditEvent
      try {
        entry = JSON.parse(line) as AuditEvent
      } catch {
        return { valid: false, tamperedAt: i + 1, totalEntries: lines.length }
      }

      // Verify previousHash linkage
      if (entry.previousHash !== expectedPreviousHash) {
        return { valid: false, tamperedAt: i + 1, totalEntries: lines.length }
      }

      // Re-compute expected hash
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      const { hash: storedHash, ...withoutHash } = entry
      const expectedHash = computeEntryHash(entry.previousHash, withoutHash)
      if (storedHash !== expectedHash) {
        return { valid: false, tamperedAt: i + 1, totalEntries: lines.length }
      }

      // Next entry's previousHash = SHA-256 of this raw line
      expectedPreviousHash = sha256(line)
    }

    return { valid: true, totalEntries: lines.length }
  } catch {
    return { valid: false, totalEntries: 0 }
  }
}
