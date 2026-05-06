/**
 * auditLog.ts — Server-side append-only PHI access audit logger.
 * IMPORTANT: This module is SERVER-ONLY. Never import it in client components.
 */

import fs from 'fs'
import path from 'path'
import crypto from 'crypto'

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
}

// ── Log file path ─────────────────────────────────────────────────────────────

// Resolve relative to the project root (process.cwd() in Next.js = project root)
const LOG_DIR = path.join(process.cwd(), 'logs')
const LOG_FILE = path.join(LOG_DIR, 'audit.log')

function ensureLogDir(): void {
  if (!fs.existsSync(LOG_DIR)) {
    fs.mkdirSync(LOG_DIR, { recursive: true })
  }
}

// ── Write ─────────────────────────────────────────────────────────────────────

/**
 * Append a single audit event to audit.log (JSON-lines format).
 * Uses synchronous I/O to guarantee the write completes before the response.
 */
export function logAuditEvent(
  event: Omit<AuditEvent, 'id' | 'timestamp'>
): void {
  try {
    ensureLogDir()
    const fullEvent: AuditEvent = {
      ...event,
      id: crypto.randomUUID(),
      timestamp: new Date().toISOString(),
    }
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
