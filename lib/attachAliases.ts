/**
 * attachAliases.ts — the attach-alias allowlist as COORDINATION policy.
 *
 * Rehomed here (from the retired lib/engine/provisioning.ts) as part of the
 * TS-runtime retirement (docs/TS_RUNTIME_RETIREMENT_PLAN.md §2.3). Under the
 * DuckDB-attach model a "catalog" is an attached source ALIAS (e.g. 'mock',
 * 'staging'), not a Trino catalog. The query route validates caller-supplied
 * `database` against this allowlist so no arbitrary identifier reaches the
 * Python service (an identifier-injection control — a coordination concern that
 * stays TS-side; the service re-caps as defense in depth). The engine that
 * actually attaches these sources now lives in Python (ceiba_nl2sql_service).
 */

/** Safe default source alias when the caller omits / sends an unknown `database`. */
export const MOCK_ALIAS = 'mock'

/** The staging source alias. */
export const STAGING_ALIAS = 'staging'

/** The set of attach aliases a caller may target. */
export const KNOWN_ATTACH_ALIASES: readonly string[] = [MOCK_ALIAS, STAGING_ALIAS] as const
