/**
 * nl2sqlRuntime.test.ts — umbrella runtime-flag resolution + divergence guard
 * (docs/PYTHON_NL2SQL_SERVICE_PLAN.md §7.3).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  generateRuntime,
  queryRuntime,
  umbrellaRuntime,
  warnIfRuntimesDiverge,
  __resetDivergenceWarningForTest,
} from '@/lib/nl2sqlRuntime'

describe('nl2sqlRuntime — flag resolution', () => {
  beforeEach(() => {
    __resetDivergenceWarningForTest()
  })
  afterEach(() => {
    vi.unstubAllEnvs()
    __resetDivergenceWarningForTest()
  })

  it('defaults everything to python when nothing is set (2026-07 cutover)', () => {
    // Python is the authoritative runtime — it carries the single-source native
    // routing (docs/research/DUCKDB_PUSHDOWN.md §5.1) the TS engine cannot.
    expect(umbrellaRuntime()).toBe('python')
    expect(generateRuntime()).toBe('python')
    expect(queryRuntime()).toBe('python')
  })

  it('the umbrella NL2SQL_RUNTIME=ts rolls both endpoints back to TS', () => {
    vi.stubEnv('NL2SQL_RUNTIME', 'ts')
    expect(generateRuntime()).toBe('ts')
    expect(queryRuntime()).toBe('ts')
  })

  it('a per-endpoint flag overrides the umbrella', () => {
    vi.stubEnv('NL2SQL_RUNTIME', 'ts')
    vi.stubEnv('NL2SQL_QUERY_RUNTIME', 'python')
    expect(generateRuntime()).toBe('ts')
    expect(queryRuntime()).toBe('python')
  })

  it('warns exactly once when the two effective runtimes diverge', () => {
    vi.stubEnv('NL2SQL_GENERATE_RUNTIME', 'ts') // query stays python (default)
    const logger = { warn: vi.fn() }
    expect(warnIfRuntimesDiverge(logger)).toBe(true)
    expect(warnIfRuntimesDiverge(logger)).toBe(true)
    expect(logger.warn).toHaveBeenCalledTimes(1)
    expect(logger.warn.mock.calls[0]![0]).toMatch(/RUNTIME DIVERGENCE/)
  })

  it('does NOT warn when the runtimes agree', () => {
    vi.stubEnv('NL2SQL_RUNTIME', 'ts')
    const logger = { warn: vi.fn() }
    expect(warnIfRuntimesDiverge(logger)).toBe(false)
    expect(logger.warn).not.toHaveBeenCalled()
  })
})
