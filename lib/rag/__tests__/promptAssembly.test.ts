/**
 * promptAssembly.test.ts — Fix A JOIN GRAPH + Fix D SEMANTIC HINTS + Fix B
 * source-qualified refs (lib/rag/promptAssembly.ts). NEW dedicated test file
 * (previously only exercised indirectly via thinSlice.test.ts's hand-authored
 * PromptSchemaContext, which had no join-graph/semantic-hints/bridge-table
 * coverage). Hermetic: pure unit tests of the rendering functions against
 * hand-built RenderedTable/JoinHint/JoinPath/GlossaryHit fixtures — no bundle.
 */

import { describe, expect, it } from 'vitest'
import type { EngineCapabilities } from '../../engine/QueryEngine'
import { assemblePrompt, assembleRepairPrompt, type PromptSchemaContext } from '../promptAssembly'
import type { GlossaryHit, JoinHint, JoinPath, RenderedTable } from '../Retriever'

const CAPS: EngineCapabilities = {
  supportsCrossCatalogJoin: true,
  identifierQuote: '"',
  intervalSyntax: 'postgres',
  supportsExplain: true,
}

function measurementsTable(role: 'primary' | 'bridge' = 'primary'): RenderedTable {
  return {
    tableId: 'mock.public.MeasurementsMock',
    quotedRef: '"public"."MeasurementsMock"',
    grain: 'one row per MeasurementsMock reading',
    columns: [
      { name: 'Id', quotedName: '"Id"', dataType: 'BIGINT', isTimeColumn: false, isForeignKeyOrPrimaryKey: true },
      { name: 'DeviceId', quotedName: '"DeviceId"', dataType: 'INTEGER', isTimeColumn: false, isForeignKeyOrPrimaryKey: true },
      { name: 'Value', quotedName: '"Value"', dataType: 'DOUBLE PRECISION', isTimeColumn: false },
      { name: 'RecordedAt', quotedName: '"RecordedAt"', dataType: 'TIMESTAMP', isTimeColumn: true, isIndexed: true },
    ],
    approxRowCount: 483,
    isLargeTimeSeries: true,
    requiredTimeColumn: '"RecordedAt"',
    role,
  }
}

function patientsTable(role: 'primary' | 'bridge' = 'primary'): RenderedTable {
  return {
    tableId: 'mock.public.PatientMock',
    quotedRef: '"public"."PatientMock"',
    grain: 'one row per PatientMock record',
    columns: [{ name: 'patientRef', quotedName: '"patientRef"', dataType: 'INTEGER', isTimeColumn: false, isForeignKeyOrPrimaryKey: true }],
    approxRowCount: 40,
    isLargeTimeSeries: false,
    role,
  }
}

function monitorsBridgeTable(): RenderedTable {
  return {
    tableId: 'staging.Shared.Monitors',
    quotedRef: '"Shared"."Monitors"',
    grain: 'one row per Monitors record',
    columns: [
      { name: 'Id', quotedName: '"Id"', dataType: 'INTEGER', isTimeColumn: false, isForeignKeyOrPrimaryKey: true },
      { name: 'AcceptanceId', quotedName: '"AcceptanceId"', dataType: 'INTEGER', isTimeColumn: false, isForeignKeyOrPrimaryKey: true },
    ],
    approxRowCount: 1000,
    isLargeTimeSeries: false,
    role: 'bridge',
  }
}

describe('Fix B — source-qualified refs', () => {
  it('the rendered table header includes the sourceId. prefix', () => {
    const prompt = assemblePrompt({ tables: [measurementsTable()], cardinalityWarnings: [] }, 'q', CAPS, 'duckdb')
    expect(prompt).toContain('mock."public"."MeasurementsMock"')
  })
})

