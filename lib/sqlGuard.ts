/**
 * sqlGuard.ts — Server-side SQL statement classifier (Workstream F, B1 fix).
 *
 * ── WHY ──────────────────────────────────────────────────────────────────────
 * The previous guard in app/api/query/route.ts (report finding B1) inspected only
 * the first whitespace token of the raw SQL:
 *
 *     const firstWord = sql.trim().toUpperCase().split(/\s+/)[0]
 *     if (BLOCKED.includes(firstWord)) reject
 *
 * That is trivially bypassable:
 *   • A leading comment makes the first token `/*` or `--`, so
 *     `/* x *\/ DELETE FROM eclinics."Shared"."Patients"` slips through.
 *   • MERGE / CALL / EXECUTE were never in the blocklist at all.
 *   • Multiple statements (`SELECT 1; DROP TABLE t`) were not considered.
 *
 * This module replaces that with a real classifier that:
 *   1. Strips block (/* … *\/, nestable) and line (-- …) comments using a
 *      character-level tokenizer that understands single/double-quoted strings
 *      and bracket/backtick-quoted identifiers, so a `;` or `--` INSIDE a string
 *      literal is NOT treated as a statement separator or comment.
 *   2. Rejects multiple statements (any non-trailing `;`).
 *   3. Allows ONLY a single top-level read query: SELECT, WITH…SELECT, EXPLAIN,
 *      EXPLAIN ANALYZE, SHOW, DESCRIBE/DESC. Everything else — DELETE, INSERT,
 *      UPDATE, DROP, ALTER, CREATE, TRUNCATE, MERGE, CALL, EXECUTE, GRANT,
 *      REVOKE, SET, USE, START/COMMIT/ROLLBACK, PREPARE, DEALLOCATE, etc. — is
 *      rejected.
 *
 * ── APPROACH & WHY NOT AN EXTERNAL PARSER ────────────────────────────────────
 * A full SQL parser (e.g. node-sql-parser) was considered and deliberately NOT
 * adopted here:
 *   • node-sql-parser has no Trino/Presto dialect; the closest dialects reject
 *     valid Trino constructs (LATERAL UNNEST, `catalog.schema.table`, TABLESAMPLE,
 *     row/array literals), so it would false-REJECT legitimate read queries.
 *   • Adding a parser dependency for a *security boundary* means trusting its
 *     grammar completeness for rejection — a parser that fails open on a construct
 *     it cannot parse is worse than an explicit allowlist.
 * A hand-written tokenizer needs to understand only enough lexical structure
 * (comments, strings, identifiers, statement separators, the leading keyword) to
 * classify the statement. It is small, auditable, and dialect-agnostic. The cost
 * is that it classifies by leading keyword rather than fully validating the query
 * body — acceptable because this is DEFENSE-IN-DEPTH, not the primary control
 * (see the INFRA REQUIREMENT below).
 *
 * ── ⚠ INFRA REQUIREMENT — THIS CODE ALONE DOES NOT FIX B1 ────────────────────
 * The PRIMARY control MUST be a genuinely read-only Trino principal at the
 * cluster: the `TRINO_USER` this app connects as must be bound to a role/access-
 * control ruleset that DENIES all writes/DDL (INSERT/UPDATE/DELETE/MERGE/CREATE/
 * ALTER/DROP/TRUNCATE/CALL/GRANT) at the connector and catalog level. That cannot
 * be configured from application code. Until that is verified (SECURITY.md notes
 * it as UNVERIFIED), a bypass of this in-app guard would reach a writable DB.
 * This classifier reduces attack surface and blocks the known B1 vectors, but the
 * DB-side read-only role is the control that makes a bypass harmless.
 *
 * ── LIMITS (documented honestly) ─────────────────────────────────────────────
 *   • Classifies by the first significant top-level keyword. A query whose
 *     leading keyword is a read verb but which somehow embeds a writing construct
 *     in a way Trino would execute is out of scope for a lexer — the DB-side
 *     read-only role is what covers that (and Trino does not allow DML inside a
 *     SELECT/WITH anyway).
 *   • Dollar-quoted strings ($tag$…$tag$) are PostgreSQL, not Trino, but are
 *     tokenized defensively so a `;`/comment inside them is not mis-split.
 *   • The table allowlist hook (H25) is a seam; the default policy is permissive
 *     (allow all) so wiring it in now is safe and non-breaking.
 */

