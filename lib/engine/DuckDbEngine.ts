/**
 * DuckDbEngine.ts — default QueryEngine implementation (NL2SQL_SPEC.md §3.1).
 *
 * DuckDB-first federation: attaches Postgres (and, for hermetic tests, other DuckDB
 * catalogs) with `ATTACH ... READ_ONLY` and executes cross-catalog joins natively.
 * Loads the `postgres` extension (Postgres attach/scan) and the `vss` extension
 * (vector search — used by the retriever's bundle, not by this engine directly, but
 * loaded here per NL2SQL_PLAN.md §P2 DoD so the runtime that owns the DuckDB instance
 * has it available for lib/rag/vssClient.ts later).
 *
 * Mirrors the timeout/deadline posture already hardened in lib/trinoClient.ts
 * (STATEMENT_DEADLINE_MS wall-clock budget, rowCeiling row cap): `execute()` enforces
 * both `opts.maxRows` (clamp + `truncated` flag) and `opts.deadlineMs` (interrupt the
 * connection when the budget elapses).
 */

import { DuckDBConnection, DuckDBInstance } from '@duckdb/node-api'
import type {
  AttachSpec,
  ColumnMeta,
  DescribeResult,
  EngineCapabilities,
  EngineColumn,
  EngineResult,
  ExecuteOptions,
  PlanOrError,
  QueryEngine,
  SqlDialect,
  TableMeta,
} from './QueryEngine'

/** Thrown when an AttachSpec fails the hard read-only requirement (defense in depth). */
export class NonReadOnlyAttachError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'NonReadOnlyAttachError'
  }
}

/** Thrown when execute()'s wall-clock deadline elapses before the query finishes. */
export class EngineDeadlineExceededError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'EngineDeadlineExceededError'
  }
}

/** Catalogs that are part of the DuckDB runtime itself, never a real attached source. */
const INTERNAL_CATALOGS = new Set(['system', 'temp'])

function quoteIdent(id: string): string {
  return `"${id.replace(/"/g, '""')}"`
}

function quoteLiteral(value: string): string {
  return `'${value.replace(/'/g, "''")}'`
}

/**
 * Default (in-process) DuckDB implementation of QueryEngine. One instance owns one
 * DuckDB database (`:memory:` by default) plus whatever sources are ATTACHed into it.
 */
export class DuckDbEngine implements QueryEngine {
  private instance: DuckDBInstance | null = null
  private connection: DuckDBConnection | null = null
  private readonly attachedAliases = new Set<string>()
  private readonly extensionsLoaded: Promise<void>
  /** DuckDB's own in-process path (":memory:" default); a real file for tests that need persistence. */
  private readonly localPath: string
  /**
   * Whether the read-path external-access lockdown has been applied. External
   * access (arbitrary filesystem/HTTP table functions such as read_csv /
   * read_parquet('http://...')) stays enabled through construction + attach,
   * then is disabled+locked lazily the first time user SQL is run (execute /
   * explain). See `harden()`. Mirrors the Python engine's `_hardened` flag.
   */
  private hardened = false

  constructor(options: { localPath?: string } = {}) {
    this.localPath = options.localPath ?? ':memory:'
    this.extensionsLoaded = this.init()
  }

  private async init(): Promise<void> {
    this.instance = await DuckDBInstance.create(this.localPath)
    this.connection = await this.instance.connect()
    // Load the extensions this engine depends on. INSTALL is a no-op if already
    // installed/cached; LOAD is required every connection. Both extensions are
    // required by the P2 DoD ("duckdb + vss + postgres extensions load").
    // Extensions MUST be loaded here, while external access is still enabled —
    // once `enable_external_access=false` is set (see harden()), DuckDB refuses
    // to load ANY external extension, and ATTACH of a file/postgres source is
    // likewise blocked. So extension load + every attach() happen BEFORE the
    // runtime is sealed.
    await this.connection.run('INSTALL postgres')
    await this.connection.run('LOAD postgres')
    await this.connection.run('INSTALL vss')
    await this.connection.run('LOAD vss')
  }