describe('Fix A — JOIN GRAPH rendering', () => {
  it('renders the exact "A"."col" = "B"."col" [N:1] edge format, source-qualified', () => {
    const hint: JoinHint = {
      fromRef: '"public"."MeasurementsMock"',
      fromColumns: ['patientRef'],
      toRef: '"public"."PatientMock"',
      toColumns: ['patientRef'],
      joinCardinality: 'many-to-one',
      crossSource: false,
    }
    const context: PromptSchemaContext = {
      tables: [measurementsTable(), patientsTable()],
      cardinalityWarnings: [],
      joinHints: [hint],
    }
    const prompt = assemblePrompt(context, 'q', CAPS, 'duckdb')
    expect(prompt).toContain('mock."public"."MeasurementsMock"."patientRef" = mock."public"."PatientMock"."patientRef" [N:1]')
  })

  it('renders a BRIDGE tables stub section for an admitted multi-hop path', () => {
    const path: JoinPath = {
      nodes: ['mock.public.MeasurementsMock', 'staging.Shared.Monitors', 'mock.public.PatientMock'],
      edges: [
        {
          fromRef: '"public"."MeasurementsMock"',
          fromColumns: ['DeviceId'],
          toRef: '"Shared"."Monitors"',
          toColumns: ['Id'],
          joinCardinality: 'many-to-one',
          crossSource: false,
        },
        {
          fromRef: '"Shared"."Monitors"',
          fromColumns: ['AcceptanceId'],
          toRef: '"public"."PatientMock"',
          toColumns: ['patientRef'],
          joinCardinality: 'many-to-one',
          crossSource: false,
        },
      ],
      hopCount: 2,
    }
    const context: PromptSchemaContext = {
      tables: [measurementsTable(), patientsTable(), monitorsBridgeTable()],
      cardinalityWarnings: [],
      joinPaths: [path],
    }
    const prompt = assemblePrompt(context, 'q', CAPS, 'duckdb')
    expect(prompt).toContain('BRIDGE tables')
    expect(prompt).toContain('staging."Shared"."Monitors"')
    expect(prompt).toContain('Multi-hop path')
  })

  it.each([
    ['many-to-one', '[N:1]'],
    ['one-to-many', '[1:N]'],
    ['one-to-one', '[1:1]'],
    ['many-to-many', '[N:N]'],
  ])('renders the %s cardinality tag as %s', (cardinality, tag) => {
    const a: RenderedTable = { tableId: 'mock.public.A', quotedRef: '"public"."A"', grain: 'g', columns: [], approxRowCount: 1, isLargeTimeSeries: false, role: 'primary' }
    const b: RenderedTable = { tableId: 'mock.public.B', quotedRef: '"public"."B"', grain: 'g', columns: [], approxRowCount: 1, isLargeTimeSeries: false, role: 'primary' }
    const hint: JoinHint = { fromRef: '"public"."A"', fromColumns: ['x'], toRef: '"public"."B"', toColumns: ['y'], joinCardinality: cardinality, crossSource: false }
    const prompt = assemblePrompt({ tables: [a, b], cardinalityWarnings: [], joinHints: [hint] }, 'q', CAPS, 'duckdb')
    expect(prompt).toContain(tag)
  })
})

describe('Fix D — SEMANTIC HINTS rendering', () => {
  it('renders the literal code filter + provenance comment format', () => {
    const hit: GlossaryHit = {
      term: 'heart rate',
      resolvedColumnId: 'mock.public.MeasurementsMock.Value',
      timeColumnId: 'mock.public.MeasurementsMock.RecordedAt',
      unit: 'bpm',
      hostingTableId: 'mock.public.MeasurementsMock',
      confidence: 1.0,
      codeValue: 2,
      codeLabel: 'HR',
      codeColumnId: 'mock.public.MeasurementsMock.MeasurementTypeId',
    }
    const context: PromptSchemaContext = {
      tables: [measurementsTable()],
      cardinalityWarnings: [],
      glossaryHits: [hit],
    }
    const prompt = assemblePrompt(context, 'q', CAPS, 'duckdb')
    expect(prompt).toContain('"public"."MeasurementsMock"."MeasurementTypeId" = 2')
    expect(prompt).toContain(`-- code 2 = "HR"`)
    expect(prompt).toContain('"public"."MeasurementsMock"."Value" (unit=bpm)')
    expect(prompt).toContain('"public"."MeasurementsMock"."RecordedAt"')
  })

  it('caps at MAX_SEMANTIC_HINTS matched hints per query', () => {
    const hits: GlossaryHit[] = Array.from({ length: 10 }, (_, i) => ({
      term: `term${i}`,
      resolvedColumnId: `mock.public.MeasurementsMock.col${i}`,
      confidence: 1.0,
    }))
    const context: PromptSchemaContext = { tables: [measurementsTable()], cardinalityWarnings: [], glossaryHits: hits }
    const prompt = assemblePrompt(context, 'q', CAPS, 'duckdb')
    const matches = prompt.match(/- "term\d+"/g) ?? []
    expect(matches.length).toBeLessThanOrEqual(6)
  })
})

