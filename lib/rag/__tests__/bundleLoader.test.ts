/**
 * bundleLoader.test.ts — NL2SQL_PLAN.md §P4 test list: "hash mismatch + model
 * mismatch rejected". Exercises BundleLoader.ts against the committed tiny
 * fixture bundle (lib/rag/__tests__/fixtures/bundles/mock-v1), built once via
 * `ceiba-nl2sql-prep build --only mock --test-fallback-embedder` against the
 * OrbStack mock Postgres (docs/mock-topology.md) and committed so tests never
 * need the mock DB, Python venv, or a model download at test time — fully
 * hermetic/CI-safe (NL2SQL_PLAN.md §0 ground rule #4).
 */

import { readFile, writeFile, mkdtemp, rm, cp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeAll, describe, expect, it } from 'vitest'
import {
  BundleLoadError,
  BundleLoader,
  BundleIntegrityError,
  EmbeddingModelMismatchError,
  TEST_FALLBACK_EMBEDDING_MODEL_ID,
} from '../BundleLoader'

const FIXTURE_BUNDLE_DIR = path.join(__dirname, 'fixtures', 'bundles', 'mock-v1')

/** Copies the fixture bundle into a fresh temp dir so mutation tests never touch the committed fixture. */
async function copyFixtureToTempDir(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), 'nl2sql-bundleloader-'))
  await cp(FIXTURE_BUNDLE_DIR, dir, { recursive: true })
  return dir
}

describe('BundleLoader — happy path against the fixture bundle', () => {
  it('loads the fixture bundle end to end and exposes typed accessors', async () => {
    const loader = new BundleLoader()
    await loader.load(FIXTURE_BUNDLE_DIR, { expectedEmbeddingModelId: TEST_FALLBACK_EMBEDDING_MODEL_ID })

    expect(loader.manifest.bundleFormatVersion.startsWith('1.')).toBe(true)
    expect(loader.manifest.embeddingModel.id).toBe(TEST_FALLBACK_EMBEDDING_MODEL_ID)
    expect(loader.catalog.tables.length).toBeGreaterThan(0)
    expect(loader.getTable('mock.public.MeasurementsMock')).toBeDefined()
    expect(loader.getTable('mock.public.MeasurementsMock')?.isLargeTimeSeries).toBe(true)
    expect(loader.getTableProfile('mock.public.MeasurementsMock')?.approxRowCount).toBeGreaterThan(0)
    expect(loader.keys.foreignKeys.length).toBeGreaterThan(0)
    expect(loader.joinGraph.edges.length).toBeGreaterThan(0)
    expect(loader.glossary.synonyms.length).toBeGreaterThan(0)
    expect(loader.exemplars.exemplars.length).toBeGreaterThan(0)
    expect(loader.phi.columns.length).toBeGreaterThan(0)
    expect(loader.vectorsDuckdbPath.endsWith('vectors.duckdb')).toBe(true)
  })

  it('throws before any accessor is used if load() has not been called', () => {
    const loader = new BundleLoader()
    expect(() => loader.manifest).toThrow(BundleLoadError)
    expect(() => loader.catalog).toThrow(BundleLoadError)
  })
})

describe('BundleLoader — embedding-model mismatch is refused', () => {
  it('refuses to load when manifest.embeddingModel.id does not match the runtime expectation', async () => {
    const loader = new BundleLoader()
    await expect(
      loader.load(FIXTURE_BUNDLE_DIR, { expectedEmbeddingModelId: 'bge-small-en-v1.5' })
    ).rejects.toThrow(EmbeddingModelMismatchError)
  })

  it('the rejected loader remains unloaded (no partial state leaks through accessors)', async () => {
    const loader = new BundleLoader()
    await loader.load(FIXTURE_BUNDLE_DIR, { expectedEmbeddingModelId: 'bge-small-en-v1.5' }).catch(() => undefined)
    expect(() => loader.manifest).toThrow(BundleLoadError)
  })
})

