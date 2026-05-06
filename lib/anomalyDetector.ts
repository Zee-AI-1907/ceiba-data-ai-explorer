/**
 * anomalyDetector.ts — Breach and anomaly detection (H-011).
 *
 * Detects security-relevant patterns in the audit event stream and returns
 * a list of AnomalyFlag values for the caller to handle (log, alert, block).
 *
 * All timestamps are UTC; Istanbul time offset (UTC+3) is applied for
 * OFF_HOURS_ACCESS detection.
 */

import type { AuditEvent } from '@/lib/auditLog'

export type AnomalyFlag =
  | 'BULK_EXPORT'
  | 'OFF_HOURS_ACCESS'
  | 'RAPID_QUERIES'
  | 'FAILED_AUTH_SPIKE'
  | 'EXCESSIVE_EXPORT'

const ISTANBUL_OFFSET_HOURS = 3 // UTC+3

/**
 * Detect anomalies for a single incoming event given the recent event history.
 *
 * @param event        The event that just occurred.
 * @param recentEvents Historical events to use for rate / spike analysis.
 *                     Should include events from at least the last 60 minutes.
 * @returns            Array of anomaly flags (may be empty).
 */
export function detectAnomalies(
  event: AuditEvent,
  recentEvents: AuditEvent[],
): AnomalyFlag[] {
  const flags: AnomalyFlag[] = []
  const now = new Date(event.timestamp).getTime()

  // ── BULK_EXPORT ────────────────────────────────────────────────────────────
  // Single query returned > 1 000 rows
  if ((event.rowsAffected ?? 0) > 1_000) {
    flags.push('BULK_EXPORT')
  }

  // ── OFF_HOURS_ACCESS ───────────────────────────────────────────────────────
  // Access outside 07:00–22:00 Istanbul time (UTC+3)
  const istanbulHour =
    (new Date(event.timestamp).getUTCHours() + ISTANBUL_OFFSET_HOURS) % 24
  if (istanbulHour < 7 || istanbulHour > 22) {
    flags.push('OFF_HOURS_ACCESS')
  }

  // ── RAPID_QUERIES ──────────────────────────────────────────────────────────
  // > 10 QUERY_RUN events from the same user in the last 60 seconds
  const sixtySecondsAgo = now - 60_000
  const recentUserQueries = recentEvents.filter(
    (e) =>
      e.action === 'QUERY_RUN' &&
      e.userId === event.userId &&
      new Date(e.timestamp).getTime() >= sixtySecondsAgo,
  )
  if (recentUserQueries.length > 10) {
    flags.push('RAPID_QUERIES')
  }

  // ── FAILED_AUTH_SPIKE ──────────────────────────────────────────────────────
  // > 5 LOGIN_FAILED events (any user) in the last 10 minutes
  const tenMinutesAgo = now - 10 * 60_000
  const recentFailedAuths = recentEvents.filter(
    (e) =>
      e.action === 'LOGIN_FAILED' &&
      new Date(e.timestamp).getTime() >= tenMinutesAgo,
  )
  if (recentFailedAuths.length > 5) {
    flags.push('FAILED_AUTH_SPIKE')
  }

  // ── EXCESSIVE_EXPORT ──────────────────────────────────────────────────────
  // > 3 export events (CSV or Excel) from the same user in the last hour
  const oneHourAgo = now - 60 * 60_000
  const recentExports = recentEvents.filter(
    (e) =>
      (e.action === 'DATA_EXPORT_CSV' || e.action === 'DATA_EXPORT_EXCEL') &&
      e.userId === event.userId &&
      new Date(e.timestamp).getTime() >= oneHourAgo,
  )
  if (recentExports.length > 3) {
    flags.push('EXCESSIVE_EXPORT')
  }

  return flags
}
