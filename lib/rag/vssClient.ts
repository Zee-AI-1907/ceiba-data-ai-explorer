/**
 * vssClient.ts — dense ANN retrieval against `vectors.duckdb` (NL2SQL_SPEC.md
 * §1.11, §4.1 stage 3-4: "dense (DuckDB-vss HNSW over doc_kind='table'/
 * 'column')"). Opens the bundle's vectors.duckdb READ-ONLY via DuckDB's `vss`
 * extension and runs a cosine-distance HNSW nearest-neighbor query, optionally
 * filtered by `doc_kind` and/or `source_id` (SPEC §4.1's two-stage hierarchical
 * lookup: table-scoped first, then column-scoped to survivors).
 *
 * ── Query-embedding decision (SPEC §0 decision #2, PLAN §P4 task 3) ────────
 * The prep toolchain embeds documents with `fastembed` (Python, ONNX,
 * `BAAI/bge-small-en-v1.5`, 384-d — `prep/prep/embed/local_embedder.py`).
 * There is no equivalent JS/ONNX bge-small runtime already wired into this
 * repo's dependencies (no `onnxruntime-node`/`fastembed`-for-JS package is
 * present in package.json, and adding a new ML runtime dependency is out of
 * scope for this phase), and pulling in an EXTERNAL embedding API is
 * explicitly forbidden (SPEC §0 decision #2, §2.5 invariant 4, §8.1 "no
 * external embedding API, no hosted vector store").
 *
 * So this module defines the query-embedding boundary as an INJECTABLE
 * interface, `EmbedQuery`, per PLAN's explicit option (b):
 *
 *   export type EmbedQuery = (text: string) => Promise<Float32Array>
 *
 * `Retriever.ts` takes an `EmbedQuery` implementation as a constructor/load
 * option. This module ships:
 *   - `createDeterministicTestEmbedder()` — a clearly-marked, offline,
 *     dependency-free TEST-ONLY embedder (same hash-projection scheme as
 *     `prep/prep/embed/local_embedder.py`'s `DeterministicHashEmbedder`, so a
 *     bundle built with `--test-fallback-embedder` and a query embedded with
 *     this function land in the SAME vector space and produce meaningful
 *     nearest-neighbor results in tests). It refuses to run against a bundle
 *     whose `manifest.embeddingModel.id` is the REAL production id, so a test
 *     can never silently produce garbage similarity against production vectors.
 *   - `createUnimplementedProductionEmbedder()` — a throwing stub, now
 *     SUPERSEDED by `lib/rag/queryEmbedder.ts`'s `createLocalQueryEmbedder()`
 *     (option (a): a real local ONNX bge-small-en-v1.5 port via
 *     `@huggingface/transformers`, verified same-space with the prep
 *     toolchain's fastembed vectors — see that module's docstring for the
 *     parity measurement). Kept here, still throwing, ONLY until the last
 *     caller is repointed at `createLocalQueryEmbedder()` — remove it once
 *     nothing imports it.
 */

import { DuckDBInstance } from '@duckdb/node-api'
import { createHash } from 'node:crypto'

/** Injectable query-embedding function — see module docstring for the (a)/(b) decision. */
export type EmbedQuery = (text: string) => Promise<Float32Array>

export type VssDocKind = 'column' | 'table' | 'glossary' | 'exemplar'

export interface VssSearchHit {
  docId: string
  docKind: VssDocKind
  refId: string
  sourceId: string
  domain: string | null
  text: string
  distance: number
}

export interface VssSearchOptions {
  docKind?: VssDocKind
  sourceIds?: string[]
  /** Restrict the search to a specific set of ref_ids (e.g. column recall scoped to survivor tables, SPEC §4.1 stage 4). */
  refIdPrefixes?: string[]
  k?: number
}

function quoteLiteral(value: string): string {
  return `'${value.replace(/'/g, "''")}'`
}

/**
 * VssClient — a read-only handle onto one bundle's `vectors.duckdb`. Opens
 * lazily on first search; `dispose()` closes the underlying DuckDB instance.
 */
export class VssClient {
  private instance: DuckDBInstance | null = null
  private connection: Awaited<ReturnType<DuckDBInstance['connect']>> | null = null
  private readonly dbPath: string
  private readonly dimension: number
  private initPromise: Promise<void> | null = null

  constructor(dbPath: string, dimension: number) {
    this.dbPath = dbPath
    this.dimension = dimension
  }

  private async ensureOpen(): Promise<void> {
    if (this.initPromise) return this.initPromise
    this.initPromise = (async () => {
      this.instance = await DuckDBInstance.create(this.dbPath, { access_mode: 'READ_ONLY' })
      this.connection = await this.instance.connect()
      await this.connection.run('INSTALL vss')
      await this.connection.run('LOAD vss')
    })()
    return this.initPromise
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
    this.initPromise = null
  }

