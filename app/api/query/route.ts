import { NextRequest, NextResponse } from 'next/server'
import { executeTrinoQuery, type DbTarget } from '@/lib/trinoClient'
import { logWithSession, logAuditEvent, getRecentAuditEvents } from '@/lib/auditLog'
import { detectAnomalies } from '@/lib/anomalyDetector'
import { requireAuthWithPermission } from '@/lib/apiAuth'
import { enforceBodySize, parseBody, clampLimit, QueryBodySchema } from '@/lib/validation'
import { rateLimit } from '@/lib/rateLimiter'
import { errorResponse, safeError, ErrorCodes } from '@/lib/errors'
import { guardSql } from '@/lib/sqlGuard'
import fs from 'fs'
import path from 'path'

/**
 * H23: cap this route's execution wall-clock. The Trino client enforces its own
 * ~55s statement deadline; this keeps the serverless invocation from being pinned
 * beyond that. Kept slightly above the client deadline so the client's clean 502
 * wins over a hard platform kill.
 */
export const maxDuration = 60

const ANOMALY_LOG = path.join(process.cwd(), 'logs', 'anomalies.log')

/** Hard ceiling on rows returned to a caller (H22 OOM guard). */
const MAX_QUERY_ROWS = 5000
/** Default row limit when the caller does not specify one. */
const DEFAULT_QUERY_ROWS = 1000

/**
 * Allowed catalogs/schemas (H22). Caller-supplied `database`/`schema` are set as
 * X-Trino-* headers by the client, so they MUST be validated against an allowlist
 * here to prevent header injection / arbitrary schema targeting. `database` maps
 * to a Trino catalog; unknown values fall back to the safe default rather than
 * being forwarded verbatim.
 */
const ALLOWED_CATALOGS: readonly DbTarget[] = ['telehealth', 'eclinics'] as const
const DEFAULT_CATALOG: DbTarget = 'telehealth'

/**
 * Schema allowlist per catalog. Schemas are identifiers forwarded as the
 * X-Trino-Schema header; an unvalidated value is a header-injection / arbitrary-
 * schema vector (H22). Restrict to a known set. Kept permissive-but-safe: only
 * identifier-shaped values that appear in the allowlist are accepted.
 */
const ALLOWED_SCHEMAS: Record<DbTarget, readonly string[]> = {
  telehealth: ['public', 'Shared'],
  eclinics: ['public', 'Shared'],
}
const DEFAULT_SCHEMA = 'Shared'

/** A defensively strict identifier pattern — no whitespace, quotes, or control chars. */
const SAFE_IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/

function resolveCatalog(database?: string): DbTarget {
  if (database && (ALLOWED_CATALOGS as readonly string[]).includes(database)) {
    return database as DbTarget
  }
  return DEFAULT_CATALOG
}

function resolveSchema(catalog: DbTarget, schema?: string): string {
  if (
    schema &&
    SAFE_IDENTIFIER.test(schema) &&
    ALLOWED_SCHEMAS[catalog].includes(schema)
  ) {
    return schema
  }
  return DEFAULT_SCHEMA
}

function writeAnomalyLog(line: string): void {
  try {
    fs.appendFileSync(ANOMALY_LOG, line + '\n', 'utf8')
  } catch {
    // Never crash the request over a log write failure
  }
}

export async function POST(req: NextRequest) {
  // ── 1. AuthN + AuthZ (fixes the Low RBAC gap: query was requireAuth-only) ──
  const { session, error: authError } = await requireAuthWithPermission(req, 'query:run')
  if (authError) return authError

  // ── 2. Rate limit (N3) ──
  const limited = rateLimit(session, 'query')
  if (limited) return limited

  // ── 3. Body-size guard (§6a) ──
  const sizeError = enforceBodySize(req)
  if (sizeError) return sizeError

  // ── 4. Parse + validate body (N5) ──
  const { data, error: parseError } = await parseBody(req, QueryBodySchema)
  if (parseError) return parseError
  const { sql, database, schema, limit } = data

  // ── 5. SQL safety classifier (B1) — reject anything not a single read query ──
  const catalog = resolveCatalog(database)
  const targetSchema = resolveSchema(catalog, schema)
  const guard = guardSql(sql, { catalog, schema: targetSchema })
  if (!guard.allowed) {
    // Well-formed but semantically rejected → 422 SCOPE (per errors.ts convention).
    await logWithSession(req, {
      action: 'QUERY_FAILED',
      resourceType: 'query',
      detail: `SQL rejected by guard (${guard.statementType ?? 'unknown'}): ${sql.slice(0, 200)}`,
      severity: 'WARNING',
    })
    return errorResponse(422, ErrorCodes.SCOPE, guard.reason ?? 'Query rejected: read-only queries only.')
  }

  // ── 6. Clamp limit (H22 — hard max) + validate catalog/schema (H22 header injection) ──
  const rowLimit = clampLimit(limit, { max: MAX_QUERY_ROWS, fallback: DEFAULT_QUERY_ROWS })

  try {
    // ── 7. Execute against Trino (bounded rows, timeout, deadline — H23) ──
    const result = await executeTrinoQuery(sql, catalog, targetSchema, rowLimit)

    const columns = result.columns.map((c) => ({ key: c.name, label: c.name, type: c.type }))

    // Audit event (hash-chained; carries orgId via the session).
    await logWithSession(req, {
      action: 'QUERY_RUN',
      resourceType: 'patient_data',
      detail: `SQL: ${sql.slice(0, 300)}`,
      rowsAffected: result.rowCount,
      severity: 'INFO',
    })

    // Anomaly detection — scope recent events to this tenant for context.
    const recentEvents = getRecentAuditEvents(200, session.orgId)
    const latestEvent = recentEvents[0]
    if (latestEvent) {
      const flags = detectAnomalies(latestEvent, recentEvents.slice(1))
      if (flags.length > 0) {
        writeAnomalyLog(
          JSON.stringify({
            timestamp: new Date().toISOString(),
            eventId: latestEvent.id,
            userId: latestEvent.userId,
            flags,
          })
        )
        logAuditEvent({
          userId: latestEvent.userId,
          orgId: session.orgId,
          userEmail: latestEvent.userEmail,
          action: 'QUERY_RUN',
          resourceType: 'query',
          detail: `ANOMALY DETECTED: ${flags.join(', ')} — SQL: ${sql.slice(0, 200)}`,
          severity: 'WARNING',
        })
      }
    }

    return NextResponse.json({
      columns,
      rows: result.rows,
      rowCount: result.rowCount,
    })
  } catch (e) {
    // H20: never leak raw Trino errors. Log full detail under a correlation id,
    // return a generic 502 envelope.
    await logWithSession(req, {
      action: 'QUERY_FAILED',
      resourceType: 'query',
      detail: `SQL: ${sql.slice(0, 300)} — Error: ${String(e).slice(0, 200)}`,
      severity: 'WARNING',
    })
    return safeError(e, { context: 'query', status: 502 })
  }
}