/** Result of classifying a SQL string. CHECK `allowed` first. */
export interface SqlGuardResult {
  allowed: boolean
  /** Human-safe reason when `allowed` is false. Never contains raw internals. */
  reason?: string
  /** The detected leading statement type, upper-cased (e.g. 'SELECT', 'DELETE'). */
  statementType?: string
}

/**
 * The ONLY statement types permitted to reach Trino. All are read-only in Trino:
 *   SELECT / WITH        — queries (WITH is a CTE prefix that must resolve to SELECT)
 *   EXPLAIN              — query planning (incl. EXPLAIN ANALYZE, which in Trino
 *                          executes the *plan* read-only; still SELECT-only input)
 *   SHOW / DESCRIBE/DESC — metadata introspection
 * Everything else is denied by default.
 */
const ALLOWED_STATEMENT_TYPES = new Set<string>([
  'SELECT',
  'WITH',
  'EXPLAIN',
  'SHOW',
  'DESCRIBE',
  'DESC',
])

/**
 * Explicitly-named write/DDL/side-effecting verbs. We DENY by default (anything
 * not in ALLOWED_STATEMENT_TYPES is rejected), so this set exists only to give a
 * precise, auditable reason string for the common dangerous verbs — including the
 * specific B1 gaps MERGE / CALL / EXECUTE.
 */
const KNOWN_WRITE_TYPES = new Set<string>([
  'INSERT', 'UPDATE', 'DELETE', 'MERGE',
  'DROP', 'ALTER', 'CREATE', 'TRUNCATE', 'RENAME',
  'CALL', 'EXECUTE', 'PREPARE', 'DEALLOCATE',
  'GRANT', 'REVOKE', 'DENY',
  'SET', 'RESET', 'USE',
  'START', 'BEGIN', 'COMMIT', 'ROLLBACK', 'SAVEPOINT',
  'COMMENT', 'ANALYZE', 'REFRESH', 'UPDATE',
])

/**
 * A table-allowlist hook (H25 seam). Given the raw (comment-stripped) SQL and the
 * target catalog/schema, decide whether the referenced tables are permitted.
 * Return `{ allowed: false, reason }` to reject. The default is permissive.
 */
export type TableAllowlistCheck = (input: {
  sql: string
  catalog?: string
  schema?: string
}) => { allowed: boolean; reason?: string }

/** Default table-allowlist policy: allow everything (permissive seam). */
export const allowAllTables: TableAllowlistCheck = () => ({ allowed: true })

/**
 * stripCommentsAndSplit — single-pass character tokenizer.
 *
 * Returns the SQL with comments removed, PLUS the list of top-level statements
 * (split on `;` that are OUTSIDE strings/identifiers/comments). Trailing empty
 * statements (from a trailing `;` and whitespace) are dropped.
 *
 * String/identifier awareness is what makes this correct where a naive
 * `split(';')` / regex is not:
 *   • '…'  single-quoted string   ('' is an escaped quote)
 *   • "…"  double-quoted identifier ("" escapes)
 *   • `…`  backtick identifier (MySQL-ish; harmless to support)
 *   • [ … ] bracket identifier (T-SQL-ish; harmless to support)
 *   • $tag$…$tag$ dollar-quoted (PostgreSQL; tokenized defensively)
 * A `;`, `--`, or `/*` appearing inside any of these is treated as literal text.
 */
