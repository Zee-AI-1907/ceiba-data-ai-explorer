/**
 * QueryEngine.contract.test.ts — proves DuckDbEngine and TrinoEngine are both
 * compile-time-interchangeable implementations of QueryEngine (NL2SQL_SPEC.md §3),
 * and exercises the DuckDbEngine introspection path behaviorally (listCatalogs /
 * listSchemas / listTables / describeTable) against a real attached catalog.
 */

import { existsSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { DuckDBInstance } from '@duckdb/node-api'
import { DuckDbEngine } from '../DuckDbEngine'
import { TrinoEngine } from '../TrinoEngine'
import type { AttachSpec, QueryEngine } from '../QueryEngine'

// ── Type-level contract check ────────────────────────────────────────────────
// If either class ever drifts from the QueryEngine interface, this file fails to
// typecheck (`npx tsc --noEmit`) — that IS the test for the type-level half of the
// contract described in NL2SQL_PLAN.md §P2.
function assertSatisfiesQueryEngine(engine: QueryEngine): QueryEngine {
  return engine
}
assertSatisfiesQueryEngine(new DuckDbEngine())
assertSatisfiesQueryEngine(new TrinoEngine())

describe('QueryEngine contract', () => {
  it('both DuckDbEngine and TrinoEngine implement dialect()/capabilities() distinctly', () => {
    const duck: QueryEngine = new DuckDbEngine()
    const trino: QueryEngine = new TrinoEngine()
    expect(duck.dialect()).toBe('duckdb')
    expect(trino.dialect()).toBe('trino')
    expect(duck.capabilities().identifierQuote).toBe('"')
    expect(trino.capabilities().intervalSyntax).toBe('trino')
  })

  it('TrinoEngine compiles against the interface but defers introspection with a typed error', async () => {
    const trino: QueryEngine = new TrinoEngine()
    await expect(trino.listCatalogs()).rejects.toThrow(/not implemented \(Trino deferred/)
    await expect(trino.listSchemas('eclinics')).rejects.toThrow(/not implemented \(Trino deferred/)
    await expect(trino.listTables('eclinics', 'Shared')).rejects.toThrow(/not implemented \(Trino deferred/)
    await expect(
      trino.describeTable({ sourceId: 'eclinics', schema: 'Shared', name: 'Acceptances', quotedRef: '"Shared"."Acceptances"' })
    ).rejects.toThrow(/not implemented \(Trino deferred/)
  })

  describe('DuckDbEngine introspection (behavioral)', () => {
    let workDir: string
    let dbPath: string
    let engine: DuckDbEngine

    beforeEach(async () => {
      workDir = join(tmpdir(), `nl2sql-engine-contract-${process.pid}-${Date.now()}`)
      mkdirSync(workDir, { recursive: true })
      dbPath = join(workDir, 'source.duckdb')

      const instance = await DuckDBInstance.create(dbPath)
      const conn = await instance.connect()
      await conn.run('CREATE SCHEMA "Shared"')
      await conn.run(
        'CREATE TABLE "Shared"."Patients" ("Id" INTEGER PRIMARY KEY, "Name" VARCHAR)'
      )
      await conn.run(
        'CREATE TABLE "Shared"."Acceptances" ("Id" INTEGER PRIMARY KEY, "PatientId" INTEGER, "HospitalId" INTEGER, ' +
          'FOREIGN KEY ("PatientId") REFERENCES "Shared"."Patients"("Id"))'
      )
      await conn.run('CREATE INDEX "ix_acceptances_hospitalid" ON "Shared"."Acceptances"("HospitalId")')
      conn.closeSync()
      instance.closeSync()

      engine = new DuckDbEngine()
      const specs: AttachSpec[] = [
        { sourceId: 'src', engine: 'duckdb', dsn: dbPath, readOnly: true, alias: 'src' },
      ]
      await engine.attach(specs)
    })

    afterEach(async () => {
      await engine.dispose()
      if (existsSync(workDir)) rmSync(workDir, { recursive: true, force: true })
    })

    it('listCatalogs() includes the attached alias and excludes internal catalogs', async () => {
      const catalogs = await engine.listCatalogs()
      expect(catalogs).toContain('src')
      expect(catalogs).not.toContain('system')
      expect(catalogs).not.toContain('temp')
    })

    it('listSchemas() finds the attached schema', async () => {
      const schemas = await engine.listSchemas('src')
      expect(schemas).toContain('Shared')
    })

    it('listTables() finds both tables with dialect-quoted refs', async () => {
      const tables = await engine.listTables('src', 'Shared')
      const names = tables.map((t) => t.name).toSorted()
      expect(names).toEqual(['Acceptances', 'Patients'])
      const acceptances = tables.find((t) => t.name === 'Acceptances')
      expect(acceptances?.quotedRef).toBe('"src"."Shared"."Acceptances"')
    })

    it('describeTable() reports columns, primary key, foreign keys, and indexed columns', async () => {
      const result = await engine.describeTable({
        sourceId: 'src',
        schema: 'Shared',
        name: 'Acceptances',
        quotedRef: '"src"."Shared"."Acceptances"',
      })

      expect(result.primaryKey).toEqual(['Id'])
      expect(result.foreignKeys).toEqual([
        { fromColumns: ['PatientId'], toTable: 'Patients', toColumns: ['Id'] },
      ])

      const idCol = result.columns.find((c) => c.name === 'Id')
      expect(idCol?.isPrimaryKey).toBe(true)
      expect(idCol?.isIndexed).toBe(true) // PK implies indexed

      const hospitalIdCol = result.columns.find((c) => c.name === 'HospitalId')
      expect(hospitalIdCol?.isIndexed).toBe(true) // explicit btree index

      const patientIdCol = result.columns.find((c) => c.name === 'PatientId')
      expect(patientIdCol?.isIndexed).toBe(false) // no index, not a PK
    })
  })
})
