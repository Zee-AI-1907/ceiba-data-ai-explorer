/**
 * lib/engine/index.ts — QueryEngine factory (NL2SQL_PLAN.md §P2).
 *
 * Single seam callers (lib/rag/**, eval/**, routes) use to obtain a QueryEngine
 * without importing a concrete implementation directly, so swapping the default
 * federation engine (DuckDB → Trino → postgres_fdw, SPEC §3.3) never touches call
 * sites — only this factory.
 */

import { DuckDbEngine } from './DuckDbEngine'
import { TrinoEngine } from './TrinoEngine'
import type { AttachSpec, QueryEngine } from './QueryEngine'

export type EngineKind = 'duckdb' | 'trino'

export interface CreateEngineOptions {
  /** DuckDB-only: path to a local/persistent DuckDB file. Defaults to ':memory:'. */
  localPath?: string
}

/**
 * Constructs the requested QueryEngine implementation and attaches the given
 * sources. DuckDB is the default per SPEC §0 decision #3; Trino is present only for
 * compile-time interchangeability (SPEC §3.3, §8.1).
 */
export async function createEngine(
  kind: EngineKind,
  specs: AttachSpec[],
  options: CreateEngineOptions = {}
): Promise<QueryEngine> {
  const engine: QueryEngine = kind === 'trino' ? new TrinoEngine() : new DuckDbEngine({ localPath: options.localPath })
  await engine.attach(specs)
  return engine
}

export { DuckDbEngine } from './DuckDbEngine'
export { TrinoEngine } from './TrinoEngine'
export * from './QueryEngine'
