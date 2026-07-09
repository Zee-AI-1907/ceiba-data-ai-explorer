/**
 * cardinalityGuard.test.ts — Fix C strengthened selective-predicate policy
 * (lib/rag/cardinalityGuard.ts). NEW dedicated test file (previously only
 * exercised indirectly via thinSlice.test.ts's hand-authored options, which
 * had no selective-predicate-escape-hatch coverage).
 */

import { describe, expect, it } from 'vitest'
import { buildCardinalityGuardOptions, cardinalityGuard, type LargeTableSpec } from '../cardinalityGuard'
import type { RenderedTable, SchemaContext } from '../Retriever'

const LARGE_TABLE: LargeTableSpec = { tableName: 'MeasurementsMock', quotedRef: '"public"."MeasurementsMock"' }
const REQUIRED_TIME_COLUMN = { MeasurementsMock: 'RecordedAt' }

const VENTILATOR_TABLE: LargeTableSpec = {
  tableName: 'VentilatorMeasurements',
  quotedRef: '"Shared"."VentilatorMeasurements"',
  selectiveColumns: ['PatientId', 'DeviceId'],
}

describe('cardinalityGuard — existing time-bound behavior unchanged', () => {
  it('passes when no large table is referenced', () => {
    const verdict = cardinalityGuard('SELECT * FROM "VisitMock" LIMIT 10', {
      largeTables: [LARGE_TABLE],
      requiredTimeColumnByTable: REQUIRED_TIME_COLUMN,
    })
    expect(verdict.ok).toBe(true)
    expect(verdict.action).toBe('pass')
  })

  it('passes when bounded and limited', () => {
    const sql = `SELECT * FROM "MeasurementsMock" WHERE "RecordedAt" >= now() - INTERVAL '3 hours' LIMIT 1000`
    const verdict = cardinalityGuard(sql, { largeTables: [LARGE_TABLE], requiredTimeColumnByTable: REQUIRED_TIME_COLUMN })
    expect(verdict.ok).toBe(true)
    expect(verdict.action).toBe('pass')
  })

  it('rejects when wholly unbounded (no time predicate, no selective predicate)', () => {
    const verdict = cardinalityGuard('SELECT * FROM "MeasurementsMock" WHERE "Value" > 120', {
      largeTables: [LARGE_TABLE],
      requiredTimeColumnByTable: REQUIRED_TIME_COLUMN,
    })
    expect(verdict.ok).toBe(false)
    expect(verdict.action).toBe('reject')
  })
})

