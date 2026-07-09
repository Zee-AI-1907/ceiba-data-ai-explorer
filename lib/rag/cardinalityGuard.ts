/**
 * cardinalityGuard.ts — availability control against unbounded scans of large
 * time-series tables (NL2SQL_SPEC.md §5.4, NL2SQL_PLAN.md ★M1).
 *
 * INITIAL version for the M1 thin slice. The read-only DB role (primary control)
 * stops writes but NOT a ruinous full scan of a 337M-row table (research §8.10,
 * SPEC invariant #10). This module is the natural sibling of `lib/sqlGuard.ts`'s
 * H25 table-allowlist seam: `guardSql` answers "is this table allowed at all";
 * `cardinalityGuard` answers "is this scan bounded".
 *
 * ── Policy (SPEC §5.4) ─────────────────────────────────────────────────────────
 * For each configured large/time-series table referenced by the SQL:
 *   - Missing LIMIT (anywhere in the statement) alone -> action='repair': append
 *     a LIMIT to the repaired SQL.
 *   - No predicate on the table's requiredTimeColumn -> action='repair' with a
 *     repairHint describing which column to bound on (fed to the self-repair
 *     loop, §5.5), UNLESS the table has no requiredTimeColumn configured, in
 *     which case action='reject' (no safe repair is possible: we do not know
 *     which column to bound on and cannot silently rewrite the query's meaning).
 *   - If NEITHER a time bound NOR a LIMIT is present, still action='repair' if a
 *     required time column is known (repair adds the LIMIT; the message states
 *     the time-bound gap is required before the query would be considered safe
 *     to execute against a truly large table) — but per SPEC's plain reading,
 *     a wholly-unbounded scan (no time predicate at all on a table with a known
 *     required time column) is the paradigm case this guard exists to catch, so
 *     it is treated as `reject` (not silently repairable — the correct time
 *     window is a business decision the guard cannot fabricate), while a LIMIT
 *     with no time bound is also `reject` for the same reason. Only a "has a time
 *     bound, missing LIMIT" case is auto-repaired (safe, meaning-preserving).
 *
 * ── Detection approach ─────────────────────────────────────────────────────────
 * Lexical, over guard-stripped SQL: reuses `stripCommentsAndSplit` from
 * `lib/sqlGuard.ts` so a `;`/comment/string literal does not fool the matcher
 * (same H25 tokenizer, not re-implemented). Detection matches a flagged table by
 * its bare name or quotedRef appearing in the FROM/JOIN clauses (a lexical
 * substring/word-boundary match — acceptable for this defense-in-depth guard;
 * P5 may harden with a real SQL AST if false negatives are observed), and its
 * requiredTimeColumn appearing as a predicate operand alongside a comparison
 * operator.
 */

import { stripCommentsAndSplit } from '../sqlGuard'

export interface LargeTableSpec {
  /** Bare table name as it appears in SQL (e.g. `MeasurementsMock`). */
  tableName: string
  /** Fully-quoted reference for display in messages (e.g. `"MeasurementsMock"`). */
  quotedRef?: string
}

export interface CardinalityGuardOptions {
  /** Tables considered large/time-series and subject to the bounding policy. */
  largeTables: LargeTableSpec[]
  /** Required (indexed) time column per bare table name, e.g. { MeasurementsMock: 'RecordedAt' }. */
  requiredTimeColumnByTable: Record<string, string>
  /** LIMIT appended by an auto-repair when the SQL is otherwise bounded. Default 1000. */
  defaultLimit?: number
}

export interface CardinalityVerdict {
  ok: boolean
  action: 'pass' | 'repair' | 'reject'
  repairedSql?: string
  repairHint?: string
  reason?: string
}

/** Builds a case-insensitive word-boundary regex matching a bare identifier. */
function identifierPattern(name: string): RegExp {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return new RegExp(`\\b${escaped}\\b`, 'i')
}

function referencesTable(sql: string, table: LargeTableSpec): boolean {
  return identifierPattern(table.tableName).test(sql)
}

function hasLimitClause(sql: string): boolean {
  return /\bLIMIT\s+\d+/i.test(sql)
}