describe('BundleLoader — sha256 hash mismatch is refused', () => {
  let tempDir: string

  afterEach(async () => {
    if (tempDir) await rm(tempDir, { recursive: true, force: true })
  })

  it('refuses to load when a sibling file has been tampered with (sha256 no longer matches manifest.files)', async () => {
    tempDir = await copyFixtureToTempDir()
    const catalogPath = path.join(tempDir, 'catalog.json')
    const original = await readFile(catalogPath, 'utf-8')
    // Tamper: flip a byte in the JSON body (still valid JSON syntax is not
    // required for the hash check to fail — the byte comparison runs before
    // any JSON.parse of the tampered file).
    await writeFile(catalogPath, original.replace('"tables"', '"tablesX"'))

    const loader = new BundleLoader()
    await expect(
      loader.load(tempDir, { expectedEmbeddingModelId: TEST_FALLBACK_EMBEDDING_MODEL_ID })
    ).rejects.toThrow(BundleIntegrityError)
  })

  it('skipIntegrityCheck=true bypasses the hash check (opt-in only, documented tooling escape hatch)', async () => {
    tempDir = await copyFixtureToTempDir()
    const catalogPath = path.join(tempDir, 'catalog.json')
    const original = await readFile(catalogPath, 'utf-8')
    await writeFile(catalogPath, original.replace('"tables"', '"tablesX"'))

    const loader = new BundleLoader()
    // catalog.json is now invalid JSON key name but still parses (renamed key,
    // not malformed) — this only proves the hash gate itself was skipped, not
    // that arbitrary corruption is tolerated.
    await expect(
      loader.load(tempDir, { expectedEmbeddingModelId: TEST_FALLBACK_EMBEDDING_MODEL_ID, skipIntegrityCheck: true })
    ).resolves.toBeUndefined()
  })
})

describe('BundleLoader — bundleFormatVersion major mismatch is refused', () => {
  let tempDir: string

  afterEach(async () => {
    if (tempDir) await rm(tempDir, { recursive: true, force: true })
  })

  it('refuses to load a bundle whose bundleFormatVersion major differs from the supported major', async () => {
    tempDir = await copyFixtureToTempDir()
    const manifestPath = path.join(tempDir, 'manifest.json')
    const manifest = JSON.parse(await readFile(manifestPath, 'utf-8'))
    manifest.bundleFormatVersion = '2.0.0'
    await writeFile(manifestPath, JSON.stringify(manifest, null, 2))

    const loader = new BundleLoader()
    await expect(
      loader.load(tempDir, { expectedEmbeddingModelId: TEST_FALLBACK_EMBEDDING_MODEL_ID, skipIntegrityCheck: true })
    ).rejects.toThrow(BundleLoadError)
  })
})

describe('BundleLoader — fixture bundle sanity (used by retriever.test.ts)', () => {
  beforeAll(async () => {
    // Guard: if the committed fixture ever goes stale relative to this test
    // file's assumptions, fail loudly here rather than via a confusing
    // failure deep in retriever.test.ts.
    const manifestRaw = await readFile(path.join(FIXTURE_BUNDLE_DIR, 'manifest.json'), 'utf-8')
    const manifest = JSON.parse(manifestRaw)
    expect(manifest.embeddingModel.id).toBe(TEST_FALLBACK_EMBEDDING_MODEL_ID)
    expect(manifest.embeddingModel.dimension).toBe(384)
  })

  it('the fixture contains the MeasurementsMock large-time-series table and its RecordedAt time column', async () => {
    const loader = new BundleLoader()
    await loader.load(FIXTURE_BUNDLE_DIR, { expectedEmbeddingModelId: TEST_FALLBACK_EMBEDDING_MODEL_ID })
    const table = loader.getTable('mock.public.MeasurementsMock')
    expect(table).toBeDefined()
    expect(table?.isLargeTimeSeries).toBe(true)
    const timeColumn = table?.columns.find((c) => c.isTimeColumn)
    expect(timeColumn?.name).toBe('RecordedAt')
  })
})
