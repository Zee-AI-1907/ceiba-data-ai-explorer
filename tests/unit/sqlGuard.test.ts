/**
 * Unit tests for lib/sqlGuard.ts — the server-side SQL read-only classifier (B1 fix).
 *
 * These tests target the specific bypass vectors called out in the production
 * readiness report finding B1:
 *   • comment-prefix bypass (`/* *\/ DELETE …` and `-- \n DELETE …`)
 *   • MERGE / CALL / EXECUTE (verbs absent from the old blocklist)
 *   • multi-statement injection (`SELECT 1; DROP TABLE t`)
 *   • string-literal-containing-semicolon (must NOT be seen as multi-statement)
 * plus the positive cases (plain SELECT, WITH…SELECT, EXPLAIN) that must be allowed.
 */
import { describe, expect, it } from 'vitest'
import { guardSql, stripCommentsAndSplit, allowAllTables, type TableAllowlistCheck } from '@/lib/sqlGuard'

const denySecret: TableAllowlistCheck = ({ sql }) =>
  /secret/i.test(sql) ? { allowed: false, reason: 'table not permitted' } : { allowed: true }

describe('guardSql — allowed read-only statements', () => {
  it('allows a plain SELECT', () => {
    const r = guardSql('SELECT * FROM patients')
    expect(r.allowed).toBe(true)
    expect(r.statementType).toBe('SELECT')
  })

  it('allows a WITH … SELECT (CTE)', () => {
    const r = guardSql('WITH recent AS (SELECT id FROM visits WHERE ts > now()) SELECT * FROM recent')
    expect(r.allowed).toBe(true)
    expect(r.statementType).toBe('WITH')
  })

  it('allows a parenthesized SELECT', () => {
    const r = guardSql('( SELECT 1 )')
    expect(r.allowed).toBe(true)
    expect(r.statementType).toBe('SELECT')
  })

  it('allows EXPLAIN and EXPLAIN ANALYZE', () => {
    expect(guardSql('EXPLAIN SELECT 1').allowed).toBe(true)
    expect(guardSql('EXPLAIN ANALYZE SELECT * FROM t').allowed).toBe(true)
  })

  it('allows SHOW and DESCRIBE metadata queries', () => {
    expect(guardSql('SHOW TABLES').allowed).toBe(true)
    expect(guardSql('DESCRIBE patients').allowed).toBe(true)
    expect(guardSql('DESC patients').allowed).toBe(true)
  })

  it('allows a SELECT with a trailing semicolon (single statement)', () => {
    const r = guardSql('SELECT 1;')
    expect(r.allowed).toBe(true)
  })

  it('allows a leading block comment before a SELECT', () => {
    const r = guardSql('/* dashboard: revenue */ SELECT count(*) FROM orders')
    expect(r.allowed).toBe(true)
    expect(r.statementType).toBe('SELECT')
  })
})

describe('guardSql — B1 comment-prefix bypass is REJECTED', () => {
  it('rejects a block-comment-prefixed DELETE', () => {
    const r = guardSql('/* x */ DELETE FROM eclinics."Shared"."Patients"')
    expect(r.allowed).toBe(false)
    expect(r.statementType).toBe('DELETE')
  })

  it('rejects a line-comment-prefixed DROP', () => {
    const r = guardSql('-- harmless\nDROP TABLE patients')
    expect(r.allowed).toBe(false)
    expect(r.statementType).toBe('DROP')
  })

  it('rejects an empty-block-comment-fused DELETE (no whitespace)', () => {
    const r = guardSql('/**/DELETE FROM t')
    expect(r.allowed).toBe(false)
    expect(r.statementType).toBe('DELETE')
  })

  it('rejects a nested-block-comment-prefixed UPDATE', () => {
    const r = guardSql('/* outer /* inner */ */ UPDATE t SET x = 1')
    expect(r.allowed).toBe(false)
    expect(r.statementType).toBe('UPDATE')
  })
})

describe('guardSql — MERGE / CALL / EXECUTE (the specific B1 gaps) are REJECTED', () => {
  it('rejects MERGE', () => {
    const r = guardSql('MERGE INTO target USING source ON target.id = source.id WHEN MATCHED THEN UPDATE SET x = 1')
    expect(r.allowed).toBe(false)
    expect(r.statementType).toBe('MERGE')
  })

  it('rejects CALL', () => {
    const r = guardSql('CALL system.runtime.kill_query(query_id => \'x\')')
    expect(r.allowed).toBe(false)
    expect(r.statementType).toBe('CALL')
  })

  it('rejects EXECUTE', () => {
    const r = guardSql('EXECUTE my_prepared_statement USING 1')
    expect(r.allowed).toBe(false)
    expect(r.statementType).toBe('EXECUTE')
  })
})