  /**
   * Seal the DuckDB runtime against external filesystem/network access so a
   * "read-only SELECT" cannot exfiltrate secrets or SSRF via a table function
   * like `read_csv('/proc/self/environ')` or `read_parquet('http://…')`.
   *
   * `enable_external_access=false` blocks all filesystem/HTTP table functions
   * (read_csv/read_parquet/read_json/read_text/read_blob/glob/COPY … TO a path)
   * AND further ATTACHes; `lock_configuration=true` makes it irreversible for
   * the life of the connection, so a `SET enable_external_access=true` smuggled
   * into a query cannot re-open the door. Both are one-way and guarded by
   * `this.hardened` because DuckDB errors on re-setting a locked option even to
   * the same value.
   *
   * MUST run AFTER all extensions are loaded and all sources are ATTACHed
   * (both need external access), which is why it is applied lazily on the first
   * read rather than in init(). Reads from already-attached READ_ONLY catalogs
   * continue to work after the lockdown. Mirrors the Python engine's `_harden`.
   */
  private async harden(): Promise<void> {
    if (this.hardened) return
    const conn = await this.getConnection()
    await conn.run('SET enable_external_access=false')
    await conn.run('SET lock_configuration=true')
    this.hardened = true
  }

  private async getConnection(): Promise<DuckDBConnection> {
    await this.extensionsLoaded
    if (!this.connection) throw new Error('DuckDbEngine: connection not initialized')
    return this.connection
  }

  // ── lifecycle ────────────────────────────────────────────────────────────

  async attach(specs: AttachSpec[]): Promise<void> {
    const conn = await this.getConnection()
    // Sequential by necessity: ATTACH/verify/DETACH form one ordered transaction per
    // spec against a single shared DuckDB connection, so these awaits cannot be
    // parallelised (mirrors the documented exemption in lib/trinoClient.ts's poll loop).
    for (const spec of specs) {
      // HARD-ERROR: readOnly is typed as the literal `true`, but defend at runtime
      // too — a caller building AttachSpec dynamically (e.g. from bundle manifest
      // JSON) could still construct a non-literal-true value.
      if (spec.readOnly !== true) {
        throw new NonReadOnlyAttachError(
          `attach(): spec for sourceId="${spec.sourceId}" (alias="${spec.alias}") is missing readOnly:true. ` +
            'A read-write attach is forbidden (NL2SQL_SPEC.md §3.1, PLAN.md §0 rule 2).'
        )
      }
      if (this.attachedAliases.has(spec.alias)) continue // idempotent per spec.attach() contract

      const dsnLiteral = quoteLiteral(spec.dsn)
      const alias = quoteIdent(spec.alias)
      const typeClause = spec.engine === 'postgres' ? 'TYPE postgres, ' : ''
      const sql = `ATTACH ${dsnLiteral} AS ${alias} (${typeClause}READ_ONLY)`
      // eslint-disable-next-line no-await-in-loop
      await conn.run(sql)

      // Defense in depth: verify DuckDB itself reports the catalog as read-only.
      // If READ_ONLY could not be enforced (e.g. a future DuckDB/extension quirk),
      // detach immediately and hard-error rather than silently allow writes.
      // eslint-disable-next-line no-await-in-loop
      const verify = await conn.runAndReadAll(
        `SELECT readonly FROM duckdb_databases() WHERE database_name = ${quoteLiteral(spec.alias)}`
      )
      const rows = verify.getRowObjectsJS()
      const isReadOnly = rows.length > 0 && rows[0]?.readonly === true
      if (!isReadOnly) {
        // eslint-disable-next-line no-await-in-loop
        await conn.run(`DETACH ${alias}`).catch(() => undefined)
        throw new NonReadOnlyAttachError(
          `attach(): DuckDB did not report catalog "${spec.alias}" as READ_ONLY after ATTACH; ` +
            'refusing to proceed with a potentially writable cross-source catalog.'
        )
      }

      this.attachedAliases.add(spec.alias)
    }
  }

  async dispose(): Promise<void> {
    if (this.connection) {
      this.connection.closeSync()
      this.connection = null
    }
    if (this.instance) {
      this.instance.closeSync()
      this.instance = null
    }
    this.attachedAliases.clear()
  }

  // ── runtime (read path) ───────────────────────────────────────────────────