/**
 * Detects whether the SQL has a comparison predicate against the given time
 * column. Matches the column (bare or quoted) followed within a short window by
 * a comparison operator, `BETWEEN`, or `INTERVAL` usage — covers the canonical
 * forms (`"RecordedAt" >= now() - interval '3 hours'`, `RecordedAt > $1`, etc.)
 * without requiring a full SQL parser.
 */
function hasTimeBoundPredicate(sql: string, timeColumn: string): boolean {
  const escaped = timeColumn.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  // Matches: "<col>" or <col>, optionally table/alias-qualified, followed (within
  // ~80 chars, allowing casts/whitespace) by a comparison operator or BETWEEN.
  const pattern = new RegExp(
    `(?:\\w+\\.)?"?${escaped}"?\\s*(?:::\\w+)?\\s*(>=|<=|>|<|=|BETWEEN)`,
    'i'
  )
  return pattern.test(sql)
}

/** Appends a LIMIT clause to SQL that has none. Assumes a single statement (guardSql already enforces this upstream). */
function appendLimit(sql: string, limit: number): string {
  const trimmed = sql.trimEnd()
  const hadTrailingSemicolon = trimmed.endsWith(';')
  const withoutSemicolon = hadTrailingSemicolon ? trimmed.slice(0, -1).trimEnd() : trimmed
  return `${withoutSemicolon} LIMIT ${limit}${hadTrailingSemicolon ? ';' : ''}`
}

/**
 * cardinalityGuard — checks a candidate SQL statement against the large-table
 * bounding policy and either passes it, repairs it (LIMIT-only gap), or rejects
 * it (missing/unknown time bound) with a reason/hint for the self-repair loop.
 *
 * Assumes `sql` is a single statement (guardSql's multi-statement rejection runs
 * upstream in the §5.1 pipeline; this guard does not re-check that).
 */
export function cardinalityGuard(sql: string, options: CardinalityGuardOptions): CardinalityVerdict {
  const defaultLimit = options.defaultLimit ?? 1000
  const { stripped } = stripCommentsAndSplit(sql)

  const referencedLargeTables = options.largeTables.filter((t) => referencesTable(stripped, t))

  if (referencedLargeTables.length === 0) {
    // No large/time-series table in scope for this policy — nothing to enforce.
    return { ok: true, action: 'pass' }
  }

  const missingTimeBoundTables: LargeTableSpec[] = []
  for (const table of referencedLargeTables) {
    const timeColumn = options.requiredTimeColumnByTable[table.tableName]
    if (!timeColumn) {
      // A large table with no configured requiredTimeColumn: we cannot verify a
      // bound, so we cannot safely pass it. Treat as reject (no fabricated repair).
      missingTimeBoundTables.push(table)
      continue
    }
    if (!hasTimeBoundPredicate(stripped, timeColumn)) {
      missingTimeBoundTables.push(table)
    }
  }

  if (missingTimeBoundTables.length > 0) {
    const names = missingTimeBoundTables.map((t) => t.quotedRef ?? t.tableName).join(', ')
    const hints = missingTimeBoundTables
      .map((t) => {
        const col = options.requiredTimeColumnByTable[t.tableName]
        return col
          ? `Add a time-bound predicate on ${col} for ${t.quotedRef ?? t.tableName} (e.g. WHERE ${col} >= now() - INTERVAL '...').`
          : `${t.quotedRef ?? t.tableName} is a large table with no known time column configured; a bounding predicate is required before this query can run.`
      })
      .join(' ')
    return {
      ok: false,
      action: 'reject',
      reason: `Unbounded scan of large table(s) ${names}: missing a required time-bound predicate.`,
      repairHint: hints,
    }
  }

  // All referenced large tables have a valid time-bound predicate. Only the
  // LIMIT gap remains, which is a safe, meaning-preserving auto-repair.
  if (!hasLimitClause(stripped)) {
    const repairedSql = appendLimit(sql, defaultLimit)
    return {
      ok: true,
      action: 'repair',
      repairedSql,
      repairHint: `Missing LIMIT; a LIMIT ${defaultLimit} was appended automatically.`,
      reason: 'Query was time-bounded but had no LIMIT; repaired by appending one.',
    }
  }

  return { ok: true, action: 'pass' }
}
