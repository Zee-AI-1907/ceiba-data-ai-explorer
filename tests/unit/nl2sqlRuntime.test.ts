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

  it('defaults everything to ts when nothing is set', () => {
    expect(umbrellaRuntime()).toBe('ts')
    expect(generateRuntime()).toBe('ts')
    expect(queryRuntime()).toBe('ts')
  })

  it('the umbrella NL2SQL_RUNTIME is inherited by both endpoints', () => {
    vi.stubEnv('NL2SQL_RUNTIME', 'python')
    expect(generateRuntime()).toBe('python')
    expect(queryRuntime()).toBe('python')
  })

  it('a per-endpoint flag overrides the umbrella', () => {
    vi.stubEnv('NL2SQL_RUNTIME', 'python')
    vi.stubEnv('NL2SQL_QUERY_RUNTIME', 'ts')
    expect(generateRuntime()).toBe('python')
    expect(queryRuntime()).toBe('ts')
  })

  it('warns exactly once when the two effective runtimes diverge', () => {
    vi.stubEnv('NL2SQL_GENERATE_RUNTIME', 'python') // query stays ts
    const logger = { warn: vi.fn() }
    expect(warnIfRuntimesDiverge(logger)).toBe(true)
    expect(warnIfRuntimesDiverge(logger)).toBe(true)
    expect(logger.warn).toHaveBeenCalledTimes(1)
    expect(logger.warn.mock.calls[0]![0]).toMatch(/RUNTIME DIVERGENCE/)
  })

  it('does NOT warn when the runtimes agree', () => {
    vi.stubEnv('NL2SQL_RUNTIME', 'python')
    const logger = { warn: vi.fn() }
    expect(warnIfRuntimesDiverge(logger)).toBe(false)
    expect(logger.warn).not.toHaveBeenCalled()
  })
})
