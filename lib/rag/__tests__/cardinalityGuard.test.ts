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

describe('cardinalityGuard — parent-join time bound (cardinality-guard remediation)', () => {
  // The real staging.Shared.MonitorMeasurements / Monitors topology: a
  // 344M-row measurement table with NO own time column, whose time
  // dimension lives on the joined parent Monitors.MeasuredDate, reached via
  // MonitorMeasurements.DeviceId -> Monitors.Id.
  const MONITOR_MEASUREMENTS_TABLE: LargeTableSpec = {
    tableName: 'MonitorMeasurements',
    quotedRef: '"Shared"."MonitorMeasurements"',
    selectiveColumns: ['DeviceId', 'MeasurementTypeId', 'Id'],
    parentTimeBound: {
      parentTableName: 'Monitors',
      parentTimeColumn: 'MeasuredDate',
      fromColumns: ['DeviceId'],
      toColumns: ['Id'],
    },
  }
  const MONITORS_TABLE: LargeTableSpec = {
    tableName: 'Monitors',
    quotedRef: '"Shared"."Monitors"',
    selectiveColumns: ['Id'],
  }
  const REQUIRED_TIME_COLUMNS = { Monitors: 'MeasuredDate' }

  const PRIMARY_REPRO_SQL = `SELECT p."Id" FROM "Patients" p
JOIN "Acceptances" a ON a."PatientId" = p."Id"
JOIN "Monitors" m ON m."AcceptanceId" = a."Id"
JOIN "MonitorMeasurements" mm ON mm."DeviceId" = m."Id"
WHERE m."MeasuredDate" >= now() - INTERVAL '3' HOUR AND mm."MeasurementTypeId" = 2
LIMIT 1000`

  it('the exact HR multi-hop repro passes: FK join to a time-bounded parent bounds the large table', () => {
    const verdict = cardinalityGuard(PRIMARY_REPRO_SQL, {
      largeTables: [MONITOR_MEASUREMENTS_TABLE, MONITORS_TABLE],
      requiredTimeColumnByTable: REQUIRED_TIME_COLUMNS,
    })
    expect(verdict.ok).toBe(true)
    expect(verdict.action).toBe('pass')
  })

  it('an FK-equality filter alone (no time bound at all) still bounds via the selective-predicate escape hatch', () => {
    const sql = `SELECT mm."Value" FROM "MonitorMeasurements" mm WHERE mm."MeasurementTypeId" = 2 LIMIT 1000`
    const verdict = cardinalityGuard(sql, {
      largeTables: [MONITOR_MEASUREMENTS_TABLE],
      requiredTimeColumnByTable: {},
    })
    expect(verdict.ok).toBe(true)
    expect(verdict.action).toBe('pass')
  })

  it('rejects when joined to the parent but no time bound (or any filter) exists anywhere', () => {
    const sql = `SELECT p."Id" FROM "Patients" p
JOIN "Acceptances" a ON a."PatientId" = p."Id"
JOIN "Monitors" m ON m."AcceptanceId" = a."Id"
JOIN "MonitorMeasurements" mm ON mm."DeviceId" = m."Id"
LIMIT 1000`
    const verdict = cardinalityGuard(sql, {
      largeTables: [MONITOR_MEASUREMENTS_TABLE, MONITORS_TABLE],
      requiredTimeColumnByTable: REQUIRED_TIME_COLUMNS,
    })
    expect(verdict.ok).toBe(false)
    expect(verdict.action).toBe('reject')
  })

  it('does NOT credit a parent time bound when the join uses the WRONG columns', () => {
    const sql = `SELECT p."Id" FROM "Patients" p
JOIN "Acceptances" a ON a."PatientId" = p."Id"
JOIN "Monitors" m ON m."AcceptanceId" = a."Id"
JOIN "MonitorMeasurements" mm ON mm."Id" = m."Id"
WHERE m."MeasuredDate" >= now() - INTERVAL '3' HOUR
LIMIT 1000`
    const verdict = cardinalityGuard(sql, {
      largeTables: [MONITOR_MEASUREMENTS_TABLE, MONITORS_TABLE],
      requiredTimeColumnByTable: REQUIRED_TIME_COLUMNS,
    })
    expect(verdict.ok).toBe(false)
    expect(verdict.action).toBe('reject')
  })

  it('still rejects a truly unbounded scan of the large table (no time bound, no selective filter, no parent join)', () => {
    const sql = `SELECT COUNT(*) FROM "MonitorMeasurements" mm LIMIT 1000`
    const verdict = cardinalityGuard(sql, {
      largeTables: [MONITOR_MEASUREMENTS_TABLE],
      requiredTimeColumnByTable: {},
    })
    expect(verdict.ok).toBe(false)
    expect(verdict.action).toBe('reject')
  })
})

