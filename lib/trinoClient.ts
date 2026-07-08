/**
 * trinoClient.ts — Minimal Trino REST client (Workstream F, H23 hardening).
 *
 * H23 fix: the previous client had NO request timeout and a `while (true)` poll
 * loop with no deadline or iteration cap, so a hung/slow query pinned a
 * serverless invocation until the platform killed it (risking a mid-write kill
 * that corrupts the audit chain per B4/H14). This version adds:
 *   • a per-fetch timeout (AbortSignal.timeout) on BOTH the submit and every poll,
 *   • a wall-clock deadline across the whole statement lifecycle,
 *   • a hard cap on poll iterations,
 *   • a bounded row buffer (never accumulate past the clamped `maxRows`).
 *
 * The route (app/api/query/route.ts) is the only caller of executeTrinoQuery.
 */

export type TrinoColumn = { name: string; type: string }
export type TrinoResult = { columns: TrinoColumn[]; rows: Record<string, unknown>[]; rowCount: number }

export type DbTarget = 'telehealth' | 'eclinics'

// ── Timeout / deadline budget (H23) ──────────────────────────────────────────
/** Timeout for a single HTTP request to Trino (submit or one poll). */
const PER_REQUEST_TIMEOUT_MS = 15_000
/** Wall-clock deadline for the entire statement (submit + all polls). */
const STATEMENT_DEADLINE_MS = 55_000
/** Hard cap on poll iterations, independent of the wall-clock deadline. */
const MAX_POLL_ITERATIONS = 500
/** Delay between polls while Trino reports the query is still running. */
const POLL_INTERVAL_MS = 150

function getBase() {
  return `http://${process.env.TRINO_HOST || 'localhost'}:${process.env.TRINO_PORT || '8080'}`
}

function getCatalog(db: DbTarget) {
  return db === 'telehealth'
    ? (process.env.TRINO_CATALOG_TELEHEALTH || 'telehealth')
    : (process.env.TRINO_CATALOG_ECLINICS || 'eclinics')
}

/** A raised deadline is a distinct condition so the route can 502 it cleanly. */
class TrinoTimeoutError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'TrinoTimeoutError'
  }
}

export async function executeTrinoQuery(
  sql: string,
  db: DbTarget = 'eclinics',
  schema = 'Shared',
  maxRows = 1000
): Promise<TrinoResult> {
  const base = getBase()
  const user = process.env.TRINO_USER || 'readonly'
  const catalog = getCatalog(db)

  // Never buffer more than the clamped ceiling (H22/H23 OOM guard). Defensive
  // clamp in case an unclamped value reaches here.
  const rowCeiling = Number.isFinite(maxRows) && maxRows > 0 ? Math.floor(maxRows) : 1000

  const deadline = Date.now() + STATEMENT_DEADLINE_MS
  const remainingBudget = () => deadline - Date.now()

  // Use the smaller of the per-request timeout and the remaining wall-clock
  // budget so a single slow request can never blow past the overall deadline.
  const requestSignal = () => {
    const budget = remainingBudget()
    if (budget <= 0) throw new TrinoTimeoutError('Trino query exceeded its time budget')
    return AbortSignal.timeout(Math.min(PER_REQUEST_TIMEOUT_MS, budget))
  }

  const initRes = await fetch(`${base}/v1/statement`, {
    method: 'POST',
    headers: {
      'Content-Type': 'text/plain',
      'X-Trino-User': user,
      'X-Trino-Catalog': catalog,
      'X-Trino-Schema': schema,
      'X-Trino-Source': 'ceiba-data-explorer',
    },
    body: sql,
    signal: requestSignal(),
  })

  if (!initRes.ok) throw new Error(`Trino submit failed (${initRes.status}): ${await initRes.text()}`)

  let state = await initRes.json()
  let columns: TrinoColumn[] = []
  const rawRows: unknown[][] = []
  let iterations = 0

  while (true) {
    if (state.columns?.length) {
      columns = state.columns.map((c: { name: string; type: string }) => ({ name: c.name, type: c.type }))
    }
    if (state.data) {
      for (const row of state.data) {
        if (rawRows.length < rowCeiling) rawRows.push(row as unknown[])
        else break
      }
    }
    if (state.error) throw new Error(state.error?.message || 'Query failed')
    if (!state.nextUri) break

    // Stop paging once we have all the rows we're allowed to return — no point
    // continuing to drain a huge result set we would discard (H23 unbounded work).
    if (rawRows.length >= rowCeiling) break

    if (++iterations > MAX_POLL_ITERATIONS) {
      throw new TrinoTimeoutError(`Trino poll exceeded ${MAX_POLL_ITERATIONS} iterations`)
    }
    if (remainingBudget() <= 0) {
      throw new TrinoTimeoutError('Trino query exceeded its time budget')
    }

    // Sequential by protocol: each poll targets the PREVIOUS response's
    // `nextUri`, so these awaits cannot be parallelised. (no-await-in-loop N/A.)
    // eslint-disable-next-line no-await-in-loop
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS))

    // eslint-disable-next-line no-await-in-loop
    const poll = await fetch(state.nextUri, {
      headers: { 'X-Trino-User': user },
      signal: requestSignal(),
    })
    if (!poll.ok) break
    // eslint-disable-next-line no-await-in-loop
    state = await poll.json()
  }

  const rows = rawRows.map((row) =>
    Object.fromEntries(columns.map((col, i) => [col.name, (row as unknown[])[i]]))
  )
  return { columns, rows, rowCount: rows.length }
}
