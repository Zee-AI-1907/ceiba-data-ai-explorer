/**
 * TrinoEngine.ts — Trino QueryEngine STUB (NL2SQL_SPEC.md §3.3, NL2SQL_PLAN.md §P2).
 *
 * DuckDB is the near-term default federation engine (SPEC §0 decision #3, §8.1
 * non-goal "no Trino cluster in the near term"). This class exists purely so the
 * QueryEngine abstraction is proven interchangeable at COMPILE TIME — it wraps the
 * existing, hardened `executeTrinoQuery`/`DbTarget` from lib/trinoClient.ts for the
 * one read path that already runs in production (app/api/query/route.ts), and throws
 * a clear "deferred" error for everything this stub does not implement (attach,
 * explain, and all introspection). Promote to a real implementation only when a
 * heterogeneous third source appears (SPEC §3.3, research §1.5, R9).
 *
 * Goal: compile-time interchangeability with DuckDbEngine, not a running Trino.
 */

import { executeTrinoQuery, type DbTarget } from '@/lib/trinoClient'
import type {
  AttachSpec,
  DescribeResult,
  EngineCapabilities,
  EngineResult,
  ExecuteOptions,
  PlanOrError,
  QueryEngine,
  SqlDialect,
  TableMeta,
} from './QueryEngine'

/** Raised by every TrinoEngine method the spec defers (SPEC §3.3, §8.1 non-goal). */
export class TrinoDeferredError extends Error {
  constructor(method: string) {
    super(
      `TrinoEngine.${method}(): not implemented (Trino deferred — NL2SQL_SPEC.md §3.3, ` +
        '§8.1 "no Trino cluster in the near term"). DuckDbEngine is the default implementation.'
    )
    this.name = 'TrinoDeferredError'
  }
}

/**
 * Maps a QueryEngine `catalog` string (an AttachSpec.alias / ExecuteOptions.catalog)
 * onto the fixed `DbTarget` union `lib/trinoClient.ts` already supports. Any other
 * catalog value is out of scope for this stub.
 */
function toDbTarget(catalog: string | undefined): DbTarget {
  if (catalog === 'telehealth' || catalog === 'eclinics') return catalog
  throw new TrinoDeferredError(`execute(catalog="${catalog ?? '<default>'}")`)
}

export class TrinoEngine implements QueryEngine {
  // ── lifecycle ──

  async attach(_specs: AttachSpec[]): Promise<void> {
    // lib/trinoClient.ts connects per-query against a fixed catalog set configured
    // via TRINO_CATALOG_TELEHEALTH / TRINO_CATALOG_ECLINICS env vars; there is no
    // dynamic ATTACH step to perform. Accept the call as a no-op so callers written
    // against the QueryEngine interface (e.g. lib/engine/index.ts factory) do not
    // need to special-case TrinoEngine — but make clear no catalogs beyond the two
    // built-in DbTargets are usable until a real Trino implementation lands.
    return Promise.resolve()
  }

  async dispose(): Promise<void> {
    return Promise.resolve()
  }

  // ── runtime (read path) ──

  async execute(sql: string, opts: ExecuteOptions): Promise<EngineResult> {
    const db = toDbTarget(opts.catalog)
    const schema = opts.schema ?? 'Shared'
    const maxRows = Number.isFinite(opts.maxRows) && opts.maxRows > 0 ? Math.floor(opts.maxRows) : 1000

    // executeTrinoQuery already enforces PER_REQUEST_TIMEOUT_MS / STATEMENT_DEADLINE_MS
    // / MAX_POLL_ITERATIONS internally (lib/trinoClient.ts H23 hardening) — this stub
    // mirrors those constants in spirit but does not re-implement deadline handling;
    // opts.deadlineMs is intentionally not threaded through since trinoClient owns its
    // own fixed wall-clock budget (STATEMENT_DEADLINE_MS = 55_000ms).
    const result = await executeTrinoQuery(sql, db, schema, maxRows + 1)
    const truncated = result.rows.length > maxRows
    const rows = truncated ? result.rows.slice(0, maxRows) : result.rows
    return {
      columns: result.columns,
      rows,
      rowCount: rows.length,
      truncated,
    }
  }

  async explain(_sql: string, _opts: Pick<ExecuteOptions, 'catalog' | 'schema'>): Promise<PlanOrError> {
    // Deferred rather than best-effort: EXPLAIN semantics differ enough across Trino
    // connectors that a stubbed "ok:true" would be actively misleading to the
    // self-repair loop (SPEC §5.5). Callers should branch on capabilities().supportsExplain.
    throw new TrinoDeferredError('explain')
  }

  dialect(): SqlDialect {
    return 'trino'
  }

  capabilities(): EngineCapabilities {
    return {
      supportsCrossCatalogJoin: true,
      identifierQuote: '"',
      intervalSyntax: 'trino',
      supportsExplain: false,
    }
  }

  // ── introspection path (DB-agnostic) — all deferred ──

  async listCatalogs(): Promise<string[]> {
    throw new TrinoDeferredError('listCatalogs')
  }

  async listSchemas(_catalog: string): Promise<string[]> {
    throw new TrinoDeferredError('listSchemas')
  }

  async listTables(_catalog: string, _schema: string): Promise<TableMeta[]> {
    throw new TrinoDeferredError('listTables')
  }

  async describeTable(_ref: TableMeta): Promise<DescribeResult> {
    throw new TrinoDeferredError('describeTable')
  }
}