  async execute(sql: string, opts: ExecuteOptions): Promise<EngineResult> {
    const conn = await this.getConnection()
    // Seal external filesystem/network access before running ANY user SQL
    // (defense in depth against read_csv/read_parquet exfiltration/SSRF);
    // idempotent after the first call. NOTE: `opts.catalog`/`opts.schema` are
    // intentionally NOT applied as a `USE` here — execute() requires
    // fully-qualified SQL; only explain() applies USE (kept at parity with the
    // Python engine).
    await this.harden()
    const maxRows = Number.isFinite(opts.maxRows) && opts.maxRows > 0 ? Math.floor(opts.maxRows) : 1000
    const deadlineMs = Number.isFinite(opts.deadlineMs) && opts.deadlineMs > 0 ? Math.floor(opts.deadlineMs) : 55_000

    let deadlineTimer: ReturnType<typeof setTimeout> | undefined
    let deadlineHit = false
    const deadlinePromise = new Promise<never>((_resolve, reject) => {
      deadlineTimer = setTimeout(() => {
        deadlineHit = true
        conn.interrupt()
        reject(new EngineDeadlineExceededError(`execute(): exceeded deadlineMs budget of ${deadlineMs}ms`))
      }, deadlineMs)
    })

    try {
      // Ask for one more row than the cap so a single extra row proves more data
      // existed beyond maxRows, without materializing an unbounded result set.
      const readPromise = conn.runAndReadUntil(sql, maxRows + 1)
      const reader = await Promise.race([readPromise, deadlinePromise])

      const columnCount = reader.columnCount
      const columns: EngineColumn[] = []
      for (let i = 0; i < columnCount; i++) {
        columns.push({ name: reader.columnName(i), type: reader.columnType(i).toString() })
      }

      const allRows = reader.getRowObjectsJS() as Record<string, unknown>[]
      const truncated = allRows.length > maxRows
      const rows = truncated ? allRows.slice(0, maxRows) : allRows

      return { columns, rows, rowCount: rows.length, truncated }
    } catch (err) {
      if (deadlineHit) {
        throw new EngineDeadlineExceededError(`execute(): exceeded deadlineMs budget of ${deadlineMs}ms`)
      }
      throw err
    } finally {
      if (deadlineTimer) clearTimeout(deadlineTimer)
    }
  }

