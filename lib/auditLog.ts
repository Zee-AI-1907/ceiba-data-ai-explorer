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
import { getServerSession } from 'next-auth'
import { authOptions } from '@/lib/auth'

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
 * request and the current NextAuth session, then calls logAuditEvent.
 */
export async function logWithSession(
  request: Request,
  event: Omit<AuditEvent, 'id' | 'timestamp' | 'userId' | 'userEmail' | 'ipAddress' | 'userAgent' | 'previousHash' | 'hash'>
): Promise<void> {
  const session = await getServerSession(authOptions)
  const forwarded = request.headers.get('x-forwarded-for')
  const ip = forwarded?.split(',')[0]?.trim() ?? request.headers.get('x-real-ip') ?? 'unknown'
  const userAgent = request.headers.get('user-agent') ?? undefined
  logAuditEvent({
    ...event,
    userId: session?.user?.id ?? session?.user?.email ?? 'unauthenticated',
    userEmail: session?.user?.email ?? 'unknown',
    ipAddress: ip,
    userAgent,
  })
}

/**
 * Append a single audit event to audit.log (JSON-lines format) with
 * tamper-evident hash chaining.
 */
export function logAuditEvent(
  event: Omit<AuditEvent, 'id' | 'timestamp' | 'previousHash' | 'hash'>
): void {
  try {
    ensureLogDir()

    const previousHash = getLastLineHash()

    // Build event without hash first
    const withoutHash: Omit<AuditEvent, 'hash'> = {
      ...event,
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
        events.push(JSON.parse(line) as AuditEvent)
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
 */
export function getRecentAuditEvents(limit = 500): AuditEvent[] {
  const all = readAllEvents()
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