describe('guardSql — other write/DDL verbs are REJECTED', () => {
  it.each(['INSERT INTO t VALUES (1)', 'UPDATE t SET x=1', 'DROP TABLE t', 'CREATE TABLE t (a int)', 'ALTER TABLE t ADD COLUMN b int', 'TRUNCATE TABLE t', 'GRANT SELECT ON t TO u', 'REVOKE SELECT ON t FROM u', 'SET SESSION x = 1', 'USE catalog.schema'])(
    'rejects: %s',
    (sql) => {
      expect(guardSql(sql).allowed).toBe(false)
    }
  )
})

describe('guardSql — multi-statement injection is REJECTED', () => {
  it('rejects SELECT then DROP', () => {
    const r = guardSql('SELECT 1; DROP TABLE patients')
    expect(r.allowed).toBe(false)
    expect(r.reason).toMatch(/multiple/i)
  })

  it('rejects two SELECTs (still multi-statement)', () => {
    const r = guardSql('SELECT 1; SELECT 2')
    expect(r.allowed).toBe(false)
    expect(r.reason).toMatch(/multiple/i)
  })

  it('rejects a stacked statement hidden after a comment', () => {
    const r = guardSql('SELECT 1 /* */; DELETE FROM t')
    expect(r.allowed).toBe(false)
  })
})

describe('guardSql — semicolons inside string literals are NOT statement separators', () => {
  it('allows a SELECT whose string literal contains a semicolon', () => {
    const r = guardSql("SELECT 'a;b;c' AS s FROM t")
    expect(r.allowed).toBe(true)
    expect(r.statementType).toBe('SELECT')
  })

  it('allows a string literal containing a fake DELETE and semicolons', () => {
    const r = guardSql("SELECT notes FROM t WHERE notes = 'x; DELETE FROM t; --'")
    expect(r.allowed).toBe(true)
  })

  it('handles escaped single quotes inside a literal', () => {
    const r = guardSql("SELECT 'it''s a; test' FROM t")
    expect(r.allowed).toBe(true)
  })

  it('does not treat -- inside a string as a comment', () => {
    const r = guardSql("SELECT '-- not a comment; DROP' FROM t")
    expect(r.allowed).toBe(true)
  })

  it('does not treat a semicolon in a quoted identifier as a separator', () => {
    const r = guardSql('SELECT "weird;col" FROM t')
    expect(r.allowed).toBe(true)
  })
})

describe('guardSql — empty / malformed input', () => {
  it('rejects empty string', () => {
    expect(guardSql('').allowed).toBe(false)
  })

  it('rejects whitespace only', () => {
    expect(guardSql('   \n  ').allowed).toBe(false)
  })

  it('rejects a comment-only input (nothing executable)', () => {
    expect(guardSql('/* just a comment */').allowed).toBe(false)
    expect(guardSql('-- only a line comment').allowed).toBe(false)
  })

  it('rejects a WITH clause that never resolves to a SELECT', () => {
    const r = guardSql('WITH x AS (VALUES 1) INSERT INTO t SELECT * FROM x')
    // multi-token but leading WITH; must still be rejected because it is not a
    // pure read — the guard requires a SELECT and this is a write via CTE.
    expect(r.allowed).toBe(false)
  })
})

describe('guardSql — H25 table allowlist hook', () => {
  it('allows everything by default (permissive seam)', () => {
    expect(allowAllTables({ sql: 'SELECT * FROM anything' }).allowed).toBe(true)
  })

  it('rejects when a custom allowlist denies', () => {
    const r = guardSql('SELECT * FROM secret_table', { tableAllowlist: denySecret })
    expect(r.allowed).toBe(false)
    expect(r.reason).toBe('table not permitted')
  })

  it('passes catalog/schema through to the hook', () => {
    let seen: { catalog?: string; schema?: string } = {}
    const spy: TableAllowlistCheck = (input) => {
      seen = { catalog: input.catalog, schema: input.schema }
      return { allowed: true }
    }
    guardSql('SELECT 1', { catalog: 'eclinics', schema: 'Shared', tableAllowlist: spy })
    expect(seen).toEqual({ catalog: 'eclinics', schema: 'Shared' })
  })
})

describe('stripCommentsAndSplit — tokenizer directly', () => {
  it('splits top-level statements only', () => {
    expect(stripCommentsAndSplit('SELECT 1; SELECT 2').statements).toHaveLength(2)
  })

  it('does not split inside a string', () => {
    expect(stripCommentsAndSplit("SELECT 'a;b'").statements).toHaveLength(1)
  })

  it('drops a trailing empty statement from a trailing semicolon', () => {
    expect(stripCommentsAndSplit('SELECT 1;').statements).toHaveLength(1)
  })

  it('removes block and line comments from the stripped output', () => {
    const { stripped } = stripCommentsAndSplit('SELECT /* c */ 1 -- trailing\n')
    expect(stripped).not.toContain('/*')
    expect(stripped).not.toContain('trailing')
  })
})
