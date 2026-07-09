/**
 * sqlGuardParity.test.ts — the TS half of the cross-runtime guard parity check
 * (docs/PYTHON_NL2SQL_SERVICE_PLAN.md §1.3).
 *
 * Runs a SHARED adversarial + benign corpus (tests/fixtures/sqlGuardParityCorpus.json)
 * through lib/sqlGuard.ts and asserts the TS guard's verdict matches the corpus's
 * recorded `tsRejected` value. The Python half (ceiba_nl2sql/tests/test_sqlguard_parity.py)
 * reads the SAME corpus and asserts the Python guard is AT LEAST as strict as the TS
 * guard (rejects everything TS rejects). Together they prove the intended relationship:
 * the Python guard is never MORE permissive than the TS guard.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { guardSql } from '@/lib/sqlGuard'

interface Corpus {
  cases: { name: string; sql: string; tsRejected: boolean }[]
}

const corpus = JSON.parse(
  readFileSync(join(__dirname, '..', 'fixtures', 'sqlGuardParityCorpus.json'), 'utf8')
) as Corpus

describe('sqlGuard parity — TS guard matches the shared corpus labels', () => {
  for (const testCase of corpus.cases) {
    it(`${testCase.name} -> ${testCase.tsRejected ? 'rejected' : 'allowed'}`, () => {
      const rejected = !guardSql(testCase.sql).allowed
      expect(rejected).toBe(testCase.tsRejected)
    })
  }
})
