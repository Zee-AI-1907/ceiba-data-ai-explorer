/**
 * QueryEngine.ts — the swappable federation-engine abstraction (NL2SQL_SPEC.md §3).
 *
 * Verbatim from the spec: every type/interface below is copied as specified so the
 * DuckDB implementation (DuckDbEngine.ts), the Trino stub (TrinoEngine.ts), and any
 * future implementation (e.g. PgFdwEngine.ts) are interchangeable at compile time.
 *
 * Canonical home for these shared engine types — later phases (lib/rag/**, eval/**)
 * import from here; they are never redefined or duplicated (NL2SQL_PLAN.md §0 rule 6).
 *
 * Two hard rules (research §1.4, spec §3):
 *   1. Every read goes through `execute`, which enforces the `maxRows`/`deadlineMs`
 *      budget already established in `lib/trinoClient.ts` (STATEMENT_DEADLINE_MS /
 *      rowCeiling).
 *   2. At runtime, the prep tool is not present — the TS runtime never touches raw
 *      data except through `execute` on guard-passed SQL; profiling data reaches it
 *      only via the bundle's AggregateProfile-derived profiles.json.
 */

export type SqlDialect = 'duckdb' | 'postgres' | 'trino'

export interface EngineCapabilities {
  supportsCrossCatalogJoin: boolean
  identifierQuote: '"' | '`'
  intervalSyntax: 'ansi' | 'postgres' | 'trino'
  supportsExplain: boolean
}

export interface AttachSpec {
  sourceId: string // logical id, matches bundle manifest.sources[].sourceId
  engine: 'postgres' | 'duckdb'
  dsn: string // read from env/secret; never logged
  readOnly: true // literal true — a read-write attach is a type error
  alias: string // catalog/attach alias used in SQL (e.g. "staging", "mock")
}

export interface ExecuteOptions {
  catalog?: string // attach alias / Trino catalog
  schema?: string
  maxRows: number // hard row cap (clamped, mirrors trinoClient rowCeiling)
  deadlineMs: number // wall-clock budget (mirrors trinoClient STATEMENT_DEADLINE_MS)
}

export interface EngineColumn {
  name: string
  type: string
}
export interface EngineResult {
  columns: EngineColumn[]
  rows: Record<string, unknown>[]
  rowCount: number
  truncated: boolean // true if maxRows clamped the result
}

export type PlanOrError =
  | { ok: true; plan: string }
  | { ok: false; error: string } // dialect/column/type error message for the self-repair loop (§5.4)

// Introspection shapes — mirror the Python Introspector (§2.3) so both languages agree.
export interface TableMeta {
  sourceId: string
  schema: string
  name: string
  quotedRef: string
}
export interface ColumnMeta {
  name: string
  quotedName: string
  dataType: string
  nullable: boolean
  isPrimaryKey: boolean
  isIndexed: boolean
}
export interface DescribeResult {
  columns: ColumnMeta[]
  primaryKey: string[]
  foreignKeys: { fromColumns: string[]; toTable: string; toColumns: string[] }[]
}

export interface QueryEngine {
  // ── lifecycle ──
  attach(specs: AttachSpec[]): Promise<void> // ATTACH ... READ_ONLY per source; idempotent
  dispose(): Promise<void>

  // ── runtime (read path) ──
  execute(sql: string, opts: ExecuteOptions): Promise<EngineResult> // EVERY read goes through here
  explain(sql: string, opts: Pick<ExecuteOptions, 'catalog' | 'schema'>): Promise<PlanOrError>
  dialect(): SqlDialect
  capabilities(): EngineCapabilities

  // ── introspection path (DB-agnostic) ──
  listCatalogs(): Promise<string[]>
  listSchemas(catalog: string): Promise<string[]>
  listTables(catalog: string, schema: string): Promise<TableMeta[]>
  describeTable(ref: TableMeta): Promise<DescribeResult>
}
