/**
 * BundleLoader.ts — load + validate a §1 artifact bundle (NL2SQL_SPEC.md §1,
 * NL2SQL_PLAN.md §P4).
 *
 * The bundle is the compliance seam between the Python prep toolchain and the TS
 * runtime (SPEC §1, §0 decision #1): a directory of JSON files + one DuckDB-vss
 * vector file, written once, hashed, and manifest-described. This loader:
 *
 *   1. Reads `manifest.json` FIRST (SPEC §1.2 "the runtime reads this first").
 *   2. Validates `bundleFormatVersion`'s MAJOR component against the version this
 *      runtime is pinned to — a minor/patch bump is forward-compatible, a major
 *      bump is refused (SPEC §1.2 "runtime pins a compatible major").
 *   3. REFUSES to load if `manifest.embeddingModel.id` differs from the runtime's
 *      expected embedding model id (SPEC §1.2, §4 Retriever.load() contract:
 *      "vectors are never mixed across models"). This is a hard error, not a
 *      warning — a silently-wrong embedding space would corrupt every retrieval.
 *   4. Verifies the sha256 of every sibling file against `manifest.files` (SPEC
 *      §1.2 "integrity: sha256 of every sibling file") — a tampered or
 *      partially-written bundle is refused before any JSON is trusted.
 *   5. Exposes typed accessors over catalog/keys/joingraph/profiles/phi/glossary/
 *      exemplars — the sole place other lib/rag/** modules read bundle JSON from
 *      (no module re-parses these files independently).
 *
 * Types below are typed per NL2SQL_SPEC.md §1 with ONE noted deviation: real
 * bundles produced by the current prep toolchain (`prep/prep/emit.py` /
 * `prep/prep/enrich/**`) emit `catalog.json` table `domain`/`grain` as
 * `string | null` (not populated by the mock-source enrich pass yet), and
 * `glossary.json` synonym `maps[]` entries are a discriminated union keyed by
 * `kind` with `coded-measurement | table | column | temporal-column | derived`
 * variants (richer than the single-shape sketch in SPEC §1.9's example) — see
 * `GlossaryMap` below. Both are documented, additive typing decisions, not
 * behavior changes.
 */

import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import path from 'node:path'

// ── manifest.json (SPEC §1.2) ──────────────────────────────────────────────

export interface BundleEmbeddingModel {
  id: string
  dimension: number
  normalization: string
  revision: string
  /** Additive field emitted by the current prep toolchain (fastembed vs. test-fallback). */
  lib?: string
}

export interface BundleSource {
  sourceId: string
  engine: string
  engineVersion: string
  database: string
  schemaFingerprint: string
  introspectedAt: string
  readOnly: boolean
}

export interface BundleCounts {
  schemas: number
  tables: number
  columns: number
  foreignKeys: number
  inferredJoinEdges: number
  glossaryTerms: number
  exemplars: number
  vectors: number
}

export interface BundlePhiGateSummary {
  passed: boolean
  gateVersion?: string
  phiColumnsetHash?: string
  checkedFiles?: number
  violations?: unknown[]
}

export interface BundleManifest {
  bundleFormatVersion: string
  bundleVersion: string
  createdAt: string
  builder: { name: string; version: string; gitSha: string | null }
  embeddingModel: BundleEmbeddingModel
  sources: BundleSource[]
  counts: BundleCounts
  files: Record<string, string>
  phiGate: BundlePhiGateSummary
}

// ── catalog.json (SPEC §1.3) ───────────────────────────────────────────────

export interface CatalogSchema {
  sourceId: string
  schema: string
  domain: string | null
  tableCount: number
}

export interface CatalogColumn {
  columnId: string
  name: string
  quotedName: string
  dataType: string
  nullable: boolean
  isPrimaryKey: boolean
  isTimeColumn: boolean
  isIndexed: boolean
  unit: string | null
  ordinalPosition: number
}

export interface CatalogIndex {
  name: string
  columns: string[]
  unique: boolean
  method: string
}

export interface CatalogTable {
  tableId: string
  sourceId: string
  schema: string
  name: string
  quotedRef: string
  /** Not yet populated by every enrich pass (e.g. the mock-source build) — null until enriched. */
  grain: string | null
  domain: string | null
  isLargeTimeSeries: boolean
  importanceScore: number
  columns: CatalogColumn[]
  indexes: CatalogIndex[]
}

