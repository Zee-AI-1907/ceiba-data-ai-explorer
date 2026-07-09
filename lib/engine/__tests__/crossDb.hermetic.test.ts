/**
 * Hermetic cross-DB integration test (NL2SQL_PLAN.md §P2, §0a decision #4).
 *
 * Proves the QueryEngine abstraction's two headline claims — cross-catalog joins and
 * enforced read-only attach — WITHOUT depending on a live Postgres. Per §0a decision
 * #4, CI's primary path is a second synthetic Postgres service container; the
 * documented fallback (and what this file always exercises, so it is hermetic in any
 * environment) is two attached DuckDB catalogs, which DuckDB natively cross-joins and
 * natively supports READ_ONLY attach for — proving `supportsCrossCatalogJoin` and the
 * read-only guarantee without needing the `postgres` extension to reach a real server.
 *
 * The Postgres-attach path itself (`ATTACH '<dsn>' AS alias (TYPE postgres, READ_ONLY)`)
 * is exercised by P6/integration against the real P1 mock DB — not here. This file
 * never assumes the P1 mock DB (localhost:55433) is reachable; it builds its own
 * synthetic two-catalog topology from scratch in a scratch directory so it passes in
 * CI with zero external services.
 */

import { existsSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { DuckDBInstance } from '@duckdb/node-api'
import { DuckDbEngine, NonReadOnlyAttachError } from '../DuckDbEngine'
import type { AttachSpec } from '../QueryEngine'

describe('cross-DB hermetic integration (two DuckDB catalogs)', () => {
  let workDir: string
  let hospitalDbPath: string
  let referenceDbPath: string
  let engine: DuckDbEngine

  beforeEach(async () => {
    workDir = join(tmpdir(), `nl2sql-engine-crossdb-${process.pid}-${Date.now()}`)
    mkdirSync(workDir, { recursive: true })
    hospitalDbPath = join(workDir, 'hospital.duckdb')
    referenceDbPath = join(workDir, 'reference.duckdb')

    // Build source A: a synthetic stand-in for the "staging" hospital source
    // (SPEC §3.2 topology). Mirrors the shape of Acceptances → HospitalId.
    const hospitalInstance = await DuckDBInstance.create(hospitalDbPath)
    const hospitalConn = await hospitalInstance.connect()
    await hospitalConn.run('CREATE TABLE "Acceptances" ("PatientId" INTEGER, "HospitalId" INTEGER)')
    await hospitalConn.run(
      'INSERT INTO "Acceptances" VALUES (1, 5), (2, 5), (3, 7), (4, 9)'
    )
    hospitalConn.closeSync()
    hospitalInstance.closeSync()

    // Build source B: a synthetic stand-in for the "mock" reference source — the
    // cross-source join edge target per PLAN.md §0a #1 (Acceptances.HospitalId →
    // mock.public.HospitalRef.HospitalId).
    const referenceInstance = await DuckDBInstance.create(referenceDbPath)
    const referenceConn = await referenceInstance.connect()
    await referenceConn.run('CREATE SCHEMA "public"')
    await referenceConn.run('CREATE TABLE "public"."HospitalRef" ("HospitalId" INTEGER, "HospitalName" VARCHAR)')
    await referenceConn.run(
      "INSERT INTO \"public\".\"HospitalRef\" VALUES (5, 'Ceiba General'), (7, 'Ceiba North'), (9, 'Ceiba East')"
    )
    referenceConn.closeSync()
    referenceInstance.closeSync()

    engine = new DuckDbEngine()
  })

  afterEach(async () => {
    await engine.dispose()
    if (existsSync(workDir)) rmSync(workDir, { recursive: true, force: true })
  })

  it('attaches two synthetic sources and joins across them read-only', async () => {
    const specs: AttachSpec[] = [
      { sourceId: 'staging', engine: 'duckdb', dsn: hospitalDbPath, readOnly: true, alias: 'staging' },
      { sourceId: 'mock', engine: 'duckdb', dsn: referenceDbPath, readOnly: true, alias: 'mock' },
    ]
    await engine.attach(specs)

    expect(engine.capabilities().supportsCrossCatalogJoin).toBe(true)

    const result = await engine.execute(
      `SELECT a."PatientId", a."HospitalId", h."HospitalName"
       FROM staging."Acceptances" a
       JOIN mock."public"."HospitalRef" h ON a."HospitalId" = h."HospitalId"
       ORDER BY a."PatientId"`,
      { maxRows: 100, deadlineMs: 5_000 }
    )

    expect(result.truncated).toBe(false)
    expect(result.rowCount).toBe(4)
    expect(result.rows).toEqual([
      { PatientId: 1, HospitalId: 5, HospitalName: 'Ceiba General' },
      { PatientId: 2, HospitalId: 5, HospitalName: 'Ceiba General' },
      { PatientId: 3, HospitalId: 7, HospitalName: 'Ceiba North' },
      { PatientId: 4, HospitalId: 9, HospitalName: 'Ceiba East' },
    ])
  })

  it('rejects a write attempt (INSERT) against a READ_ONLY-attached catalog', async () => {
    const specs: AttachSpec[] = [
      { sourceId: 'staging', engine: 'duckdb', dsn: hospitalDbPath, readOnly: true, alias: 'staging' },
      { sourceId: 'mock', engine: 'duckdb', dsn: referenceDbPath, readOnly: true, alias: 'mock' },
    ]
    await engine.attach(specs)

    await expect(
      engine.execute('INSERT INTO staging."Acceptances" VALUES (99, 1)', { maxRows: 10, deadlineMs: 5_000 })
    ).rejects.toThrow(/read-?only/i)
  })

  it('rejects a write attempt (CREATE TABLE) against a READ_ONLY-attached catalog', async () => {
    const specs: AttachSpec[] = [
      { sourceId: 'mock', engine: 'duckdb', dsn: referenceDbPath, readOnly: true, alias: 'mock' },
    ]
    await engine.attach(specs)

    await expect(
      engine.execute('CREATE TABLE mock."public"."Evil" (x INTEGER)', { maxRows: 10, deadlineMs: 5_000 })
    ).rejects.toThrow(/read-?only/i)
  })

  it('attach() hard-errors before a bad spec ever reaches DuckDB (defense in depth)', async () => {
    const badSpec = {
      sourceId: 'mock',
      engine: 'duckdb',
      dsn: referenceDbPath,
      readOnly: false,
      alias: 'mock',
    } as unknown as AttachSpec

    await expect(engine.attach([badSpec])).rejects.toThrow(NonReadOnlyAttachError)

    // Confirm nothing got attached — the catalog must not be usable after a rejected attach.
    const catalogs = await engine.listCatalogs()
    expect(catalogs).not.toContain('mock')
  })
})