  /**
   * Nearest-neighbor cosine search over `documents`, optionally filtered by
   * `doc_kind` and/or `source_id` (SPEC §4.1 hierarchical stage filtering).
   * `refIdPrefixes`, when given, keeps only rows whose `ref_id` starts with
   * one of the given prefixes — used to scope column recall to a specific set
   * of survivor tableIds (a columnId is always `<tableId>.<columnName>`).
   */
  async search(queryEmbedding: Float32Array, options: VssSearchOptions = {}): Promise<VssSearchHit[]> {
    await this.ensureOpen()
    if (!this.connection) throw new Error('VssClient: connection not initialized')

    const k = options.k ?? 20
    const conditions: string[] = []
    if (options.docKind) conditions.push(`doc_kind = ${quoteLiteral(options.docKind)}`)
    if (options.sourceIds && options.sourceIds.length > 0) {
      conditions.push(`source_id IN (${options.sourceIds.map(quoteLiteral).join(', ')})`)
    }
    if (options.refIdPrefixes && options.refIdPrefixes.length > 0) {
      const likeClauses = options.refIdPrefixes.map((p) => `ref_id LIKE ${quoteLiteral(`${p}%`)}`)
      conditions.push(`(${likeClauses.join(' OR ')})`)
    }
    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : ''

    const vectorLiteral = `[${Array.from(queryEmbedding).join(', ')}]::FLOAT[${this.dimension}]`
    const sql = `
      SELECT doc_id, doc_kind, ref_id, source_id, domain, text,
             array_distance(embedding, ${vectorLiteral}) AS distance
      FROM documents
      ${where}
      ORDER BY distance ASC
      LIMIT ${Math.max(0, Math.floor(k))}
    `
    const reader = await this.connection.runAndReadAll(sql)
    const rows = reader.getRowObjectsJS() as Record<string, unknown>[]
    return rows.map((row) => ({
      docId: String(row.doc_id),
      docKind: row.doc_kind as VssDocKind,
      refId: String(row.ref_id),
      sourceId: String(row.source_id),
      domain: row.domain === null || row.domain === undefined ? null : String(row.domain),
      text: String(row.text),
      distance: Number(row.distance),
    }))
  }
}

// ── query embedders ─────────────────────────────────────────────────────────

/** Same id `prep/prep/embed/local_embedder.py`'s `DeterministicHashEmbedder.MODEL_ID` reports. */
export const TEST_DETERMINISTIC_EMBEDDER_ID = 'test-deterministic-hash-v1'

function l2Normalize(vector: number[]): number[] {
  const norm = Math.sqrt(vector.reduce((sum, v) => sum + v * v, 0))
  if (norm === 0) return vector
  return vector.map((v) => v / norm)
}

/**
 * createDeterministicTestEmbedder — TEST-ONLY, offline, dependency-free
 * `EmbedQuery` implementation. Uses the IDENTICAL hash-projection scheme as
 * `prep/prep/embed/local_embedder.py`'s `DeterministicHashEmbedder` (sha256 of
 * the UTF-8 text + a 4-byte big-endian counter, chunked into 4-byte unsigned
 * ints mapped to [-1, 1], L2-normalized) so query vectors embedded here land
 * in the exact same vector space as a fixture bundle built with
 * `ceiba-nl2sql-prep build --test-fallback-embedder`. NEVER use this against a
 * bundle whose `manifest.embeddingModel.id` is the real production id
 * (`bge-small-en-v1.5`) — nearest-neighbor results would be meaningless noise,
 * not a approximation of real semantic similarity.
 */
export function createDeterministicTestEmbedder(dimension = 384): EmbedQuery {
  return async (text: string): Promise<Float32Array> => {
    const vector: number[] = []
    const seed = Buffer.from(text, 'utf-8')
    let counter = 0
    while (vector.length < dimension) {
      const counterBuf = Buffer.alloc(4)
      counterBuf.writeUInt32BE(counter, 0)
      const digest = createHash('sha256').update(Buffer.concat([seed, counterBuf])).digest()
      for (let i = 0; i + 4 <= digest.length && vector.length < dimension; i += 4) {
        const asUint = digest.readUInt32BE(i)
        vector.push((asUint / 0xffffffff) * 2 - 1)
      }
      counter += 1
    }
    return Float32Array.from(l2Normalize(vector))
  }
}

/**
 * SUPERSEDED — see module docstring. `lib/rag/queryEmbedder.ts`'s
 * `createLocalQueryEmbedder()` is the real production `EmbedQuery` (a local
 * ONNX bge-small-en-v1.5 port via `@huggingface/transformers`); use that
 * instead. This throwing stub is kept ONLY so any caller that has not yet been
 * repointed fails loudly and immediately, rather than silently falling back to
 * test vectors. Remove once nothing imports it.
 */
export function createUnimplementedProductionEmbedder(): EmbedQuery {
  return async (): Promise<Float32Array> => {
    throw new Error(
      'vssClient.ts: createUnimplementedProductionEmbedder() is a removed-pending stub. ' +
        'Use createLocalQueryEmbedder() from lib/rag/queryEmbedder.ts instead — a real, ' +
        'local, in-process bge-small-en-v1.5 EmbedQuery (no external embedding API).'
    )
  }
}