export interface CatalogJson {
  schemas: CatalogSchema[]
  tables: CatalogTable[]
}

// ── keys.json (SPEC §1.4) ──────────────────────────────────────────────────

export interface PrimaryKeyEntry {
  tableId: string
  columns: string[]
}

export interface ForeignKeyEntry {
  fkId: string
  fromTable: string
  fromColumns: string[]
  toTable: string
  toColumns: string[]
  constraintName: string | null
  origin: 'declared' | 'inferred'
}

export interface KeysJson {
  primaryKeys: PrimaryKeyEntry[]
  foreignKeys: ForeignKeyEntry[]
}

// ── joingraph.json (SPEC §1.5) ─────────────────────────────────────────────

export type JoinCardinalityKind = 'one-to-one' | 'many-to-one' | 'one-to-many' | 'many-to-many'

export interface JoinGraphEdge {
  from: string
  fromColumns: string[]
  to: string
  toColumns: string[]
  joinCardinality: JoinCardinalityKind
  crossSource: boolean
  origin: 'declared' | 'inferred'
  confidence: number
}

export interface JoinGraphJson {
  nodes: string[]
  edges: JoinGraphEdge[]
}

// ── profiles.json (SPEC §1.6) ──────────────────────────────────────────────

export type ProfileColumnKind = 'numeric' | 'categorical' | 'phi-suppressed'

export interface ProfileTopCategory {
  value: string
  count: number
}

export interface ProfileColumn {
  columnId: string
  kind: ProfileColumnKind
  nonNullCount: number
  nullRate?: number
  distinctCount: number
  min?: number
  max?: number
  mean?: number
  topCategories?: ProfileTopCategory[]
  /** Additive field emitted by the current prep toolchain's profiler. */
  type?: string
}

export interface ProfileTable {
  tableId: string
  approxRowCount: number
  rowCountSource: string
  columns: ProfileColumn[]
}

export interface ProfilesJson {
  tables: ProfileTable[]
}

// ── phi.json (SPEC §1.7) ────────────────────────────────────────────────────

export type PhiClass = 'direct-identifier' | 'quasi-identifier' | 'free-text' | 'non-phi'
export type EgressPolicy = 'suppress' | 'aggregate-only' | 'allow'

export interface PhiColumnEntry {
  columnId: string
  normalizedKey: string
  phiClass: PhiClass
  matchedRule: string | null
  egressPolicy: EgressPolicy
}

export interface PhiJson {
  phiColumnsetHash: string
  columns: PhiColumnEntry[]
}

// ── glossary.json (SPEC §1.9) ──────────────────────────────────────────────
//
// The real prep toolchain emits a discriminated union of map shapes (richer
// than SPEC §1.9's single illustrative example) — one variant per `kind`.

export interface GlossaryMapCodedMeasurement {
  kind: 'coded-measurement'
  codeColumnId: string
  codeRefColumnId: string
  codeRefTableId: string
  codeValue: string
  valueColumnId: string
  timeColumnId?: string
  unit?: string
}

export interface GlossaryMapTable {
  kind: 'table'
  tableId: string
}

export interface GlossaryMapColumn {
  kind: 'column'
  columnId: string
  timeColumnId?: string
  unit?: string
}

export interface GlossaryMapTemporalColumn {
  kind: 'temporal-column'
  columnId: string
}

export interface GlossaryMapDerived {
  kind: 'derived'
  fromColumnId: string
  toColumnId: string
}

export type GlossaryMap =
  | GlossaryMapCodedMeasurement
  | GlossaryMapTable
  | GlossaryMapColumn
  | GlossaryMapTemporalColumn
  | GlossaryMapDerived

export interface GlossarySynonym {
  term: string
  aliases: string[]
  maps: GlossaryMap[]
}

export interface GlossaryCodeConcept {
  concept: string
  codes: string[]
}

export interface GlossaryCodeSystem {
  system: string
  columnId: string
  conceptMap: GlossaryCodeConcept[]
}

export interface GlossaryUnit {
  columnId: string
  unit: string
}

export interface GlossaryTemporal {
  phrase: string
  kind: 'relative-to-now' | 'relative-to-event'
  intervalIso: string
  eventColumnId?: string
  anchor?: string
}

export interface GlossaryJson {
  synonyms: GlossarySynonym[]
  abbreviations: Record<string, string>
  codeSystems: GlossaryCodeSystem[]
  units: GlossaryUnit[]
  temporal: GlossaryTemporal[]
}