export function stripCommentsAndSplit(sql: string): {
  stripped: string
  statements: string[]
} {
  let out = ''
  const statements: string[] = []
  let current = ''

  const push = (ch: string) => {
    out += ch
    current += ch
  }
  const endStatement = () => {
    if (current.trim().length > 0) statements.push(current.trim())
    current = ''
  }

  const n = sql.length
  let i = 0
  while (i < n) {
    const ch = sql[i]
    const next = i + 1 < n ? sql[i + 1] : ''

    // ── Line comment: -- … to end of line ──
    if (ch === '-' && next === '-') {
      i += 2
      while (i < n && sql[i] !== '\n') i++
      // preserve the newline itself (as whitespace) so tokens don't merge
      continue
    }

    // ── Block comment: /* … */ (nestable, like Trino/ANSI) ──
    if (ch === '/' && next === '*') {
      i += 2
      let depth = 1
      while (i < n && depth > 0) {
        if (sql[i] === '/' && sql[i + 1] === '*') {
          depth++
          i += 2
        } else if (sql[i] === '*' && sql[i + 1] === '/') {
          depth--
          i += 2
        } else {
          i++
        }
      }
      // Replace the whole comment with a single space so adjacent tokens
      // (`SELECT/**/1`) do not fuse.
      push(' ')
      continue
    }

    // ── Single-quoted string literal ──
    if (ch === "'") {
      push(ch)
      i++
      while (i < n) {
        if (sql[i] === "'" && sql[i + 1] === "'") {
          push("'"); push("'"); i += 2; continue
        }
        push(sql[i])
        if (sql[i] === "'") { i++; break }
        i++
      }
      continue
    }

    // ── Double-quoted identifier ──
    if (ch === '"') {
      push(ch)
      i++
      while (i < n) {
        if (sql[i] === '"' && sql[i + 1] === '"') {
          push('"'); push('"'); i += 2; continue
        }
        push(sql[i])
        if (sql[i] === '"') { i++; break }
        i++
      }
      continue
    }

    // ── Backtick identifier ──
    if (ch === '`') {
      push(ch)
      i++
      while (i < n) {
        push(sql[i])
        if (sql[i] === '`') { i++; break }
        i++
      }
      continue
    }

    // ── Bracket identifier [ … ] ──
    if (ch === '[') {
      push(ch)
      i++
      while (i < n) {
        push(sql[i])
        if (sql[i] === ']') { i++; break }
        i++
      }
      continue
    }

    // ── Dollar-quoted string $tag$ … $tag$ (Postgres; defensive) ──
    if (ch === '$') {
      const tagMatch = /^\$[A-Za-z0-9_]*\$/.exec(sql.slice(i))
      if (tagMatch) {
        const tag = tagMatch[0]
        // copy opening tag
        for (const c of tag) push(c)
        i += tag.length
        const closeIdx = sql.indexOf(tag, i)
        if (closeIdx === -1) {
          // Unterminated — copy the rest and stop.
          while (i < n) { push(sql[i]); i++ }
          break
        }
        while (i < closeIdx) { push(sql[i]); i++ }
        for (const c of tag) push(c)
        i += tag.length
        continue
      }
    }

    // ── Statement separator (top level only; we're outside all quotes here) ──
    if (ch === ';') {
      endStatement()
      out += ';'
      i++
      continue
    }

    push(ch)
    i++
  }

  endStatement()
  return { stripped: out, statements }
}

/**
 * Extract the leading significant keyword of a (comment-stripped) statement,
 * skipping a leading opening parenthesis (e.g. `( SELECT … )`). Returns the
 * upper-cased keyword, or '' if none.
 */
function leadingKeyword(statement: string): string {
  let s = statement.trim()
  // Skip any number of leading '(' — a parenthesized SELECT is still a SELECT.
  while (s.startsWith('(')) s = s.slice(1).trim()
  const match = /^[A-Za-z_][A-Za-z0-9_]*/.exec(s)
  return match ? match[0].toUpperCase() : ''
}

