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
 * For each configured large/time-series table referenced by the SQL, a
 * SELECTIVE predicate is required — ANY of:
 *   (a) a valid time-bound predicate on the table's OWN requiredTimeColumn
 *       (when one is configured);
 *   (b) a selective equality/IN predicate (in a WHERE/HAVING/QUALIFY filter,
 *       NOT merely a JOIN ... ON clause — see `hasSelectiveEqualityOrInPredicate`)
 *       on one of the table's indexed/FK/PK columns (`selectiveColumns`);
 *   (c) a valid time-bound predicate on a DIRECTLY-JOINED PARENT table's time
 *       column, where the large table is joined to that parent via the exact
 *       FK columns recorded in `parentTimeBound` (cardinality-guard
 *       remediation — e.g. MonitorMeasurements has no own time column, but is
 *       joined `mm."DeviceId" = m."Id"` to Monitors, and
 *       Monitors."MeasuredDate" is time-bounded in the WHERE clause).
 * Concretely:
 *   - Missing LIMIT (anywhere in the statement) alone, with (a)/(b)/(c)
 *     otherwise satisfied -> action='repair': append a LIMIT to the repaired SQL.
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
 * `ceiba_nl2sql/ceiba_nl2sql/guard/cardinality.py` is the sqlglot-AST hardening
 * of this same policy), and its requiredTimeColumn appearing as a predicate
 * operand alongside a comparison operator. The selective-equality/IN escape
 * hatch (b) additionally strips every `JOIN ... ON <condition>` segment before
 * matching (see `stripJoinOnClauses`) — a JOIN's ON-clause equality is the
 * STRUCTURAL join condition (defines how rows are matched), not a row-reducing
 * filter, so it must not let an otherwise-unfiltered full scan through.
 */

import { stripCommentsAndSplit } from '../sqlGuard'
import type { RenderedTable, SchemaContext } from './Retriever'
import type { TimeViaHint } from './BundleLoader'

/**
 * Cardinality-guard remediation: describes how a large table with NO own
 * time column can still be bounded — via a directly-joined PARENT table's
 * time column, reached by an exact FK join. Mirrors catalog.json's
 * `timeVia` hint (see `TimeViaHint` / prep's `apply_time_via_hints`).
 */
export interface ParentTimeBound {
  parentTableName: string
  parentTimeColumn: string
  fromColumns: string[]
  toColumns: string[]
}

