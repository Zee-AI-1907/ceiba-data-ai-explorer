import { randomUUID } from 'node:crypto'
import { NextRequest, NextResponse } from 'next/server'
import { logWithSession, logAuditEvent, getRecentAuditEvents } from '@/lib/auditLog'
import { detectAnomalies } from '@/lib/anomalyDetector'
import { requireAuthWithPermission } from '@/lib/apiAuth'
import { enforceBodySize, parseBody, clampLimit, QueryBodySchema } from '@/lib/validation'
import { rateLimit } from '@/lib/rateLimiter'
import { errorResponse, safeError, ErrorCodes } from '@/lib/errors'
import { guardSql } from '@/lib/sqlGuard'
import { getQueryEngine, KNOWN_ATTACH_ALIASES, MOCK_ALIAS } from '@/lib/engine/provisioning'
import { executeSqlViaService } from '@/lib/nl2sqlServiceClient'
import { queryRuntime, warnIfRuntimesDiverge } from '@/lib/nl2sqlRuntime'
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
 *
 * ── PHASE 4: EXECUTION-RUNTIME CUTOVER FLAG (NL2SQL_QUERY_RUNTIME) ─────────────
 * docs/PYTHON_NL2SQL_SERVICE_PLAN.md §5 Phase 4, §2.2/§2.3. A single flag selects
 * WHERE the SQL executes:
 *   'ts'     (default) — the in-process getQueryEngine().execute path, unchanged.
 *   'python'           — POST the (already-guarded) SQL to the Python FastAPI
 *                        service POST /nl2sql/execute.
 * CRITICAL: on BOTH paths steps 1–6 run IDENTICALLY in TS — in particular the
 * guardSql RE-GUARD (step 5) is the execution security boundary (§1.3) and runs
 * BEFORE any dispatch to the service. A write/DDL statement is rejected with 422
 * SCOPE and NEVER reaches the service. Only step 7 (the DuckDB call itself)
 * differs; step 8's audit + anomaly + H20 scrub are identical. Rollback is a
 * single env flip back to 'ts' — no redeploy (plan §5 "Rollback"). Dialect stays
 * aligned generate↔execute: with the Python runtime BOTH /nl2sql/generate and
 * /nl2sql/execute hit the SAME memoized engine (provisioning.py), so the P1 fix
 * holds structurally across the process boundary.
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

// ── runtime flag: TS (default) vs the Python NL→SQL service ───────────────────

/**
 * The query/execution runtime flag is resolved by lib/nl2sqlRuntime.ts:
 *   effective = NL2SQL_QUERY_RUNTIME ?? NL2SQL_RUNTIME (umbrella) ?? 'ts'
 * (docs/PYTHON_NL2SQL_SERVICE_PLAN.md §5 Phase 4, §7.3). DEFAULT is 'ts', so
 * nothing changes unless an operator opts in; rollback is a single env flip.
 * ALL the TS hardening (auth → rate-limit → body-size → validate →
 * catalog/schema allowlist → guardSql RE-GUARD) runs IDENTICALLY on both paths;
 * only the execute step differs. The guardSql re-guard is the execution
 * boundary and always runs in TS before any dispatch (§1.3).
 * `warnIfRuntimesDiverge` emits a one-time boot warning if generate and query
 * runtimes disagree (mismatched flags reopen the dialect-mismatch window).
 */

/**
 * TEST-ONLY fetch seam for the Python-runtime path. When set, the service client
 * uses this instead of the global `fetch`, so the route test can assert the exact
 * request shape sent to the service and map a mocked response back — fully
 * hermetic (no live service). Mirrors the sql-generate route's seam.
 */
let serviceFetchForTest: typeof fetch | null = null

// eslint-disable-next-line no-underscore-dangle
export function __setServiceFetchForTest(fetchImpl: typeof fetch | null): void {
  serviceFetchForTest = fetchImpl
}

/**
 * The engine-agnostic execution result both paths produce. `columns` here carry
 * the engine's `{ name, type }`; the route maps them onto the client's
 * `{ key, label, type }` shape once, downstream of the runtime branch.
 */
interface QueryExecutionResult {
  columns: Array<{ name: string; type: string }>
  rows: Array<Record<string, unknown>>
  rowCount: number
  truncated: boolean
}

