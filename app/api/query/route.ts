import { NextRequest, NextResponse } from 'next/server'
import { logWithSession, logAuditEvent, getRecentAuditEvents } from '@/lib/auditLog'
import { detectAnomalies } from '@/lib/anomalyDetector'
import { requireAuthWithPermission } from '@/lib/apiAuth'
import { enforceBodySize, parseBody, clampLimit, QueryBodySchema } from '@/lib/validation'
import { rateLimit } from '@/lib/rateLimiter'
import { errorResponse, safeError, ErrorCodes } from '@/lib/errors'
import { guardSql } from '@/lib/sqlGuard'
import { getQueryEngine, KNOWN_ATTACH_ALIASES, MOCK_ALIAS } from '@/lib/engine/provisioning'
import fs from 'fs'
import path from 'path'

/**
 * POST /api/query — execute a guard-passed, read-only SELECT (NL2SQL_SPEC.md §5.6).
 *
 * ── P1 DIALECT-MISMATCH FIX ───────────────────────────────────────────────────
 * This route now EXECUTES through the SAME shared QueryEngine that /api/sql-generate
 * EXPLAIN-validates against (lib/engine/provisioning.ts::getQueryEngine). Previously
 * generation validated candidate SQL as the `duckdb` dialect while this route ran it
 * through `executeTrinoQuery` (`trino` dialect) — a silent conformance gap (interval
 * syntax, quoting, function names differ between dialects). Both paths now provision
 * from one topology → one dialect. DuckDB attaches the configured read-only Postgres
 * sources (MOCK_DSN / STAGING_DSN) and performs cross-source joins in-process; Trino
 * stays pluggable behind the QueryEngine interface via `NL2SQL_ENGINE` without a route
 * rewrite.
 *
 * ── WS-F HARDENING (unchanged, same order) ────────────────────────────────────
 *   1. requireAuthWithPermission('query:run')   — AuthN + RBAC
 *   2. rateLimit                                 — per-user throttle (N3)
 *   3. enforceBodySize                           — 413 before body read (§6a)
 *   4. parseBody(QueryBodySchema)                — 400 on malformed/invalid (N5)
 *   5. guardSql (read-only, comment-safe, B1)    — 422 on any non-read statement
 *   6. clampLimit + catalog/schema allowlist     — H22 (row cap + identifier injection)
 *   7. engine.execute (maxRows + deadlineMs)     — bounded read
 *   8. safeError(…, 502)                          — H20 (never leak raw engine errors)
 */

/**
 * H23: cap this route's execution wall-clock. The engine enforces its own statement
 * deadline (deadlineMs, below); this keeps the serverless invocation from being pinned
 * beyond that. Kept slightly above the engine deadline so the engine's clean 502 wins
 * over a hard platform kill.
 */
export const maxDuration = 60

const ANOMALY_LOG = path.join(process.cwd(), 'logs', 'anomalies.log')

/** Hard ceiling on rows returned to a caller (H22 OOM guard). */
const MAX_QUERY_ROWS = 5000
/** Default row limit when the caller does not specify one. */
const DEFAULT_QUERY_ROWS = 1000
/**
 * Wall-clock budget passed to engine.execute (H23). Mirrors the ~55s statement
 * deadline the DuckDB/Trino engines already enforce; kept below `maxDuration`.
 */
const QUERY_DEADLINE_MS = 55_000

/**
 * Allowed attach aliases (H22). Under the DuckDB-attach model, a "catalog" is an
 * attached source ALIAS (e.g. 'mock', 'staging'), not a Trino catalog. Caller-supplied
 * `database` MUST be validated against this allowlist so no arbitrary identifier
 * reaches the engine (the header/identifier-injection protection the Trino route had
 * for its catalog allowlist, preserved). Unknown values fall back to the safe default.
 */
const ALLOWED_ALIASES: readonly string[] = KNOWN_ATTACH_ALIASES
/** Safe default source alias when the caller omits / sends an unknown `database`. */
const DEFAULT_ALIAS = MOCK_ALIAS

/**
 * Schema allowlist per attached source. `schema` is a Postgres schema identifier
 * threaded to the engine (`USE alias.schema` for EXPLAIN, and referenced in SQL); an
 * unvalidated value is an identifier-injection vector (H22). Restrict to the known
 * clinical/mock schema set. Kept permissive-but-safe: only identifier-shaped values
 * present in the allowlist are accepted.
 */
const ALLOWED_SCHEMAS: Record<string, readonly string[]> = {
  [MOCK_ALIAS]: ['public', 'Shared'],
  staging: ['public', 'Shared'],
}
const DEFAULT_SCHEMA = 'public'

/** A defensively strict identifier pattern — no whitespace, quotes, or control chars. */
const SAFE_IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/

function resolveAlias(database?: string): string {
  if (database && ALLOWED_ALIASES.includes(database)) {
    return database
  }
  return DEFAULT_ALIAS
}

function resolveSchema(alias: string, schema?: string): string {
  const allowed = ALLOWED_SCHEMAS[alias] ?? ALLOWED_SCHEMAS[DEFAULT_ALIAS]!
  if (schema && SAFE_IDENTIFIER.test(schema) && allowed.includes(schema)) {
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
  // ── 1. AuthN + AuthZ ──
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

  // ── 5. Resolve catalog/schema onto attached source + PG schema (H22 injection) ──
  const alias = resolveAlias(database)
  const targetSchema = resolveSchema(alias, schema)

  // ── 6. SQL safety classifier (B1) — reject anything not a single read query ──
  const guard = guardSql(sql, { catalog: alias, schema: targetSchema })
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

  // ── 7. Clamp limit (H22 — hard max) ──
  const rowLimit = clampLimit(limit, { max: MAX_QUERY_ROWS, fallback: DEFAULT_QUERY_ROWS })

  try {
    // ── 8. Execute via the SHARED engine (same dialect generation validated) ──
    // engine.execute enforces maxRows (row cap + `truncated`) and deadlineMs
    // (interrupt at the wall-clock budget); the DuckDbEngine additionally guarantees
    // every attached source is READ_ONLY (hard-error on non-READ_ONLY attach +
    // re-check of duckdb_databases().readonly).
    const engine = await getQueryEngine()
    const result = await engine.execute(sql, {
      catalog: alias,
      schema: targetSchema,
      maxRows: rowLimit,
      deadlineMs: QUERY_DEADLINE_MS,
    })

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
      truncated: result.truncated,
    })
  } catch (e) {
    // H20: never leak raw engine errors. Log full detail under the audit chain,
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