describe('prompt-accuracy fixes (live "HR above 120 in last 3h" evaluation)', () => {
  const hrMonitorMeasurements: RenderedTable = {
    tableId: 'staging.Shared.MonitorMeasurements',
    quotedRef: '"Shared"."MonitorMeasurements"',
    grain: 'one row per MonitorMeasurements reading',
    columns: [],
    approxRowCount: 337_000_000,
    isLargeTimeSeries: true,
    role: 'primary',
  }
  const monitorsParent: RenderedTable = {
    tableId: 'staging.Shared.Monitors',
    quotedRef: '"Shared"."Monitors"',
    grain: 'one row per Monitors record',
    columns: [],
    approxRowCount: 60_000_000,
    isLargeTimeSeries: false,
    role: 'primary',
  }
  const hrHint: GlossaryHit = {
    term: 'heart rate',
    resolvedColumnId: 'staging.Shared.MonitorMeasurements.Value',
    unit: 'bpm',
    hostingTableId: 'staging.Shared.MonitorMeasurements',
    confidence: 1.0,
    codeValue: 2,
    codeLabel: 'HR',
    codeColumnId: 'staging.Shared.MonitorMeasurements.MeasurementTypeId',
  }
  const mmEdge: JoinHint = {
    fromRef: '"Shared"."MonitorMeasurements"',
    fromColumns: ['DeviceId'],
    toRef: '"Shared"."Monitors"',
    toColumns: ['Id'],
    joinCardinality: 'many-to-one',
    crossSource: false,
  }

  it('Fix 1: join edge names the exact FK column and warns against Id = Id', () => {
    const prompt = assemblePrompt(
      { tables: [hrMonitorMeasurements, monitorsParent], cardinalityWarnings: [], joinHints: [mmEdge] },
      'q',
      CAPS,
      'duckdb',
    )
    expect(prompt).toContain('staging."Shared"."MonitorMeasurements"."DeviceId" = staging."Shared"."Monitors"."Id"')
    expect(prompt).toContain('use the FK column "DeviceId"')
    expect(prompt).toContain('NOT MonitorMeasurements."Id" = Monitors."Id"')
    expect(prompt).toContain('do NOT default to matching Id = Id')
  })

  it('Fix 2: semantic hint separates TypeId equality from Value comparison', () => {
    const prompt = assemblePrompt(
      { tables: [hrMonitorMeasurements], cardinalityWarnings: [], glossaryHits: [hrHint] },
      'q',
      CAPS,
      'duckdb',
    )
    expect(prompt).toContain('"MeasurementTypeId" = 2')
    expect(prompt).toContain('SELECTS WHICH metric')
    expect(prompt).toContain('apply numeric comparisons like ">120" to "Value"')
    expect(prompt).toContain('NOT to "MeasurementTypeId"')
  })

  it('Fix 3: semantic hint pins the hosting table against a sibling subsystem', () => {
    const prompt = assemblePrompt(
      { tables: [hrMonitorMeasurements], cardinalityWarnings: [], glossaryHits: [hrHint] },
      'q',
      CAPS,
      'duckdb',
    )
    expect(prompt).toContain('read "heart rate" ONLY from MonitorMeasurements')
    expect(prompt).toContain('do NOT substitute a similarly-named table from another subsystem')
  })
})