// ── exemplars.json (SPEC §1.10) ─────────────────────────────────────────────

export interface ExemplarEntry {
  id: string
  question: string
  sql: string
  dialect: string
  tables: string[]
  tags: string[]
  validated: boolean
}

export interface ExemplarsJson {
  exemplars: ExemplarEntry[]
}

// ── loader ───────────────────────────────────────────────────────────────────

/** The embedding model id this TS runtime's dense retrieval is pinned to (SPEC §0a decision #2). */
export const EXPECTED_EMBEDDING_MODEL_ID = 'bge-small-en-v1.5'

/** The `test-deterministic-hash-v1` id `prep`'s DeterministicHashEmbedder reports (mirrors prep/prep/embed/local_embedder.py). */
export const TEST_FALLBACK_EMBEDDING_MODEL_ID = 'test-deterministic-hash-v1'

/** Compatible major version of the bundle format this loader understands (SPEC §1.2). */
const SUPPORTED_BUNDLE_FORMAT_MAJOR = 1

export class BundleLoadError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'BundleLoadError'
  }
}

export class EmbeddingModelMismatchError extends BundleLoadError {
  constructor(expected: string, actual: string) {
    super(
      `BundleLoader: manifest.embeddingModel.id="${actual}" does not match the runtime's expected ` +
        `embedding model id="${expected}". Refusing to load — vectors are never mixed across models ` +
        '(NL2SQL_SPEC.md §1.2, §4).'
    )
    this.name = 'EmbeddingModelMismatchError'
  }
}

export class BundleIntegrityError extends BundleLoadError {
  constructor(message: string) {
    super(message)
    this.name = 'BundleIntegrityError'
  }
}

export interface BundleLoaderOptions {
  /** Overrides the embedding model id this runtime requires. Defaults to EXPECTED_EMBEDDING_MODEL_ID. */
  expectedEmbeddingModelId?: string
  /**
   * Skip per-file sha256 verification against manifest.files. Defaults to false
   * (verification runs). Only intended for tooling that intentionally inspects a
   * partially-built bundle (e.g. `prep verify`'s TS-side counterpart, if any) —
   * production retrieval paths must never set this.
   */
  skipIntegrityCheck?: boolean
}

async function sha256OfFile(filePath: string): Promise<string> {
  const buf = await readFile(filePath)
  return createHash('sha256').update(buf).digest('hex')
}

async function readJson<T>(dir: string, filename: string): Promise<T> {
  const raw = await readFile(path.join(dir, filename), 'utf-8')
  return JSON.parse(raw) as T
}

/**
 * BundleLoader — loads a single versioned bundle directory (SPEC §1.1) and
 * exposes typed accessors. One instance per loaded bundle; call `load()` once
 * before using any accessor.
 */
export class BundleLoader {
  private manifestValue: BundleManifest | null = null
  private catalogValue: CatalogJson | null = null
  private keysValue: KeysJson | null = null
  private joinGraphValue: JoinGraphJson | null = null
  private profilesValue: ProfilesJson | null = null
  private phiValue: PhiJson | null = null
  private glossaryValue: GlossaryJson | null = null
  private exemplarsValue: ExemplarsJson | null = null
  private bundleDirValue: string | null = null

