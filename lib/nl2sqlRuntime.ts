/**
 * nl2sqlRuntime.ts — umbrella runtime-flag resolution for the NL→SQL split
 * (docs/PYTHON_NL2SQL_SERVICE_PLAN.md §5, §7.3 runtime-divergence guard).
 *
 * The system has two flag-cutover surfaces: generation (`app/api/sql-generate`)
 * and query execution (`app/api/query`). Running generation on one runtime and
 * execution on the OTHER reopens the dialect-mismatch window the P1 fix closed
 * (two engines, two languages, two dialect defaults). The mitigation the plan
 * calls for:
 *
 *   • an UMBRELLA env `NL2SQL_RUNTIME` (values 'ts' | 'python', default 'ts')
 *     that BOTH endpoints inherit unless individually overridden, and
 *   • per-endpoint overrides `NL2SQL_GENERATE_RUNTIME` / `NL2SQL_QUERY_RUNTIME`
 *     (transition-only), and
 *   • a boot-time WARNING when the two EFFECTIVE runtimes diverge, so a
 *     misconfiguration is loud rather than silent.
 *
 * NOTE (plan rename): the query-side flag is `NL2SQL_QUERY_RUNTIME`. An earlier
 * plan draft called it `NL2SQL_EXECUTE_RUNTIME`; the code has always used
 * `NL2SQL_QUERY_RUNTIME` and the plan doc is corrected to match.
 */

export type Nl2sqlRuntime = 'ts' | 'python'

function normalize(value: string | undefined, fallback: Nl2sqlRuntime): Nl2sqlRuntime {
  return value === 'python' ? 'python' : value === 'ts' ? 'ts' : fallback
}

/** The umbrella default both endpoints inherit (NL2SQL_RUNTIME; default 'ts'). */
export function umbrellaRuntime(): Nl2sqlRuntime {
  return normalize(process.env.NL2SQL_RUNTIME, 'ts')
}

/** Effective generation runtime: NL2SQL_GENERATE_RUNTIME, else the umbrella. */
export function generateRuntime(): Nl2sqlRuntime {
  return normalize(process.env.NL2SQL_GENERATE_RUNTIME, umbrellaRuntime())
}

/** Effective query/execution runtime: NL2SQL_QUERY_RUNTIME, else the umbrella. */
export function queryRuntime(): Nl2sqlRuntime {
  return normalize(process.env.NL2SQL_QUERY_RUNTIME, umbrellaRuntime())
}

let divergenceWarned = false

/**
 * warnIfRuntimesDiverge — emit a one-time WARNING if the effective generation
 * and query runtimes differ (mismatched flags reopen the dialect-mismatch
 * window). Called at the top of each route handler; the `divergenceWarned`
 * guard keeps it to one line per process rather than one per request. Returns
 * true iff a divergence was detected (so callers/tests can assert on it).
 */
export function warnIfRuntimesDiverge(logger: Pick<Console, 'warn'> = console): boolean {
  const generate = generateRuntime()
  const query = queryRuntime()
  if (generate === query) return false
  if (!divergenceWarned) {
    divergenceWarned = true
    logger.warn(
      `[nl2sql] RUNTIME DIVERGENCE: generation runtime is "${generate}" but query runtime is "${query}". ` +
        'Running generate and execute on different runtimes reopens the dialect-mismatch window ' +
        '(two engines, two dialect defaults). Set a single NL2SQL_RUNTIME and drop the per-endpoint overrides.'
    )
  }
  return true
}

/** Test-only: reset the one-time warning latch so a test can re-observe it. */
// eslint-disable-next-line no-underscore-dangle
export function __resetDivergenceWarningForTest(): void {
  divergenceWarned = false
}
