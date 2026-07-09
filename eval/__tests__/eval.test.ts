/**
 * eval.test.ts — NL2SQL_PLAN.md §P6 CI test: runs a tiny golden subset + the
 * full adversarial subset in CI (synthetic mode, stub/recorded LLM — no
 * network, no mock/staging DB, no model download; NL2SQL_PLAN.md §0 ground
 * rule #4, SPEC §6.3(a)).
 *
 * Asserts (SPEC §6 DoD):
 *   - the two canonical golden questions score `executes:true` on the
 *     synthetic topology (`eval/synthetic/loadSynthetic.ts`);
 *   - every adversarial (prompt-injection/write-attempt) item scores
 *     `guardPasses:false` — the guard + read-only role hold regardless of
 *     what the recorded/stub driving LLM was coaxed into emitting;
 *   - a guard failure is treated as a HARD failure (scoreCandidate never
 *     calls explain/execute on guard-rejected SQL — verified indirectly via
 *     every adversarial item's `parses`/`cardinalityBounded`/`executes`
 *     all being false alongside `guardPasses:false`);
 *   - the retriever is exercised against the real fixture bundle catalog
 *     (not a hand-authored stub) for every item.
 */

import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { loadAdversarialSet, loadGoldenSet, runAdversarial, runEval, DEFAULT_FIXTURE_BUNDLE_DIR } from '../runEval'

describe('eval harness — synthetic mode golden subset (SPEC §6.3(a), hermetic/CI-safe)', () => {
  it('loads the full golden set with at least 10 questions covering temporal/aggregate/join/multi-db tags', async () => {
    const golden = await loadGoldenSet()
    expect(golden.length).toBeGreaterThanOrEqual(10)

    const allTags = new Set(golden.flatMap((g) => g.tags))
    expect(allTags.has('temporal')).toBe(true)
    expect(allTags.has('aggregate')).toBe(true)
    expect(allTags.has('join')).toBe(true)
    expect(allTags.has('multi-db')).toBe(true)
  })

  it('the two canonical questions ("heart rate > 120 in last 3 hours", "patients admitted yesterday") execute cleanly on the synthetic topology', async () => {
    const golden = await loadGoldenSet(path.join(__dirname, '..', 'golden'))
    const canonical = golden.filter((g) => g.id === 'g_hr_over_120_last_3h' || g.id === 'g_patients_admitted_yesterday')
    expect(canonical).toHaveLength(2)

    const { report, items, mode } = await runEval(canonical)

    expect(mode).toBe('synthetic')
    expect(report.bundleVersion.length).toBeGreaterThan(0)
    expect(report.drivingModel.length).toBeGreaterThan(0)

    for (const item of items) {
      expect(item.error, `question "${item.question}" errored: ${item.error}`).toBeUndefined()
      expect(item.score.guardPasses, `guardPasses for "${item.question}"`).toBe(true)
      expect(item.score.parses, `parses for "${item.question}"`).toBe(true)
      expect(item.score.cardinalityBounded, `cardinalityBounded for "${item.question}"`).toBe(true)
      expect(item.score.executes, `executes for "${item.question}"`).toBe(true)
      expect(item.score.referencesRealTables, `referencesRealTables for "${item.question}"`).toBe(true)
    }
  }, 30_000)

  it('runs the full golden set and produces a well-formed EvalReport keyed on bundleVersion', async () => {
    const golden = await loadGoldenSet()
    const { report, items, mode } = await runEval(golden)

    expect(mode).toBe('synthetic')
    expect(items).toHaveLength(golden.length)
    expect(report.overall.guardPassRate).toBeGreaterThan(0)
    expect(report.overall.parseRate).toBeGreaterThan(0)
    expect(report.overall.executionAccuracy).toBeGreaterThan(0)
    expect(report.overall.validTableRate).toBe(1)
    expect(report.latencyMsP50).toBeGreaterThanOrEqual(0)
    expect(report.tokenCostTotal).toBeGreaterThan(0)
    expect(Object.keys(report.perTag).length).toBeGreaterThan(0)

    // Every guard-passing item must actually execute on the synthetic topology
    // (the DoD's "cross-source question validated on the synthetic topology"
    // requirement — every golden item's referenced tables live in the
    // synthetic mock.public schema built by loadSynthetic.ts).
    const guardPassingItems = items.filter((i) => i.score.guardPasses)
    expect(guardPassingItems.length).toBe(items.length)
    for (const item of guardPassingItems) {
      expect(item.score.executes, `executes for "${item.question}" (sql: ${item.sql})`).toBe(true)
    }
  }, 60_000)

  it('the cross-source/join question (hospital region via patient->hospital) validates on the synthetic topology', async () => {
    const golden = await loadGoldenSet()
    const crossSource = golden.find((g) => g.id === 'g_patients_by_hospital_region')
    expect(crossSource).toBeDefined()

    const { items } = await runEval([crossSource!])
    expect(items).toHaveLength(1)
    expect(items[0]!.score.guardPasses).toBe(true)
    expect(items[0]!.score.executes).toBe(true)
  }, 30_000)
})

describe('eval harness — adversarial subset (SPEC §6.2 "guard + read-only role hold")', () => {
  it('loads the adversarial set with injection + write-attempt questions', async () => {
    const adversarial = await loadAdversarialSet()
    expect(adversarial.length).toBeGreaterThanOrEqual(5)
    const allTags = new Set(adversarial.flatMap((a) => a.tags))
    expect(allTags.has('injection')).toBe(true)
  })

  it('EVERY adversarial item is rejected: guardPasses:false, and a guard failure is a hard failure (parses/cardinalityBounded/executes also false)', async () => {
    const adversarial = await loadAdversarialSet()
    const results = await runAdversarial(adversarial)

    expect(results).toHaveLength(adversarial.length)
    for (const result of results) {
      expect(result.score.guardPasses, `guardPasses for adversarial "${result.question}"`).toBe(false)
      // Hard failure (SPEC §6.2): a rejected candidate is NEVER explained or
      // executed, so every other dimension must also read false/null — this
      // is scoreCandidate's short-circuit, not a coincidence.
      expect(result.score.parses, `parses for adversarial "${result.question}"`).toBe(false)
      expect(result.score.cardinalityBounded, `cardinalityBounded for adversarial "${result.question}"`).toBe(false)
      expect(result.score.executes, `executes for adversarial "${result.question}"`).toBe(false)
      expect(result.score.resultMatch, `resultMatch for adversarial "${result.question}"`).toBeNull()
    }
  }, 30_000)

  it('resolves the fixture bundle directory used by default (sanity: the eval harness targets the committed P4 bundle)', () => {
    expect(DEFAULT_FIXTURE_BUNDLE_DIR.endsWith(path.join('fixtures', 'bundles', 'mock-v1'))).toBe(true)
  })
})

describe('eval harness — gated staging mode stays off by default', () => {
  it('falls back to synthetic mode when gated-staging is requested without allowGatedStaging + STAGING_DSN', async () => {
    const golden = await loadGoldenSet()
    const canonical = golden.filter((g) => g.id === 'g_hr_over_120_last_3h')

    const originalStagingDsn = process.env.STAGING_DSN
    delete process.env.STAGING_DSN
    try {
      const { mode } = await runEval(canonical, { mode: 'gated-staging' })
      expect(mode).toBe('synthetic')
    } finally {
      if (originalStagingDsn !== undefined) process.env.STAGING_DSN = originalStagingDsn
    }
  }, 30_000)
})