export async function POST(req: NextRequest) {
  // ── 0. Runtime-divergence guard (§7.3): warn ONCE if generate/query runtimes
  //    disagree (a misconfiguration that reopens the dialect-mismatch window). ──
  warnIfRuntimesDiverge()

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

  // Correlation id: forwarded to the service (python path) so one NL→SQL request
  // traces Next → FastAPI → DuckDB (§7.7). Reuse an inbound id if the caller set
  // one. Computed here (before the try) so it is stable across both paths.
  const correlationId = req.headers.get('x-correlation-id') ?? randomUUID()

  try {
    // ── 8. Execute — TS in-process engine (default) OR the Python service ──
    // The guardSql RE-GUARD (step 6) has ALREADY run in TS above — a write/DDL
    // statement was rejected with 422 BEFORE reaching here, so it never touches
    // EITHER runtime. This step only moves the executor; the boundary stays TS.
    const result =
      queryRuntime() === 'python'
        ? await executeViaPythonService({
            sql,
            alias,
            targetSchema,
            rowLimit,
            session,
            correlationId,
          })
        : await executeViaTsEngine({ sql, alias, targetSchema, rowLimit })

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

// ── execution runtimes (both behind the SAME TS boundary) ─────────────────────

/**
 * executeViaTsEngine — the default in-process path. Executes via the SHARED
 * QueryEngine (lib/engine/provisioning.ts) that /api/sql-generate EXPLAIN-validates
 * against, so the dialect executed is IDENTICAL to the dialect generation validated
 * (the P1 fix). engine.execute enforces maxRows (row cap + `truncated`) and
 * deadlineMs; the DuckDbEngine additionally guarantees every attached source is
 * READ_ONLY (hard-error on non-READ_ONLY attach + re-check of
 * duckdb_databases().readonly).
 */
async function executeViaTsEngine(args: {
  sql: string
  alias: string
  targetSchema: string
  rowLimit: number
}): Promise<QueryExecutionResult> {
  const engine = await getQueryEngine()
  const result = await engine.execute(args.sql, {
    catalog: args.alias,
    schema: args.targetSchema,
    maxRows: args.rowLimit,
    deadlineMs: QUERY_DEADLINE_MS,
  })
  return {
    columns: result.columns.map((c) => ({ name: c.name, type: c.type })),
    rows: result.rows,
    rowCount: result.rowCount,
    truncated: result.truncated,
  }
}

/**
 * executeViaPythonService — the flag-on path (NL2SQL_QUERY_RUNTIME=python). POSTs
 * the ALREADY-GUARDED sql (guardSql ran in TS above — the boundary) to
 * /nl2sql/execute, forwarding the internal Bearer token + correlation id. The
 * TS-clamped rowLimit becomes `maxRows`, the TS wall-clock budget becomes
 * `deadlineMs`, and the already-validated alias/schema are forwarded (the service
 * re-guards + re-caps as defense in depth, §1.3). Dialect alignment is structural:
 * the service's /nl2sql/execute and /nl2sql/generate share one memoized engine.
 *
 * Any Nl2sqlServiceError (guard/engine/internal/auth/unavailable/timeout) or
 * transport failure propagates to the route's catch → safeError(502); no raw
 * upstream body reaches the client (H20).
 */
async function executeViaPythonService(args: {
  sql: string
  alias: string
  targetSchema: string
  rowLimit: number
  session: { orgId: string; userId: string; role: string }
  correlationId: string
}): Promise<QueryExecutionResult> {
  const { sql, alias, targetSchema, rowLimit, session, correlationId } = args
  const result = await executeSqlViaService(
    {
      sql,
      tenantId: session.orgId,
      context: { userId: session.userId, activeOrgId: session.orgId, role: session.role },
      database: alias,
      schema: targetSchema,
      maxRows: rowLimit,
      deadlineMs: QUERY_DEADLINE_MS,
    },
    { correlationId, fetchImpl: serviceFetchForTest ?? undefined }
  )
  return {
    columns: result.columns.map((c) => ({ name: c.name, type: c.type })),
    rows: result.rows,
    rowCount: result.rowCount,
    truncated: result.truncated,
  }
}
