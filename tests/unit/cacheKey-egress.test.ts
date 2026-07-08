/**
 * Tests for Workstream H (PHI scrubbing & AI egress):
 *   • N4 — cache keys are tenant-scoped: same NL request from two orgs yields
 *     DIFFERENT keys, so one tenant can never read another's cached AI output.
 *   • H15/B5 — the aggregate profile builder emits NO raw row-level values (and
 *     never any value from a PHI-allowlisted column), so only schema + statistics
 *     leave the trust boundary.
 *   • B5/N1 — the BAA/residency egress gate defaults to closed and opens only
 *     when OPENAI_BAA_SIGNED === 'true'.
 *
 * Fixtures are synthetic placeholders — no real patient data.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { tenantCacheKey } from '@/lib/cache'
import {
  assertEgressAllowed,
  buildAggregateProfile,
  isEgressAllowed,
  renderAggregateProfileForPrompt,
  type Column,
} from '@/lib/phiScrubber'
import type { Session } from '@/lib/apiAuth'

const orgA: Pick<Session, 'orgId'> = { orgId: 'org-alpha' }
const orgB: Pick<Session, 'orgId'> = { orgId: 'org-bravo' }

describe('tenantCacheKey — cross-tenant isolation (N4)', () => {
  it('produces different keys for the same request material across orgs', () => {
    const keyA = tenantCacheKey(orgA, 'chart-suggest', 'show admissions by ward', 'ward,count')
    const keyB = tenantCacheKey(orgB, 'chart-suggest', 'show admissions by ward', 'ward,count')
    expect(keyA).not.toBe(keyB)
  })

  it('produces identical keys for the same org + same material (cache hit stays in-org)', () => {
    const keyA1 = tenantCacheKey(orgA, 'sql-generate', 'count patients', '')
    const keyA2 = tenantCacheKey(orgA, 'sql-generate', 'count patients', '')
    expect(keyA1).toBe(keyA2)
  })

  it('prefixes the key with the clear-text org id so the boundary is structural', () => {
    const key = tenantCacheKey(orgA, 'narrative', 'summarise')
    expect(key.startsWith('org:org-alpha:')).toBe(true)
  })

  it('differs when the request material differs within the same org', () => {
    const k1 = tenantCacheKey(orgA, 'sql-generate', 'count patients', '')
    const k2 = tenantCacheKey(orgA, 'sql-generate', 'count admissions', '')
    expect(k1).not.toBe(k2)
  })
})

// A dataset mixing PHI columns with clinical/numeric/categorical columns.
const COLUMNS: Column[] = [
  { key: 'patientId', label: 'Patient ID', type: 'text' },
  { key: 'firstName', label: 'First Name', type: 'text' },
  { key: 'ssn', label: 'SSN', type: 'text' },
  { key: 'email', label: 'Email', type: 'text' },
  { key: 'ward', label: 'Ward', type: 'text' },
  { key: 'lengthOfStay', label: 'LOS (days)', type: 'number' },
]

const ROWS: Record<string, unknown>[] = [
  { patientId: 'SYNTH-1', firstName: 'Casey', ssn: '000-00-0001', email: 'casey@example.test', ward: 'Cardiology', lengthOfStay: 3 },
  { patientId: 'SYNTH-2', firstName: 'Jordan', ssn: '000-00-0002', email: 'jordan@example.test', ward: 'Oncology', lengthOfStay: 7 },
  { patientId: 'SYNTH-3', firstName: 'Riley', ssn: '000-00-0003', email: 'riley@example.test', ward: 'Cardiology', lengthOfStay: 5 },
]

describe('buildAggregateProfile — no raw row-level PHI egresses (H15/B5)', () => {
  const profile = buildAggregateProfile(ROWS, COLUMNS)
  const serialized = JSON.stringify(profile)

  it('marks PHI-allowlisted columns as phi-suppressed with no values', () => {
    const phiCols = profile.columns.filter((c) =>
      ['patientId', 'firstName', 'ssn', 'email'].includes(c.key)
    )
    for (const col of phiCols) {
      expect(col.kind).toBe('phi-suppressed')
      expect(col.topCategories).toBeUndefined()
      expect(col.min).toBeUndefined()
    }
  })

  it('contains NO raw value from any PHI column anywhere in the payload', () => {
    const rawPhiValues = [
      'SYNTH-1', 'SYNTH-2', 'SYNTH-3',
      'Casey', 'Jordan', 'Riley',
      '000-00-0001', '000-00-0002', '000-00-0003',
      'casey@example.test', 'jordan@example.test', 'riley@example.test',
    ]
    for (const value of rawPhiValues) {
      expect(serialized).not.toContain(value)
    }
  })

  it('collapses numeric columns to min/max/mean only, echoing no individual value', () => {
    const los = profile.columns.find((c) => c.key === 'lengthOfStay')
    expect(los?.kind).toBe('numeric')
    expect(los?.min).toBe(3)
    expect(los?.max).toBe(7)
    expect(los?.mean).toBe(5)
  })

  it('surfaces non-PHI low-cardinality category labels (aggregates, not rows)', () => {
    const ward = profile.columns.find((c) => c.key === 'ward')
    expect(ward?.kind).toBe('categorical')
    const cardiology = ward?.topCategories?.find((t) => t.value === 'Cardiology')
    expect(cardiology?.count).toBe(2)
  })

  it('suppresses category labels for high-cardinality non-PHI columns (id-like)', () => {
    const highCardCols: Column[] = [{ key: 'accountCode', label: 'Account', type: 'text' }]
    const highCardRows = Array.from({ length: 40 }, (_unused, i) => ({ accountCode: `ACCT-${i}` }))
    const p = buildAggregateProfile(highCardRows, highCardCols)
    const col = p.columns[0]
    expect(col.kind).toBe('categorical')
    expect(col.topCategories).toBeUndefined()
    expect(col.distinctCount).toBe(40)
    // None of the raw account codes leak.
    expect(JSON.stringify(p)).not.toContain('ACCT-0')
  })

  it('rendered prompt string contains only schema + stats, no raw PHI', () => {
    const rendered = renderAggregateProfileForPrompt(profile)
    expect(rendered).toContain('Column statistics')
    expect(rendered).not.toContain('Casey')
    expect(rendered).not.toContain('000-00-0001')
    expect(rendered).toContain('Cardiology') // non-PHI aggregate label is allowed
  })
})

describe('BAA/residency egress gate (B5/N1)', () => {
  const original = process.env.OPENAI_BAA_SIGNED

  afterEach(() => {
    if (original === undefined) delete process.env.OPENAI_BAA_SIGNED
    else process.env.OPENAI_BAA_SIGNED = original
  })

  it('defaults to closed when the flag is unset', () => {
    delete process.env.OPENAI_BAA_SIGNED
    expect(isEgressAllowed()).toBe(false)
    const decision = assertEgressAllowed()
    expect(decision.allowed).toBe(false)
    expect(decision.reason).toBe('baa_not_signed')
  })

  it('stays closed for any value other than the exact string "true"', () => {
    process.env.OPENAI_BAA_SIGNED = 'TRUE'
    expect(isEgressAllowed()).toBe(false)
    process.env.OPENAI_BAA_SIGNED = '1'
    expect(isEgressAllowed()).toBe(false)
    process.env.OPENAI_BAA_SIGNED = 'yes'
    expect(isEgressAllowed()).toBe(false)
  })

  it('opens only when the flag is exactly "true"', () => {
    process.env.OPENAI_BAA_SIGNED = 'true'
    expect(isEgressAllowed()).toBe(true)
    expect(assertEgressAllowed().allowed).toBe(true)
  })
})
