import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { DuckDbEngine, NonReadOnlyAttachError } from '../DuckDbEngine'
import type { AttachSpec } from '../QueryEngine'

describe('DuckDbEngine', () => {
  let engine: DuckDbEngine

  beforeEach(() => {
    engine = new DuckDbEngine()
  })

  afterEach(async () => {
    await engine.dispose()
  })

  it('reports dialect and capabilities per SPEC §3.1', () => {
    expect(engine.dialect()).toBe('duckdb')
    expect(engine.capabilities()).toEqual({
      supportsCrossCatalogJoin: true,
      identifierQuote: '"',
      intervalSyntax: 'ansi',
      supportsExplain: true,
    })
  })

  it('execute() clamps to maxRows and reports truncated:true when exceeded', async () => {
    const result = await engine.execute('SELECT * FROM range(50) t(x)', { maxRows: 10, deadlineMs: 5_000 })
    expect(result.rows).toHaveLength(10)
    expect(result.rowCount).toBe(10)
    expect(result.truncated).toBe(true)
    expect(result.columns).toEqual([{ name: 'x', type: 'BIGINT' }])
  })

  it('execute() reports truncated:false when the result fits under maxRows', async () => {
    const result = await engine.execute('SELECT * FROM range(3) t(x)', { maxRows: 10, deadlineMs: 5_000 })
    expect(result.rows).toHaveLength(3)
    expect(result.truncated).toBe(false)
  })

  it('execute() aborts at deadlineMs for a long-running query', async () => {
    // A cartesian product large enough that DuckDB cannot finish inside the tiny
    // deadline, proving the wall-clock budget (mirrors trinoClient STATEMENT_DEADLINE_MS)
    // actually interrupts the connection rather than merely racing a timer that never
    // fires before the query would have finished anyway.
    const slowSql = 'SELECT count(*) FROM range(200000000) a(x), range(1000) b(y)'
    await expect(engine.execute(slowSql, { maxRows: 10, deadlineMs: 50 })).rejects.toThrow(/deadlineMs/)
  }, 20_000)

  it('attach() rejects a non-READ_ONLY spec with a hard error', async () => {
    const badSpec = {
      sourceId: 'evil',
      engine: 'duckdb',
      dsn: ':memory:',
      readOnly: false,
      alias: 'evil',
      // Cast through unknown to simulate a spec built dynamically (e.g. from JSON)
      // that bypasses the `readOnly: true` literal type at compile time.
    } as unknown as AttachSpec
    await expect(engine.attach([badSpec])).rejects.toThrow(NonReadOnlyAttachError)
  })

  it('explain() surfaces a bind error as {ok:false} without returning rows', async () => {
    const verdict = await engine.explain('SELECT * FROM this_table_does_not_exist', {})
    expect(verdict.ok).toBe(false)
    if (!verdict.ok) {
      expect(verdict.error).toMatch(/this_table_does_not_exist/i)
    }
    // Type-level guarantee that a false verdict never carries a `plan`/rows field.
    expect('plan' in verdict).toBe(false)
  })

  it('explain() returns {ok:true, plan} for valid SQL and never rows', async () => {
    const verdict = await engine.explain('SELECT 1 AS one', {})
    expect(verdict.ok).toBe(true)
    if (verdict.ok) {
      expect(typeof verdict.plan).toBe('string')
      expect(verdict.plan.length).toBeGreaterThan(0)
    }
  })
})