export interface LargeTableSpec {
  /** Bare table name as it appears in SQL (e.g. `MeasurementsMock`). */
  tableName: string
  /** Fully-quoted reference for display in messages (e.g. `"MeasurementsMock"`). */
  quotedRef?: string
  /**
   * Fix C: indexed/FK/PK bare column names for this table — feeds the
   * selective equality/IN predicate escape hatch (see
   * `hasSelectiveEqualityOrInPredicate`).
   */
  selectiveColumns?: string[]
  /**
   * Cardinality-guard remediation: set when this table has no own time
   * column but a declared FK reaches a parent table that does (see
   * `ParentTimeBound` / `hasParentJoinTimeBound`).
   */
  parentTimeBound?: ParentTimeBound
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
 *
 * `tableAliases`, when given (lowercase alias/bare-name array), restricts a
 * match to a column operand explicitly qualified by one of those aliases
 * (e.g. `m."MeasuredDate"` where `m` is Monitors' alias) — used by the
 * parent-join bounding check (`hasParentJoinTimeBound`) so a same-named
 * column on an unrelated table cannot masquerade as the parent's time bound.
 * An UNQUALIFIED column match is only accepted when `tableAliases` is not
 * given at all (own-time-column checks, unchanged prior behavior).
 */
function hasTimeBoundPredicate(sql: string, timeColumn: string, tableAliases?: string[]): boolean {
  const escaped = timeColumn.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  if (!tableAliases || tableAliases.length === 0) {
    // Matches: "<col>" or <col>, optionally table/alias-qualified, followed (within
    // ~80 chars, allowing casts/whitespace) by a comparison operator or BETWEEN.
    const pattern = new RegExp(`(?:\\w+\\.)?"?${escaped}"?\\s*(?:::\\w+)?\\s*(>=|<=|>|<|=|BETWEEN)`, 'i')
    return pattern.test(sql)
  }
  // Alias-scoped: require an EXPLICIT alias qualifier from `tableAliases`.
  return tableAliases.some((alias) => {
    const escapedAlias = alias.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    const pattern = new RegExp(`\\b${escapedAlias}\\."?${escaped}"?\\s*(?:::\\w+)?\\s*(>=|<=|>|<|=|BETWEEN)`, 'i')
    return pattern.test(sql)
  })
}

/**
 * Strips every `JOIN ... ON <condition>` segment out of the SQL (replacing
 * the condition with a neutral placeholder) so a lexical scan of the
 * REMAINDER (FROM/WHERE/HAVING/QUALIFY/GROUP BY/ORDER BY/LIMIT) cannot
 * mistake a JOIN's structural equality for a selective filter. The
 * condition runs from `ON` up to the next JOIN/WHERE/GROUP BY/ORDER
 * BY/HAVING/QUALIFY/LIMIT keyword or end of string — this correctly handles
 * a multi-hop chain of JOINs (each ON-clause is redacted independently) and
 * a parenthesized multi-column ON condition.
 */
function stripJoinOnClauses(sql: string): string {
  const joinOnPattern =
    /\bJOIN\s+[^\n]*?\bON\b[\s\S]*?(?=\bJOIN\b|\bWHERE\b|\bGROUP\s+BY\b|\bORDER\s+BY\b|\bHAVING\b|\bQUALIFY\b|\bLIMIT\b|$)/gi
  return sql.replace(joinOnPattern, (segment) => segment.replace(/\bON\b[\s\S]*/i, 'ON <redacted>'))
}

/**
 * Fix C: lexical equivalent of `hasTimeBoundPredicate`, but for an equality
 * (`=`) or `IN (...)` predicate against one of `selectiveColumns` — a
 * large table's indexed/FK/PK bare column names. This is the escape-hatch
 * selective predicate that lets a query pass without a time bound when it
 * instead filters on a real selective (indexed/FK/PK) column, e.g.
 * `WHERE "PatientId" = 42` on a table with no time column configured.
 *
 * Matches ONLY outside JOIN ... ON clauses (see `stripJoinOnClauses`) — a
 * JOIN's ON-clause equality (e.g. `mm."DeviceId" = m."Id"`) is the
 * STRUCTURAL join condition, not a row-reducing filter, so it must not let
 * an otherwise-unfiltered full scan of the large table through the guard.
 */
function hasSelectiveEqualityOrInPredicate(sql: string, selectiveColumns: string[]): boolean {
  if (selectiveColumns.length === 0) return false
  const withoutJoinOn = stripJoinOnClauses(sql)
  return selectiveColumns.some((col) => {
    const escaped = col.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    // `(?:\w+\.)?"?col"?` optionally table/alias-qualified, followed by `=`
    // (not `==`/`<=`/`>=`, avoid matching those) or `IN (`.
    const eqPattern = new RegExp(`(?:\\w+\\.)?"?${escaped}"?\\s*=(?!=)`, 'i')
    const inPattern = new RegExp(`(?:\\w+\\.)?"?${escaped}"?\\s+IN\\s*\\(`, 'i')
    return eqPattern.test(withoutJoinOn) || inPattern.test(withoutJoinOn)
  })
}

/**
 * Resolves every alias a bare table name is referenced under in the SQL
 * (case-insensitive), including the bare name itself (an unaliased
 * reference). Matches `FROM "Table" alias` / `JOIN "Table" alias` / a bare
 * `FROM "Table"` with no alias, and a bare (unquoted) table name spelling.
 * Lexical equivalent of the Python guard's `_table_aliases_by_bare_name`
 * (AST-based there; regex-based here, matching this file's overall approach).
 */
function resolveTableAliases(sql: string, bareTableName: string): string[] {
  const escaped = bareTableName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const pattern = new RegExp(`\\b(?:FROM|JOIN)\\s+(?:\\w+\\.)*"?${escaped}"?(?:\\s+(?:AS\\s+)?(\\w+))?`, 'gi')
  const aliases = new Set<string>([bareTableName.toLowerCase()])
  let match: RegExpExecArray | null
  while ((match = pattern.exec(sql)) !== null) {
    if (match[1]) aliases.add(match[1].toLowerCase())
  }
  return Array.from(aliases)
}

/**
 * True iff the SQL contains a JOIN ... ON (or equivalent) equality matching
 * the large table's `fromColumns[i]` against the parent's `toColumns[i]` for
 * every i, in either operand order — a lexical approximation of the Python
 * guard's AST-based `_join_connects_tables_on_columns`. Requires EVERY
 * from/to column pair to have a matching equality somewhere in the SQL
 * (alias-qualified on at least the parent side, to avoid false-crediting an
 * unrelated same-named-column join).
 */
function joinConnectsTablesOnColumns(
  sql: string,
  largeTableAliases: string[],
  parentTableAliases: string[],
  fromColumns: string[],
  toColumns: string[]
): boolean {
  if (fromColumns.length === 0 || fromColumns.length !== toColumns.length) return false
  const largeAliasGroup = largeTableAliases.map((a) => a.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')
  const parentAliasGroup = parentTableAliases.map((a) => a.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')

  return fromColumns.every((fromCol, i) => {
    const toCol = toColumns[i]!
    const escFrom = fromCol.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    const escTo = toCol.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    const forward = new RegExp(`\\b(?:${largeAliasGroup})\\."?${escFrom}"?\\s*=\\s*(?:${parentAliasGroup})\\."?${escTo}"?`, 'i')
    const backward = new RegExp(`\\b(?:${parentAliasGroup})\\."?${escTo}"?\\s*=\\s*(?:${largeAliasGroup})\\."?${escFrom}"?`, 'i')
    return forward.test(sql) || backward.test(sql)
  })
}

/**
 * Branch (c) of the bounding policy: a large table with no own time column
 * (or whose own time bound is absent) is still considered bounded when the
 * SQL actually joins it to the configured parent table via the exact
 * declared FK columns AND a time-bound predicate exists on that parent's
 * time column, scoped to the parent's alias. Lexical mirror of the Python
 * guard's `_has_parent_join_time_bound`.
 */
function hasParentJoinTimeBound(sql: string, tableName: string, parentTimeBound?: ParentTimeBound): boolean {
  if (!parentTimeBound) return false

  const largeTableAliases = resolveTableAliases(sql, tableName)
  const parentTableAliases = resolveTableAliases(sql, parentTimeBound.parentTableName)
  // resolveTableAliases always returns at least the bare name itself, so an
  // empty result here would mean the bare name check found nothing at all —
  // treat that defensively as "not referenced" rather than crash.
  if (largeTableAliases.length === 0 || parentTableAliases.length === 0) return false

  const joined = joinConnectsTablesOnColumns(
    sql,
    largeTableAliases,
    parentTableAliases,
    parentTimeBound.fromColumns,
    parentTimeBound.toColumns
  )
  if (!joined) return false

  return hasTimeBoundPredicate(sql, parentTimeBound.parentTimeColumn, parentTableAliases)
}

/**
 * Composes the reject-verdict repair hint for one unbounded table, listing
 * every applicable bounding option: (a) its own time column, (b) an
 * equality/IN filter on a selective column, and (c) a parent-join time
 * bound, when configured. Mirrors the Python guard's `_repair_hint_for`.
 */
function repairHintFor(table: LargeTableSpec, timeColumn: string | undefined): string {
  const options: string[] = []
  if (timeColumn) {
    options.push(
      `a time-bound predicate on ${timeColumn} for ${table.quotedRef ?? table.tableName} (e.g. WHERE ${timeColumn} >= now() - INTERVAL '...')`
    )
  }
  if (table.parentTimeBound) {
    const ptb = table.parentTimeBound
    const joinDesc = ptb.fromColumns.map((f, i) => `${f}=${ptb.toColumns[i]}`).join(', ')
    options.push(`a time-bound predicate on ${ptb.parentTableName}.${ptb.parentTimeColumn} (joined via ${joinDesc})`)
  }
  const hasSelectiveColumns = (table.selectiveColumns ?? []).length > 0
  if (hasSelectiveColumns) {
    options.push(`an equality/IN filter on an indexed column (e.g. ${table.selectiveColumns![0]})`)
  }

  if (options.length === 0) {
    return `${table.quotedRef ?? table.tableName} is a large table with no known time column configured; a bounding predicate is required before this query can run.`
  }
  if (!timeColumn) {
    const prefix = `${table.quotedRef ?? table.tableName} is a large table with no known time column configured; `
    return prefix + `add ${options.join(', or ')}.`
  }
  return `Add ${options.join(', or ')}.`
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

  // A table satisfies the SELECTIVE-predicate policy via ANY of (a) a valid
  // time-bound predicate on its OWN configured requiredTimeColumn, (b) a
  // selective equality/IN predicate on one of its indexed/FK/PK columns, or
  // (c) a valid time-bound predicate on a directly-joined PARENT table's
  // time column, reached via the exact FK columns in `parentTimeBound`
  // (large-table-with-no-own-time-column remediation). Only a table
  // satisfying NONE of these is "unbounded".
  const unboundedTables: LargeTableSpec[] = []
  for (const table of referencedLargeTables) {
    const timeColumn = options.requiredTimeColumnByTable[table.tableName]
    const hasTimeBound = !!timeColumn && hasTimeBoundPredicate(stripped, timeColumn)
    if (hasTimeBound) continue
    const hasSelectivePredicate = hasSelectiveEqualityOrInPredicate(stripped, table.selectiveColumns ?? [])
    if (hasSelectivePredicate) continue
    const hasParentTimeBound = hasParentJoinTimeBound(stripped, table.tableName, table.parentTimeBound)
    if (hasParentTimeBound) continue
    unboundedTables.push(table)
  }

  if (unboundedTables.length > 0) {
    const names = unboundedTables.map((t) => t.quotedRef ?? t.tableName).join(', ')
    const hints = unboundedTables.map((t) => repairHintFor(t, options.requiredTimeColumnByTable[t.tableName])).join(' ')
    return {
      ok: false,
      action: 'reject',
      reason: `Unbounded scan of large table(s) ${names}: missing a required selective predicate (a time-bound predicate on the configured time column, or an equality/IN filter on an indexed/FK column).`,
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

// ── SPEC §5.4 context-driven entry point ──────────────────────────────────────

/**
 * Extracts the bare table name from a rendered table. `RenderedTable.quotedRef`
 * is dialect-literal and may be schema-qualified (`"public"."MeasurementsMock"`)
 * or bare (`"MeasurementsMock"`); we take the LAST quoted segment as the table
 * name the lexical matcher keys on, falling back to the tail of the tableId
 * (`mock.public.MeasurementsMock` -> `MeasurementsMock`) when quotedRef is
 * unparseable.
 */
function bareTableNameOf(table: RenderedTable): string {
  const quotedSegments = table.quotedRef.match(/"([^"]+)"/g)
  if (quotedSegments && quotedSegments.length > 0) {
    return quotedSegments[quotedSegments.length - 1]!.replace(/"/g, '')
  }
  const idParts = table.tableId.split('.')
  return idParts[idParts.length - 1] ?? table.quotedRef
}

/** Strips surrounding double-quotes from a rendered `requiredTimeColumn` (e.g. `"RecordedAt"` -> `RecordedAt`). */
function bareColumnNameOf(quotedColumn: string): string {
  const match = quotedColumn.match(/"([^"]+)"/)
  return match ? match[1]! : quotedColumn
}

/**
 * Fix C: derive a large table's selective (indexed/FK/PK) bare column names
 * from its rendered columns. A column counts as selective when it is
 * indexed (`isIndexed`) or a primary/foreign key (`isForeignKeyOrPrimaryKey`).
 */
function selectiveColumnsOf(table: RenderedTable): string[] {
  return table.columns.filter((c) => c.isIndexed || c.isForeignKeyOrPrimaryKey).map((c) => c.name)
}

/**
 * Derives a `ParentTimeBound` from a rendered table's `timeVia` hint (see
 * `TimeViaHint` / prep's `apply_time_via_hints`). The parent's bare table
 * name is resolved via `tablesByTableId` (keyed by tableId) when the parent
 * is itself among the retrieved/rendered tables; otherwise falls back to the
 * tail dot-segment of the parent tableId (mirrors `bareTableNameOf`'s tableId
 * fallback) since a hint should still be usable even when the parent table
 * wasn't itself recalled into this query's schema context.
 */
function parentTimeBoundOf(table: RenderedTable, tablesByTableId: Map<string, RenderedTable>): ParentTimeBound | undefined {
  const timeVia = table.timeVia
  if (!timeVia) return undefined
  const parentTable = tablesByTableId.get(timeVia.table)
  const parentTableName = parentTable ? bareTableNameOf(parentTable) : (timeVia.table.split('.').pop() ?? timeVia.table)
  return {
    parentTableName,
    parentTimeColumn: timeVia.column,
    fromColumns: timeVia.fromColumns,
    toColumns: timeVia.toColumns,
  }
}

/**
 * buildCardinalityGuardOptions — derive the large-table bounding policy directly
 * from a retrieved `SchemaContext` (SPEC §5.4: `cardinalityGuard(sql, ctx)`).
 * Every survivor table flagged `isLargeTimeSeries` becomes a `LargeTableSpec`,
 * and its `requiredTimeColumn` (already the indexed time column the retriever
 * resolved) becomes the bound the guard enforces. This is the production wiring;
 * the lower-level options-based `cardinalityGuard` above stays the reusable core
 * (and remains what the M1 thin-slice test calls with a hand-authored policy).
 */
export function buildCardinalityGuardOptions(
  ctx: Pick<SchemaContext, 'tables'>,
  defaultLimit = 1000
): CardinalityGuardOptions {
  const largeTables: LargeTableSpec[] = []
  const requiredTimeColumnByTable: Record<string, string> = {}
  const tablesByTableId = new Map(ctx.tables.map((t) => [t.tableId, t]))
  for (const table of ctx.tables) {
    if (!table.isLargeTimeSeries) continue
    const tableName = bareTableNameOf(table)
    largeTables.push({
      tableName,
      quotedRef: table.quotedRef,
      selectiveColumns: selectiveColumnsOf(table),
      parentTimeBound: parentTimeBoundOf(table, tablesByTableId),
    })
    if (table.requiredTimeColumn) {
      requiredTimeColumnByTable[tableName] = bareColumnNameOf(table.requiredTimeColumn)
    }
  }
  return { largeTables, requiredTimeColumnByTable, defaultLimit }
}

/**
 * cardinalityGuardFromContext — the SPEC §5.4 signature `cardinalityGuard(sql,
 * ctx)`. Thin adapter that derives the policy from the retrieved SchemaContext
 * (via `buildCardinalityGuardOptions`) and delegates to the core guard. Named
 * distinctly from `cardinalityGuard` so the options-based overload the M1 test
 * relies on is not broken by a signature change.
 */
export function cardinalityGuardFromContext(
  sql: string,
  ctx: Pick<SchemaContext, 'tables'>,
  defaultLimit = 1000
): CardinalityVerdict {
  return cardinalityGuard(sql, buildCardinalityGuardOptions(ctx, defaultLimit))
}