  async explain(sql: string, opts: Pick<ExecuteOptions, 'catalog' | 'schema'>): Promise<PlanOrError> {
    const conn = await this.getConnection()
    await this.harden()
    try {
      if (opts.catalog) await conn.run(`USE ${quoteIdent(opts.catalog)}${opts.schema ? `.${quoteIdent(opts.schema)}` : ''}`)
      const reader = await conn.runAndReadAll(`EXPLAIN ${sql}`)
      // EXPLAIN never returns data rows to the caller (spec §3.1 explain() contract) —
      // only the textual plan, concatenated from DuckDB's `explain_value` column(s).
      const rowObjects = reader.getRowObjectsJS() as Record<string, unknown>[]
      const plan = rowObjects
        .map((row) => Object.values(row).map((v) => String(v)).join('\n'))
        .join('\n')
      return { ok: true, plan }
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err)
      return { ok: false, error }
    }
  }

  dialect(): SqlDialect {
    return 'duckdb'
  }

  capabilities(): EngineCapabilities {
    return {
      supportsCrossCatalogJoin: true,
      identifierQuote: '"',
      intervalSyntax: 'ansi',
      supportsExplain: true,
    }
  }

  // ── introspection path (DB-agnostic) ──────────────────────────────────────

  async listCatalogs(): Promise<string[]> {
    const conn = await this.getConnection()
    const reader = await conn.runAndReadAll(
      'SELECT database_name FROM duckdb_databases() WHERE internal = false ORDER BY database_name'
    )
    const rows = reader.getRowObjectsJS() as { database_name: string }[]
    return rows.map((r) => r.database_name).filter((name) => !INTERNAL_CATALOGS.has(name))
  }

  async listSchemas(catalog: string): Promise<string[]> {
    const conn = await this.getConnection()
    const reader = await conn.runAndReadAll(
      `SELECT DISTINCT schema_name FROM information_schema.schemata WHERE catalog_name = ${quoteLiteral(catalog)} ORDER BY schema_name`
    )
    const rows = reader.getRowObjectsJS() as { schema_name: string }[]
    return rows.map((r) => r.schema_name)
  }

  async listTables(catalog: string, schema: string): Promise<TableMeta[]> {
    const conn = await this.getConnection()
    const reader = await conn.runAndReadAll(
      `SELECT table_name FROM information_schema.tables
       WHERE table_catalog = ${quoteLiteral(catalog)} AND table_schema = ${quoteLiteral(schema)}
       ORDER BY table_name`
    )
    const rows = reader.getRowObjectsJS() as { table_name: string }[]
    return rows.map((r) => ({
      sourceId: catalog,
      schema,
      name: r.table_name,
      quotedRef: `${quoteIdent(catalog)}.${quoteIdent(schema)}.${quoteIdent(r.table_name)}`,
    }))
  }

  async describeTable(ref: TableMeta): Promise<DescribeResult> {
    const conn = await this.getConnection()

    const colsReader = await conn.runAndReadAll(
      `SELECT column_name, data_type, is_nullable
       FROM information_schema.columns
       WHERE table_catalog = ${quoteLiteral(ref.sourceId)} AND table_schema = ${quoteLiteral(ref.schema)}
         AND table_name = ${quoteLiteral(ref.name)}
       ORDER BY ordinal_position`
    )
    const colRows = colsReader.getRowObjectsJS() as {
      column_name: string
      data_type: string
      is_nullable: string
    }[]

    const pkReader = await conn.runAndReadAll(
      `SELECT constraint_column_names
       FROM duckdb_constraints()
       WHERE database_name = ${quoteLiteral(ref.sourceId)} AND schema_name = ${quoteLiteral(ref.schema)}
         AND table_name = ${quoteLiteral(ref.name)} AND constraint_type = 'PRIMARY KEY'`
    )
    const pkRows = pkReader.getRowObjectsJS() as { constraint_column_names: unknown }[]
    const primaryKey: string[] = pkRows.length > 0 ? (pkRows[0]!.constraint_column_names as string[]) : []
    const primaryKeySet = new Set(primaryKey)

    const fkReader = await conn.runAndReadAll(
      `SELECT constraint_column_names, referenced_table, referenced_column_names
       FROM duckdb_constraints()
       WHERE database_name = ${quoteLiteral(ref.sourceId)} AND schema_name = ${quoteLiteral(ref.schema)}
         AND table_name = ${quoteLiteral(ref.name)} AND constraint_type = 'FOREIGN KEY'`
    )
    const fkRows = fkReader.getRowObjectsJS() as {
      constraint_column_names: unknown
      referenced_table: unknown
      referenced_column_names: unknown
    }[]
    const foreignKeys = fkRows.map((row) => ({
      fromColumns: row.constraint_column_names as string[],
      toTable: String(row.referenced_table ?? ''),
      toColumns: (row.referenced_column_names as string[]) ?? [],
    }))

    const idxReader = await conn.runAndReadAll(
      `SELECT expressions
       FROM duckdb_indexes()
       WHERE database_name = ${quoteLiteral(ref.sourceId)} AND schema_name = ${quoteLiteral(ref.schema)}
         AND table_name = ${quoteLiteral(ref.name)}`
    )
    const idxRows = idxReader.getRowObjectsJS() as { expressions: unknown }[]
    const indexedColumns = new Set<string>()
    for (const row of idxRows) {
      const exprText = String(row.expressions ?? '')
      // DuckDB reports expressions like "[column_name]"; strip brackets/quotes to
      // recover bare column names for the isIndexed flag.
      for (const match of exprText.matchAll(/[A-Za-z_][A-Za-z0-9_]*/g)) {
        indexedColumns.add(match[0])
      }
    }

    const columns: ColumnMeta[] = colRows.map((row) => ({
      name: row.column_name,
      quotedName: quoteIdent(row.column_name),
      dataType: row.data_type,
      nullable: row.is_nullable === 'YES',
      isPrimaryKey: primaryKeySet.has(row.column_name),
      isIndexed: indexedColumns.has(row.column_name) || primaryKeySet.has(row.column_name),
    }))

    return { columns, primaryKey, foreignKeys }
  }
}