describe('cardinalityGuard — a bare JOIN ... ON equality on an FK/indexed column is NOT a selective filter', () => {
  it('rejects a full join-scan whose ONLY equality anywhere is the JOIN ON condition itself', () => {
    const table: LargeTableSpec = {
      tableName: 'MonitorMeasurements',
      quotedRef: '"Shared"."MonitorMeasurements"',
      selectiveColumns: ['DeviceId'],
    }
    const sql = `SELECT * FROM "Monitors" m JOIN "MonitorMeasurements" mm ON mm."DeviceId" = m."Id" LIMIT 1000`
    const verdict = cardinalityGuard(sql, { largeTables: [table], requiredTimeColumnByTable: {} })
    expect(verdict.ok).toBe(false)
    expect(verdict.action).toBe('reject')
  })

  it('still passes when the SAME column is filtered in a genuine WHERE clause (not just the JOIN ON)', () => {
    const table: LargeTableSpec = {
      tableName: 'MonitorMeasurements',
      quotedRef: '"Shared"."MonitorMeasurements"',
      selectiveColumns: ['DeviceId'],
    }
    const sql = `SELECT * FROM "Monitors" m JOIN "MonitorMeasurements" mm ON mm."DeviceId" = m."Id" WHERE mm."DeviceId" = 42 LIMIT 1000`
    const verdict = cardinalityGuard(sql, { largeTables: [table], requiredTimeColumnByTable: {} })
    expect(verdict.ok).toBe(true)
    expect(verdict.action).toBe('pass')
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

describe('buildCardinalityGuardOptions — derives parentTimeBound from RenderedTable.timeVia', () => {
  it('resolves the parent bare table name from the rendered tables when the parent is also rendered', () => {
    const ctx: Pick<SchemaContext, 'tables'> = {
      tables: [
        {
          tableId: 'staging.Shared.MonitorMeasurements',
          quotedRef: '"Shared"."MonitorMeasurements"',
          grain: 'g',
          columns: [],
          approxRowCount: 344_225_600,
          isLargeTimeSeries: true,
          role: 'primary',
          timeVia: { table: 'staging.Shared.Monitors', column: 'MeasuredDate', fromColumns: ['DeviceId'], toColumns: ['Id'] },
        } as RenderedTable,
        {
          tableId: 'staging.Shared.Monitors',
          quotedRef: '"Shared"."Monitors"',
          grain: 'g',
          columns: [],
          approxRowCount: 59_727_804,
          isLargeTimeSeries: true,
          requiredTimeColumn: '"MeasuredDate"',
          role: 'primary',
        } as RenderedTable,
      ],
    }
    const { largeTables } = buildCardinalityGuardOptions(ctx)
    const mm = largeTables.find((t) => t.tableName === 'MonitorMeasurements')
    expect(mm?.parentTimeBound).toEqual({
      parentTableName: 'Monitors',
      parentTimeColumn: 'MeasuredDate',
      fromColumns: ['DeviceId'],
      toColumns: ['Id'],
    })
  })

  it('falls back to the tail tableId segment when the parent table was not itself rendered', () => {
    const ctx: Pick<SchemaContext, 'tables'> = {
      tables: [
        {
          tableId: 'staging.Shared.MonitorMeasurements',
          quotedRef: '"Shared"."MonitorMeasurements"',
          grain: 'g',
          columns: [],
          approxRowCount: 344_225_600,
          isLargeTimeSeries: true,
          role: 'primary',
          timeVia: { table: 'staging.Shared.Monitors', column: 'MeasuredDate', fromColumns: ['DeviceId'], toColumns: ['Id'] },
        } as RenderedTable,
      ],
    }
    const { largeTables } = buildCardinalityGuardOptions(ctx)
    expect(largeTables[0]?.parentTimeBound?.parentTableName).toBe('Monitors')
  })

  it('leaves parentTimeBound undefined when timeVia is absent', () => {
    const ctx: Pick<SchemaContext, 'tables'> = {
      tables: [
        {
          tableId: 'mock.public.MeasurementsMock',
          quotedRef: '"public"."MeasurementsMock"',
          grain: 'g',
          columns: [],
          approxRowCount: 483,
          isLargeTimeSeries: true,
          requiredTimeColumn: '"RecordedAt"',
          role: 'primary',
        } as RenderedTable,
      ],
    }
    const { largeTables } = buildCardinalityGuardOptions(ctx)
    expect(largeTables[0]?.parentTimeBound).toBeUndefined()
  })
})