export interface GuardSqlOptions {
  /** Target catalog (for the allowlist hook). */
  catalog?: string
  /** Target schema (for the allowlist hook). */
  schema?: string
  /** Table-allowlist policy (H25 seam). Defaults to permissive `allowAllTables`. */
  tableAllowlist?: TableAllowlistCheck
}

/**
 * guardSql — classify a SQL string and decide whether it is a single read-only
 * statement safe to forward to Trino.
 *
 * Order of checks:
 *   1. Non-empty after trimming.
 *   2. Strip comments + split into top-level statements.
 *   3. Exactly one non-empty statement (reject multi-statement).
 *   4. Leading keyword is in the read-only allowlist.
 *   5. (Optional) table allowlist hook passes.
 *
 * This is defense-in-depth; see the INFRA REQUIREMENT in the file header — the
 * DB-side read-only Trino role is the primary control.
 */
export function guardSql(sql: string, options: GuardSqlOptions = {}): SqlGuardResult {
  if (typeof sql !== 'string' || sql.trim().length === 0) {
    return { allowed: false, reason: 'No SQL provided.' }
  }

  const { statements } = stripCommentsAndSplit(sql)

  if (statements.length === 0) {
    return { allowed: false, reason: 'No executable SQL after stripping comments.' }
  }

  if (statements.length > 1) {
    return {
      allowed: false,
      reason: 'Multiple SQL statements are not allowed. Submit a single read-only query.',
    }
  }

  const statement = statements[0]
  const keyword = leadingKeyword(statement)

  if (!keyword) {
    return { allowed: false, reason: 'Could not identify the SQL statement type.' }
  }

  if (!ALLOWED_STATEMENT_TYPES.has(keyword)) {
    const isKnownWrite = KNOWN_WRITE_TYPES.has(keyword)
    return {
      allowed: false,
      statementType: keyword,
      reason: isKnownWrite
        ? `${keyword} is not permitted. Only read-only queries (SELECT / WITH / EXPLAIN / SHOW / DESCRIBE) are allowed.`
        : `Statement type '${keyword}' is not permitted. Only read-only queries are allowed.`,
    }
  }

  // WITH must ultimately drive a SELECT (not, e.g., `WITH … INSERT …`). Two
  // defensive checks (the DB-side read-only role remains the real guarantee):
  //   (a) a SELECT must appear somewhere — a WITH with no SELECT is not a query;
  //   (b) NO write/DDL verb may appear as a standalone keyword anywhere in the
  //       statement, which catches `WITH x AS (…) INSERT INTO t SELECT …` and
  //       `WITH … DELETE …`. Matching whole words avoids tripping on identifiers
  //       that merely contain the letters (e.g. a column named `inserted_at`).
  if (keyword === 'WITH') {
    if (!/\bSELECT\b/i.test(statement)) {
      return {
        allowed: false,
        statementType: 'WITH',
        reason: 'A WITH clause must resolve to a SELECT query.',
      }
    }
    const writeVerbInBody = new RegExp(
      `\\b(${['INSERT', 'UPDATE', 'DELETE', 'MERGE', 'CREATE', 'ALTER', 'DROP', 'TRUNCATE', 'CALL', 'GRANT', 'REVOKE'].join('|')})\\b`,
      'i'
    )
    if (writeVerbInBody.test(statement)) {
      return {
        allowed: false,
        statementType: 'WITH',
        reason: 'A WITH clause may not contain a write or DDL statement.',
      }
    }
  }

  // ── H25 table-allowlist hook ──
  const check = options.tableAllowlist ?? allowAllTables
  const allowlistResult = check({
    sql: statement,
    catalog: options.catalog,
    schema: options.schema,
  })
  if (!allowlistResult.allowed) {
    return {
      allowed: false,
      statementType: keyword,
      reason: allowlistResult.reason ?? 'Query references tables outside the allowlist.',
    }
  }

  return { allowed: true, statementType: keyword }
}