  /**
   * Load + validate the bundle at `bundleDir` (SPEC §4 `Retriever.load()`
   * contract: "validates the embedding-model id against the manifest").
   *
   * Order: read manifest -> check bundleFormatVersion major -> check
   * embeddingModel.id -> verify file hashes -> parse the remaining JSON files.
   * Any failure throws a `BundleLoadError` subclass and leaves this loader in
   * an unloaded state (no partial/inconsistent accessor data).
   */
  async load(bundleDir: string, options: BundleLoaderOptions = {}): Promise<void> {
    const expectedEmbeddingModelId = options.expectedEmbeddingModelId ?? EXPECTED_EMBEDDING_MODEL_ID

    const manifest = await readJson<BundleManifest>(bundleDir, 'manifest.json')

    const major = Number.parseInt(manifest.bundleFormatVersion.split('.')[0] ?? '', 10)
    if (!Number.isFinite(major) || major !== SUPPORTED_BUNDLE_FORMAT_MAJOR) {
      throw new BundleLoadError(
        `BundleLoader: bundle at "${bundleDir}" has bundleFormatVersion="${manifest.bundleFormatVersion}" ` +
          `(major=${major}); this runtime only supports major version ${SUPPORTED_BUNDLE_FORMAT_MAJOR}.`
      )
    }

    if (manifest.embeddingModel.id !== expectedEmbeddingModelId) {
      throw new EmbeddingModelMismatchError(expectedEmbeddingModelId, manifest.embeddingModel.id)
    }

    if (!options.skipIntegrityCheck) {
      await this.verifyFileHashes(bundleDir, manifest)
    }

    const [catalog, keys, joinGraph, profiles, phi, glossary, exemplars] = await Promise.all([
      readJson<CatalogJson>(bundleDir, 'catalog.json'),
      readJson<KeysJson>(bundleDir, 'keys.json'),
      readJson<JoinGraphJson>(bundleDir, 'joingraph.json'),
      readJson<ProfilesJson>(bundleDir, 'profiles.json'),
      readJson<PhiJson>(bundleDir, 'phi.json'),
      readJson<GlossaryJson>(bundleDir, 'glossary.json'),
      readJson<ExemplarsJson>(bundleDir, 'exemplars.json'),
    ])

    // Commit atomically: only after every file parsed successfully.
    this.manifestValue = manifest
    this.catalogValue = catalog
    this.keysValue = keys
    this.joinGraphValue = joinGraph
    this.profilesValue = profiles
    this.phiValue = phi
    this.glossaryValue = glossary
    this.exemplarsValue = exemplars
    this.bundleDirValue = bundleDir
  }

  private async verifyFileHashes(bundleDir: string, manifest: BundleManifest): Promise<void> {
    const mismatches: string[] = []
    for (const [filename, expectedHash] of Object.entries(manifest.files)) {
      // eslint-disable-next-line no-await-in-loop
      const actualHash = await sha256OfFile(path.join(bundleDir, filename))
      if (actualHash !== expectedHash) {
        mismatches.push(`${filename}: expected sha256=${expectedHash}, got sha256=${actualHash}`)
      }
    }
    if (mismatches.length > 0) {
      throw new BundleIntegrityError(
        `BundleLoader: sha256 mismatch for bundle at "${bundleDir}" — refusing to load a tampered/` +
          `corrupted/partially-written bundle. Mismatches:\n${mismatches.join('\n')}`
      )
    }
  }

  private ensureLoaded(): void {
    if (!this.manifestValue || !this.bundleDirValue) {
      throw new BundleLoadError('BundleLoader: load() must succeed before accessing bundle data.')
    }
  }

  get bundleDir(): string {
    this.ensureLoaded()
    return this.bundleDirValue as string
  }

  get manifest(): BundleManifest {
    this.ensureLoaded()
    return this.manifestValue as BundleManifest
  }

  get catalog(): CatalogJson {
    this.ensureLoaded()
    return this.catalogValue as CatalogJson
  }

  get keys(): KeysJson {
    this.ensureLoaded()
    return this.keysValue as KeysJson
  }

  get joinGraph(): JoinGraphJson {
    this.ensureLoaded()
    return this.joinGraphValue as JoinGraphJson
  }

  get profiles(): ProfilesJson {
    this.ensureLoaded()
    return this.profilesValue as ProfilesJson
  }

  get phi(): PhiJson {
    this.ensureLoaded()
    return this.phiValue as PhiJson
  }

  get glossary(): GlossaryJson {
    this.ensureLoaded()
    return this.glossaryValue as GlossaryJson
  }

  get exemplars(): ExemplarsJson {
    this.ensureLoaded()
    return this.exemplarsValue as ExemplarsJson
  }

  /** Absolute path to this bundle's vectors.duckdb (SPEC §1.11). Existence is not verified here — vssClient opens it lazily. */
  get vectorsDuckdbPath(): string {
    this.ensureLoaded()
    return path.join(this.bundleDirValue as string, 'vectors.duckdb')
  }

  /** Convenience: table lookup by tableId. */
  getTable(tableId: string): CatalogTable | undefined {
    return this.catalog.tables.find((t) => t.tableId === tableId)
  }

  /** Convenience: profile lookup by tableId. */
  getTableProfile(tableId: string): ProfileTable | undefined {
    return this.profiles.tables.find((t) => t.tableId === tableId)
  }

  /** Convenience: PHI classification lookup by columnId. */
  getColumnPhi(columnId: string): PhiColumnEntry | undefined {
    return this.phi.columns.find((c) => c.columnId === columnId)
  }
}