describe('assemblePrompt — section ordering: SCHEMA -> SEMANTIC HINTS -> JOIN GRAPH -> CARDINALITY', () => {
  it('orders sections correctly when all are present', () => {
    const hit: GlossaryHit = {
      term: 'heart rate',
      resolvedColumnId: 'mock.public.MeasurementsMock.Value',
      hostingTableId: 'mock.public.MeasurementsMock',
      confidence: 1.0,
      codeValue: 2,
      codeColumnId: 'mock.public.MeasurementsMock.MeasurementTypeId',
    }
    const hint: JoinHint = {
      fromRef: '"public"."MeasurementsMock"',
      fromColumns: ['patientRef'],
      toRef: '"public"."PatientMock"',
      toColumns: ['patientRef'],
      joinCardinality: 'many-to-one',
      crossSource: false,
    }
    const context: PromptSchemaContext = {
      tables: [measurementsTable(), patientsTable()],
      cardinalityWarnings: [
        { tableId: 'mock.public.MeasurementsMock', approxRowCount: 483, requiredTimeColumn: '"RecordedAt"', message: 'test warning' },
      ],
      joinHints: [hint],
      glossaryHits: [hit],
    }
    const prompt = assemblePrompt(context, 'heart rate over 120', CAPS, 'duckdb', { tokenBudget: 2500 })
    const schemaIdx = prompt.indexOf('SCHEMA CONTEXT')
    const semanticIdx = prompt.indexOf('SEMANTIC HINTS')
    const joinIdx = prompt.indexOf('JOIN GRAPH')
    const cardinalityIdx = prompt.indexOf('CARDINALITY WARNINGS')
    expect(schemaIdx).toBeLessThan(semanticIdx)
    expect(semanticIdx).toBeLessThan(joinIdx)
    expect(joinIdx).toBeLessThan(cardinalityIdx)
  })

  it('omits SEMANTIC HINTS / JOIN GRAPH sections when absent', () => {
    const prompt = assemblePrompt({ tables: [measurementsTable()], cardinalityWarnings: [] }, 'q', CAPS, 'duckdb')
    expect(prompt).not.toContain('SEMANTIC HINTS')
    expect(prompt).not.toContain('JOIN GRAPH')
  })
})

describe('assembleRepairPrompt — inherits JOIN GRAPH / SEMANTIC HINTS from assemblePrompt', () => {
  it('the repair prompt contains both new sections plus the repair instructions', () => {
    const hit: GlossaryHit = {
      term: 'heart rate',
      resolvedColumnId: 'mock.public.MeasurementsMock.Value',
      hostingTableId: 'mock.public.MeasurementsMock',
      confidence: 1.0,
      codeValue: 2,
      codeColumnId: 'mock.public.MeasurementsMock.MeasurementTypeId',
    }
    const hint: JoinHint = {
      fromRef: '"public"."MeasurementsMock"',
      fromColumns: ['patientRef'],
      toRef: '"public"."PatientMock"',
      toColumns: ['patientRef'],
      joinCardinality: 'many-to-one',
      crossSource: false,
    }
    const context: PromptSchemaContext = {
      tables: [measurementsTable(), patientsTable()],
      cardinalityWarnings: [],
      joinHints: [hint],
      glossaryHits: [hit],
    }
    const prompt = assembleRepairPrompt(context, 'heart rate over 120', CAPS, 'duckdb', { failedSql: 'SELECT 1', error: 'bad join' })
    expect(prompt).toContain('SEMANTIC HINTS')
    expect(prompt).toContain('JOIN GRAPH')
    expect(prompt).toContain('REPAIR REQUIRED')
  })
})

describe('assemblePrompt — preamble DISTINCT fan-out rule', () => {
  it('includes the COUNT(DISTINCT ...) guidance sentence', () => {
    const prompt = assemblePrompt({ tables: [measurementsTable()], cardinalityWarnings: [] }, 'q', CAPS, 'duckdb')
    expect(prompt).toContain('COUNT(DISTINCT')
  })
})