describe('cardinalityGuard — Fix C: selective equality/IN predicate escape hatch', () => {
  it('rejects a bare COUNT/scan with a LIMIT but no selective filter at all (271M-row analog)', () => {
    const verdict = cardinalityGuard('SELECT COUNT(*) FROM "VentilatorMeasurements" LIMIT 1000', {
      largeTables: [VENTILATOR_TABLE],
      requiredTimeColumnByTable: {},
    })
    expect(verdict.ok).toBe(false)
    expect(verdict.action).toBe('reject')
    expect(verdict.reason?.toLowerCase()).toContain('selective')
  })

  it('rejects the same bare scan with no LIMIT either', () => {
    const verdict = cardinalityGuard('SELECT COUNT(*) FROM "VentilatorMeasurements"', {
      largeTables: [VENTILATOR_TABLE],
      requiredTimeColumnByTable: {},
    })
    expect(verdict.ok).toBe(false)
    expect(verdict.action).toBe('reject')
  })

  it('passes with a selective equality predicate and no requiredTimeColumn configured', () => {
    const verdict = cardinalityGuard('SELECT * FROM "VentilatorMeasurements" WHERE "PatientId" = 42 LIMIT 1000', {
      largeTables: [VENTILATOR_TABLE],
      requiredTimeColumnByTable: {},
    })
    expect(verdict.ok).toBe(true)
    expect(verdict.action).toBe('pass')
  })

  it('repairs (appends LIMIT) when the selective predicate is present but LIMIT is missing', () => {
    const verdict = cardinalityGuard('SELECT * FROM "VentilatorMeasurements" WHERE "PatientId" = 42', {
      largeTables: [VENTILATOR_TABLE],
      requiredTimeColumnByTable: {},
      defaultLimit: 250,
    })
    expect(verdict.ok).toBe(true)
    expect(verdict.action).toBe('repair')
    expect(verdict.repairedSql).toContain('LIMIT 250')
  })

  it('passes with a selective IN predicate', () => {
    const verdict = cardinalityGuard('SELECT * FROM "VentilatorMeasurements" WHERE "DeviceId" IN (1, 2, 3) LIMIT 1000', {
      largeTables: [VENTILATOR_TABLE],
      requiredTimeColumnByTable: {},
    })
    expect(verdict.ok).toBe(true)
    expect(verdict.action).toBe('pass')
  })

  it('does not satisfy the escape hatch when the filtered column is not selective', () => {
    const verdict = cardinalityGuard(`SELECT * FROM "VentilatorMeasurements" WHERE "SomeUnindexedNote" = 'x' LIMIT 1000`, {
      largeTables: [VENTILATOR_TABLE],
      requiredTimeColumnByTable: {},
    })
    expect(verdict.ok).toBe(false)
    expect(verdict.action).toBe('reject')
  })

  it('the selective-predicate alternative also satisfies the policy when a requiredTimeColumn IS configured', () => {
    const table: LargeTableSpec = { tableName: 'MeasurementsMock', quotedRef: '"public"."MeasurementsMock"', selectiveColumns: ['PatientId'] }
    const verdict = cardinalityGuard('SELECT * FROM "MeasurementsMock" WHERE "PatientId" = 42 LIMIT 1000', {
      largeTables: [table],
      requiredTimeColumnByTable: REQUIRED_TIME_COLUMN,
    })
    expect(verdict.ok).toBe(true)
    expect(verdict.action).toBe('pass')
  })

  it('the repair hint mentions both the time-bound and the selective-filter options', () => {
    const table: LargeTableSpec = { tableName: 'MeasurementsMock', quotedRef: '"public"."MeasurementsMock"', selectiveColumns: ['DeviceId'] }
    const verdict = cardinalityGuard('SELECT * FROM "MeasurementsMock" LIMIT 1000', {
      largeTables: [table],
      requiredTimeColumnByTable: REQUIRED_TIME_COLUMN,
    })
    expect(verdict.ok).toBe(false)
    expect(verdict.repairHint).toContain('time-bound predicate')
    expect(verdict.repairHint).toContain('equality/IN filter')
  })
})

describe('buildCardinalityGuardOptions — derives selectiveColumns from RenderedTable columns', () => {
  it('collects indexed and FK/PK columns', () => {
    const ctx: Pick<SchemaContext, 'tables'> = {
      tables: [
        {
          tableId: 'staging.Shared.VentilatorMeasurements',
          quotedRef: '"Shared"."VentilatorMeasurements"',
          grain: 'g',
          columns: [
            { name: 'Id', quotedName: '"Id"', dataType: 'INTEGER', isTimeColumn: false, isForeignKeyOrPrimaryKey: true },
            { name: 'PatientId', quotedName: '"PatientId"', dataType: 'INTEGER', isTimeColumn: false, isForeignKeyOrPrimaryKey: true },
            { name: 'Value', quotedName: '"Value"', dataType: 'DOUBLE', isTimeColumn: false },
          ],
          approxRowCount: 271_000_000,
          isLargeTimeSeries: true,
          role: 'primary',
        } as RenderedTable,
      ],
    }
    const { largeTables } = buildCardinalityGuardOptions(ctx)
    expect(largeTables).toHaveLength(1)
    expect(new Set(largeTables[0]!.selectiveColumns)).toEqual(new Set(['Id', 'PatientId']))
  })
})
