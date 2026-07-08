/**
 * repository.ts — The single data-access seam (AR2/AR3/B2).
 *
 * ALL org + owner scoping lives HERE, not in route handlers. Routes call a
 * repository with the session; the repository is solely responsible for:
 *   - list/get   → returning ONLY records in session.orgId (and, for owner-private
 *                  entities, only the caller's own records)
 *   - upsert     → STAMPING orgId = session.orgId and owner = session.userId;
 *                  REJECTING (returning null) an update that targets a record whose
 *                  orgId differs from the caller's org (the B2 IDOR)
 *   - delete     → deleting ONLY within session.orgId
 *
 * This is the one place WS-G will later reimplement over Prisma/Postgres. Keeping
 * every scoping rule inside this module means the route handlers never see an
 * unscoped read/write and the Postgres swap is bounded to this file.
 *
 * Persistence today: the existing .data/ flat-file JSON pattern (gitignored).
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync, renameSync } from 'fs'
import { join } from 'path'
import { randomUUID } from 'crypto'
import type { Session } from '@/lib/apiAuth'
import type {
  Chart,
  Dashboard,
  ChartInput,
  DashboardInput,
} from '@/lib/domain'

// ── Repository interface ─────────────────────────────────────────────────────────

/**
 * Thin repository contract. `Input` is what a caller may submit (server-stamped
 * tenancy fields optional); `T` is the persisted canonical entity.
 */
export interface Repository<T, Input> {
  /** All records visible to `session` (scoped to session.orgId). */
  list(session: Session): Promise<T[]>
  /** Single record by id, or null if not found OR not in session.orgId. */
  get(session: Session, id: string): Promise<T | null>
  /**
   * Create or update. orgId/owner are stamped from `session` (any client-supplied
   * orgId/owner is ignored). Returns null if the record exists in another org
   * (cross-tenant write is rejected — the B2 IDOR).
   */
  upsert(session: Session, entity: Input): Promise<T | null>
  /** Delete by id within session.orgId. Returns true if a record was removed. */
  delete(session: Session, id: string): Promise<boolean>
}

// ── Flat-file backing store ──────────────────────────────────────────────────────

/**
 * Data directory. Defaults to `<cwd>/.data` (gitignored). Resolved per-call so a
 * test (or a future deployment) can redirect it via CEIBA_DATA_DIR without the
 * value being frozen at module load.
 */
function dataDir(): string {
  return process.env.CEIBA_DATA_DIR || join(process.cwd(), '.data')
}

function ensureDataDir(): void {
  const dir = dataDir()
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
}

function readAll<T>(file: string): T[] {
  try {
    if (!existsSync(file)) return []
    const parsed = JSON.parse(readFileSync(file, 'utf-8'))
    return Array.isArray(parsed) ? (parsed as T[]) : []
  } catch {
    return []
  }
}

function writeAll<T>(file: string, rows: T[]): void {
  ensureDataDir()
  // Write to a temp file then rename, so a crash mid-write cannot zero the store.
  const tmp = `${file}.${randomUUID()}.tmp`
  writeFileSync(tmp, JSON.stringify(rows, null, 2))
  renameSync(tmp, file)
}

/** Shape shared by every persisted row, used for scoping without knowing T fully. */
type PersistedRow = {
  id: string
  orgId: string
  owner: string
  createdAt: string
  updatedAt: string
}

// ── Generic flat-file repository ─────────────────────────────────────────────────

type NormalizeFn<T, Input> = (
  input: Input,
  base: PersistedRow,
  existing: T | null,
) => T

/**
 * Base flat-file repository enforcing org scoping. Concrete repos supply the file
 * name and a `normalize` that merges caller input with the server-stamped base
 * envelope into the canonical persisted shape.
 */
class FlatFileRepository<T extends PersistedRow, Input extends { id?: string }>
  implements Repository<T, Input>
{
  constructor(
    private readonly fileName: string,
    private readonly normalize: NormalizeFn<T, Input>,
  ) {}

  private get file(): string {
    return join(dataDir(), this.fileName)
  }

  async list(session: Session): Promise<T[]> {
    const rows = readAll<T>(this.file)
    return rows.filter((r) => r.orgId === session.orgId)
  }

  async get(session: Session, id: string): Promise<T | null> {
    const rows = readAll<T>(this.file)
    const row = rows.find((r) => r.id === id) ?? null
    // Cross-org read is indistinguishable from "not found" — do not leak existence.
    if (!row || row.orgId !== session.orgId) return null
    return row
  }

  async upsert(session: Session, entity: Input): Promise<T | null> {
    const rows = readAll<T>(this.file)
    const now = new Date().toISOString()
    const id = entity.id && String(entity.id).length > 0 ? String(entity.id) : randomUUID()
    const idx = rows.findIndex((r) => r.id === id)

    if (idx >= 0) {
      const existing = rows[idx]
      // B2 IDOR guard: refuse to mutate a record belonging to another org.
      if (existing.orgId !== session.orgId) return null
      const base: PersistedRow = {
        id,
        orgId: session.orgId, // stamped — client value ignored
        owner: existing.owner, // preserve original owner on update
        createdAt: existing.createdAt,
        updatedAt: now,
      }
      const merged = this.normalize(entity, base, existing)
      rows[idx] = merged
      writeAll(this.file, rows)
      return merged
    }

    // Create
    const base: PersistedRow = {
      id,
      orgId: session.orgId, // stamped — client value ignored
      owner: session.userId, // stamped — client value ignored
      createdAt: now,
      updatedAt: now,
    }
    const created = this.normalize(entity, base, null)
    rows.unshift(created)
    writeAll(this.file, rows)
    return created
  }

  async delete(session: Session, id: string): Promise<boolean> {
    const rows = readAll<T>(this.file)
    const target = rows.find((r) => r.id === id)
    // Only delete within the caller's org; a cross-org id is a no-op (returns false).
    if (!target || target.orgId !== session.orgId) return false
    const remaining = rows.filter((r) => r.id !== id)
    writeAll(this.file, remaining)
    return true
  }
}

// ── Concrete repositories ────────────────────────────────────────────────────────

/**
 * Normalize a client Dashboard draft into the canonical persisted shape. The
 * tenancy envelope comes from `base` (server-stamped); everything else is taken
 * from client input with sane defaults so charts/widgets/filters are never lost
 * and never undefined.
 */
export const dashboardRepository: Repository<Dashboard, DashboardInput> =
  new FlatFileRepository<Dashboard, DashboardInput>(
    'dashboards.json',
    (input, base): Dashboard => ({
      ...base,
      name: input.name,
      status: input.status,
      charts: input.charts ?? [],
      widgets: input.widgets ?? [],
      filters: input.filters ?? [],
    }),
  )

/**
 * Normalize a client Chart draft into the canonical persisted shape.
 */
export const chartRepository: Repository<Chart, ChartInput> =
  new FlatFileRepository<Chart, ChartInput>(
    'charts.json',
    (input, base): Chart => ({
      ...base,
      title: input.title,
      description: input.description,
      config: input.config,
      data: input.data,
      queryName: input.queryName,
      type: input.type,
      dataset: input.dataset,
      metrics: input.metrics,
      dimensions: input.dimensions,
    }),
  )
