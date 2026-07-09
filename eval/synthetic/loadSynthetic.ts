/**
 * loadSynthetic.ts — synthetic execution topology for the eval harness
 * (NL2SQL_SPEC.md §6.3 mode (a), NL2SQL_PLAN.md §P6 task 1).
 *
 * Builds a HERMETIC DuckDB-native `mock.public` schema that mirrors the shape
 * of the committed P4 fixture bundle's catalog (`lib/rag/__tests__/fixtures/
 * bundles/mock-v1/catalog.json`: PatientMock, MeasurementsMock, VisitMock,
 * WardRef, MeasurementTypeRef, HospitalRef) with:
 *   - thousands of MeasurementsMock rows (shape, not scale — SPEC §6.3, §8.1
 *     "no 337M-row synthetic data"), scattered across a realistic RecordedAt
 *     range with FK integrity to PatientMock/MeasurementTypeRef;
 *   - a deterministic seed (mulberry32 PRNG) so every CI run produces the
 *     identical row set — no flakiness, no wall-clock drift baked into row
 *     COUNTS (the two canonical-question windows below are anchored at
 *     `now()` intentionally, mirroring the real natural-language "in the last
 *     N hours"/"yesterday" semantics, but the guaranteed matching rows are
 *     inserted with an offset computed AT BUILD TIME from the current clock,
 *     so a query issued moments later inside the same test run still lands
 *     inside the window — this is the same posture as generate.test.ts's
 *     hermetic seed, not a new pattern);
 *   - NO PHI: every value is a synthetic label/number, never a real patient
 *     cell (SPEC §8.2 invariant #4 "synthetic data for evaluation, never real
 *     PHI").
 *
 * This gives `runEval.ts` a fully in-process execution target — no
 * dependency on the mock Postgres container (localhost:55433) and no
 * network — so the default eval mode is hermetic per SPEC §6.3(a) and PLAN
 * §0 ground rule #4 ("CI green without the live staging DB").
 *
 * ── Why DuckDB-native tables, not an ATTACHed synthetic Postgres ───────────
 * `generate.test.ts` (P5) established the precedent: a DuckDB file whose
 * `public` schema mirrors the fixture bundle's tables, attached under alias
 * `mock`, is sufficient for `engine.explain`/`engine.execute` to bind SQL
 * that references `mock.public."TableName"` exactly as the retriever's
 * `quotedRef`s render them. This module generalizes that one-question seed
 * into a full, FK-consistent, thousands-of-rows synthetic dataset covering
 * every table in the bundle.
 */

import { existsSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { DuckDBInstance } from '@duckdb/node-api'
import { DuckDbEngine } from '../../lib/engine/DuckDbEngine'
import type { AttachSpec } from '../../lib/engine/QueryEngine'

// ── deterministic PRNG (mulberry32) ─────────────────────────────────────────
// A tiny, dependency-free, seedable PRNG so the synthetic dataset is
// byte-for-byte reproducible across CI runs (SPEC §0a decision #5's sibling
// requirement: deterministic, seed-controlled fixtures — mirrors the mock
// Postgres seed's own determinism, docker/mock-postgres/init/02_seed.sql).
function mulberry32(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a |= 0
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

export const SYNTHETIC_SEED = 20260709

/** Wards, hospitals, measurement types — small reference vocab, matches the fixture bundle's catalog. */
const HOSPITALS = [
  { hospitalId: 1, name: 'Ceiba General', region: 'North' },
  { hospitalId: 2, name: 'Ceiba East', region: 'East' },
]

const WARDS = [
  { wardId: 10, name: 'ICU-A', hospitalId: 1 },
  { wardId: 11, name: 'ICU-B', hospitalId: 1 },
  { wardId: 20, name: 'Ward-C', hospitalId: 2 },
  { wardId: 21, name: 'Ward-D', hospitalId: 2 },
]

const MEASUREMENT_TYPES = [
  { measurementTypeId: 1, name: 'Heart Rate', unit: 'bpm', min: 50, max: 180 },
  { measurementTypeId: 2, name: 'SpO2', unit: '%', min: 85, max: 100 },
  { measurementTypeId: 3, name: 'Respiratory Rate', unit: 'breaths/min', min: 8, max: 40 },
  { measurementTypeId: 4, name: 'Temperature', unit: 'degC', min: 35, max: 40 },
  { measurementTypeId: 5, name: 'Mean Arterial Pressure', unit: 'mmHg', min: 50, max: 130 },
]

const AGE_BANDS = ['0-17', '18-39', '40-64', '65+']

export interface SyntheticTopologyOptions {
  /** Number of synthetic patients. Default 200 (shape, not scale — SPEC §8.1). */
  patientCount?: number
  /** Approx MeasurementsMock rows PER patient (spread across the whole time range). Default 25 (~5000 total for 200 patients). */
  measurementsPerPatient?: number
  /** How far back (hours) the RecordedAt range extends from "now" at build time. Default 720 (30 days). */
  measurementWindowHours?: number
  /** Deterministic PRNG seed. Default SYNTHETIC_SEED. */
  seed?: number
  /**
   * DuckDB file path. Defaults to a fresh temp file (so parallel eval runs
   * never collide); pass an explicit path only for debugging/inspection.
   */
  dbPath?: string
}

export interface SyntheticTopology {
  /** Absolute path to the built DuckDB file backing this topology. */
  dbPath: string
  /** A ready-to-use QueryEngine with the synthetic DB ATTACHed as alias "mock" (mirrors the real bundle's sourceId). */
  engine: DuckDbEngine
  /** Counts actually inserted, for the EvalReport / sanity assertions. */
  counts: {
    patients: number
    measurements: number
    visits: number
    wards: number
    measurementTypes: number
    hospitals: number
  }
  /** Tears down the engine and removes the temp DuckDB file (if one was created). */
  dispose(): Promise<void>
}

function quoteLiteral(value: string): string {
  return `'${value.replace(/'/g, "''")}'`
}

/**
 * buildSyntheticTopology — the SPEC §6.3(a) hermetic execution target.
 * Creates a fresh DuckDB file, populates it with an FK-consistent, seeded,
 * shape-preserving synthetic dataset mirroring the bundle catalog's 6 tables,
 * then attaches it via `DuckDbEngine` under alias `mock` (matching the
 * fixture bundle's `sourceId`), so generated SQL referencing
 * `mock.public."MeasurementsMock"` etc. binds and executes exactly as it
 * would against the real (or mock-Postgres) topology.
 */
export async function buildSyntheticTopology(options: SyntheticTopologyOptions = {}): Promise<SyntheticTopology> {
  const patientCount = options.patientCount ?? 200
  const measurementsPerPatient = options.measurementsPerPatient ?? 25
  const measurementWindowHours = options.measurementWindowHours ?? 720
  const seed = options.seed ?? SYNTHETIC_SEED
  const rand = mulberry32(seed)

  const ownsTempDir = !options.dbPath
  const workDir = ownsTempDir ? path.join(tmpdir(), `nl2sql-eval-synthetic-${process.pid}-${Date.now()}`) : undefined
  if (workDir) mkdirSync(workDir, { recursive: true })
  const dbPath = options.dbPath ?? path.join(workDir as string, 'synthetic.duckdb')

  const buildInstance = await DuckDBInstance.create(dbPath)
  const buildConn = await buildInstance.connect()

  await buildConn.run('CREATE SCHEMA IF NOT EXISTS public')

  // ── HospitalRef ────────────────────────────────────────────────────────
  await buildConn.run(`
    CREATE TABLE public."HospitalRef" (
      "HospitalId" INTEGER PRIMARY KEY,
      "name" VARCHAR NOT NULL,
      "region" VARCHAR NOT NULL
    )
  `)
  for (const h of HOSPITALS) {
    // eslint-disable-next-line no-await-in-loop
    await buildConn.run(
      `INSERT INTO public."HospitalRef" VALUES (${h.hospitalId}, ${quoteLiteral(h.name)}, ${quoteLiteral(h.region)})`
    )
  }

  // ── WardRef ────────────────────────────────────────────────────────────
  await buildConn.run(`
    CREATE TABLE public."WardRef" (
      "WardId" INTEGER PRIMARY KEY,
      "name" VARCHAR NOT NULL,
      "hospitalId" INTEGER NOT NULL REFERENCES public."HospitalRef"("HospitalId")
    )
  `)
  for (const w of WARDS) {
    // eslint-disable-next-line no-await-in-loop
    await buildConn.run(`INSERT INTO public."WardRef" VALUES (${w.wardId}, ${quoteLiteral(w.name)}, ${w.hospitalId})`)
  }

  // ── MeasurementTypeRef ─────────────────────────────────────────────────
  await buildConn.run(`
    CREATE TABLE public."MeasurementTypeRef" (
      "MeasurementTypeId" INTEGER PRIMARY KEY,
      "name" VARCHAR NOT NULL,
      "unit" VARCHAR NOT NULL
    )
  `)
  for (const mt of MEASUREMENT_TYPES) {
    // eslint-disable-next-line no-await-in-loop
    await buildConn.run(
      `INSERT INTO public."MeasurementTypeRef" VALUES (${mt.measurementTypeId}, ${quoteLiteral(mt.name)}, ${quoteLiteral(mt.unit)})`
    )
  }

  // ── PatientMock ────────────────────────────────────────────────────────
  await buildConn.run(`
    CREATE TABLE public."PatientMock" (
      "patientRef" INTEGER PRIMARY KEY,
      "patientCode" VARCHAR NOT NULL UNIQUE,
      "hospitalId" INTEGER NOT NULL REFERENCES public."HospitalRef"("HospitalId"),
      "wardId" INTEGER REFERENCES public."WardRef"("WardId"),
      "ageBand" VARCHAR NOT NULL
    )
  `)
  const patientValues: string[] = []
  for (let patientRef = 1; patientRef <= patientCount; patientRef++) {
    const hospital = HOSPITALS[Math.floor(rand() * HOSPITALS.length)]!
    const wardsForHospital = WARDS.filter((w) => w.hospitalId === hospital.hospitalId)
    const ward = wardsForHospital[Math.floor(rand() * wardsForHospital.length)]!
    const ageBand = AGE_BANDS[Math.floor(rand() * AGE_BANDS.length)]!
    const patientCode = `SYN-${String(patientRef).padStart(5, '0')}`
    patientValues.push(`(${patientRef}, ${quoteLiteral(patientCode)}, ${hospital.hospitalId}, ${ward.wardId}, ${quoteLiteral(ageBand)})`)
  }
  await insertBatched(buildConn, 'public."PatientMock"', patientValues)

  // ── VisitMock ──────────────────────────────────────────────────────────
  // Every patient gets exactly one visit; a deterministic subset of visits is
  // anchored to "yesterday" (relative to build time) so the canonical
  // "patients admitted yesterday" golden question always has matching rows,
  // regardless of when the eval runs.
  await buildConn.run(`
    CREATE TABLE public."VisitMock" (
      "visitRef" INTEGER PRIMARY KEY,
      "patientRef" INTEGER NOT NULL REFERENCES public."PatientMock"("patientRef"),
      "wardId" INTEGER REFERENCES public."WardRef"("WardId"),
      "admittedAt" TIMESTAMPTZ NOT NULL,
      "dischargedAt" TIMESTAMPTZ
    )
  `)
  const visitValues: string[] = []
  // Reserve the first ~15% of patients (min 5) for a guaranteed "admitted
  // yesterday" window; the rest spread across the last 30 days.
  const yesterdayAdmissionCount = Math.max(5, Math.floor(patientCount * 0.15))
  for (let patientRef = 1; patientRef <= patientCount; patientRef++) {
    const wardsForPatient = WARDS
    const ward = wardsForPatient[Math.floor(rand() * wardsForPatient.length)]!
    let admittedAtExpr: string
    if (patientRef <= yesterdayAdmissionCount) {
      // Spread evenly within [now - 1d - 12h, now - 1d + 12h) so every row is
      // guaranteed to fall on "yesterday" (calendar day, UTC) regardless of
      // what hour the eval happens to run at.
      const hoursIntoYesterday = rand() * 24
      admittedAtExpr = `date_trunc('day', now() - INTERVAL '1 day') + INTERVAL '${hoursIntoYesterday.toFixed(4)} hours'`
    } else {
      const daysAgo = 2 + rand() * 28
      admittedAtExpr = `now() - INTERVAL '${daysAgo.toFixed(4)} days'`
    }
    const dischargedExpr = rand() < 0.6 ? `(${admittedAtExpr}) + INTERVAL '${(1 + rand() * 5).toFixed(2)} days'` : 'NULL'
    visitValues.push(`(${patientRef}, ${patientRef}, ${ward.wardId}, ${admittedAtExpr}, ${dischargedExpr})`)
  }
  await insertBatched(buildConn, 'public."VisitMock"', visitValues)

  // ── MeasurementsMock ───────────────────────────────────────────────────
  // Thousands of rows (shape, never 337M — SPEC §8.1) spread across
  // `measurementWindowHours`. A deterministic subset of Heart-Rate rows is
  // anchored inside "the last 3 hours" (relative to build time) with
  // Value > 120 so the canonical "heart rate > 120 in the last 3 hours"
  // golden question always has matching rows.
  await buildConn.run(`
    CREATE TABLE public."MeasurementsMock" (
      "Id" BIGINT PRIMARY KEY,
      "DeviceId" INTEGER NOT NULL,
      "MeasurementTypeId" INTEGER NOT NULL REFERENCES public."MeasurementTypeRef"("MeasurementTypeId"),
      "Value" DOUBLE NOT NULL,
      "RecordedAt" TIMESTAMPTZ NOT NULL,
      "patientRef" INTEGER NOT NULL REFERENCES public."PatientMock"("patientRef")
    )
  `)
  const measurementValues: string[] = []
  let measurementId = 1
  const heartRateType = MEASUREMENT_TYPES[0]!

  for (let patientRef = 1; patientRef <= patientCount; patientRef++) {
    const deviceId = 1000 + patientRef
    for (let i = 0; i < measurementsPerPatient; i++) {
      const measurementType = MEASUREMENT_TYPES[Math.floor(rand() * MEASUREMENT_TYPES.length)]!
      const value = measurementType.min + rand() * (measurementType.max - measurementType.min)
      const hoursAgo = rand() * measurementWindowHours
      measurementValues.push(
        `(${measurementId}, ${deviceId}, ${measurementType.measurementTypeId}, ${value.toFixed(2)}, now() - INTERVAL '${hoursAgo.toFixed(4)} hours', ${patientRef})`
      )
      measurementId += 1
    }
  }
  // Guaranteed-match block: N rows, Heart Rate, Value>120, RecordedAt within
  // the last 3 hours — one per one-in-eight patient (deterministic subset),
  // so the canonical temporal question always has a stable, non-empty,
  // non-flaky result set no matter when the eval executes.
  const guaranteedMatchPatients = Array.from({ length: Math.max(3, Math.floor(patientCount / 8)) }, (_, i) => (i * 8) % patientCount + 1)
  for (const patientRef of guaranteedMatchPatients) {
    const deviceId = 1000 + patientRef
    const value = 121 + rand() * 30 // strictly > 120
    const minutesAgo = rand() * 170 // strictly within 3 hours (< 180 min)
    measurementValues.push(
      `(${measurementId}, ${deviceId}, ${heartRateType.measurementTypeId}, ${value.toFixed(2)}, now() - INTERVAL '${minutesAgo.toFixed(4)} minutes', ${patientRef})`
    )
    measurementId += 1
  }
  await insertBatched(buildConn, 'public."MeasurementsMock"', measurementValues)

  await buildConn.run('CREATE INDEX IF NOT EXISTS ix_measurementsmock_recordedat ON public."MeasurementsMock" ("RecordedAt")')
  await buildConn.run(
    'CREATE INDEX IF NOT EXISTS ix_measurementsmock_type_recordedat ON public."MeasurementsMock" ("MeasurementTypeId", "RecordedAt")'
  )

  buildConn.closeSync()
  buildInstance.closeSync()

  // ── attach read-only via the real QueryEngine (mirrors runtime/eval usage) ──
  const engine = new DuckDbEngine()
  const specs: AttachSpec[] = [{ sourceId: 'mock', engine: 'duckdb', dsn: dbPath, readOnly: true, alias: 'mock' }]
  await engine.attach(specs)

  return {
    dbPath,
    engine,
    counts: {
      patients: patientCount,
      measurements: measurementValues.length,
      visits: visitValues.length,
      wards: WARDS.length,
      measurementTypes: MEASUREMENT_TYPES.length,
      hospitals: HOSPITALS.length,
    },
    async dispose() {
      await engine.dispose()
      if (workDir && existsSync(workDir)) rmSync(workDir, { recursive: true, force: true })
    },
  }
}

/** Batches large INSERT VALUES lists so DuckDB never sees one gigantic statement. */
async function insertBatched(
  conn: { run: (sql: string) => Promise<unknown> },
  quotedTable: string,
  rows: string[],
  batchSize = 500
): Promise<void> {
  for (let i = 0; i < rows.length; i += batchSize) {
    const batch = rows.slice(i, i + batchSize)
    if (batch.length === 0) continue
    // eslint-disable-next-line no-await-in-loop
    await conn.run(`INSERT INTO ${quotedTable} VALUES ${batch.join(', ')}`)
  }
}
