/**
 * repository.test.ts — Proves org isolation at the single scoping seam (B2 IDOR).
 *
 * A user in org A must NOT be able to get / list / update / delete a record that
 * belongs to org B. All scoping lives in lib/repository.ts, so these tests target
 * it directly with synthetic sessions and a throwaway data dir (no real services).
 */

import { describe, it, expect, beforeEach, afterAll } from 'vitest'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

// Redirect the flat-file store to an isolated temp dir BEFORE importing the repo
// (dataDir() reads this env var per-call, so setting it here is sufficient).
const TMP_DATA_DIR = mkdtempSync(join(tmpdir(), 'ceiba-repo-test-'))
process.env.CEIBA_DATA_DIR = TMP_DATA_DIR

// eslint-disable-next-line import/first
import { dashboardRepository, chartRepository } from '@/lib/repository'
// eslint-disable-next-line import/first
import type { Session } from '@/lib/apiAuth'
// eslint-disable-next-line import/first
import type { DashboardInput, ChartInput } from '@/lib/domain'

const userA: Session = { userId: 'user-a', orgId: 'org-A', role: 'analyst' }
const userB: Session = { userId: 'user-b', orgId: 'org-B', role: 'analyst' }

function dashboardDraft(id: string, name: string): DashboardInput {
  return { id, name, status: 'Draft' }
}

function chartDraft(id: string, title: string): ChartInput {
  return { id, title }
}

afterAll(() => {
  rmSync(TMP_DATA_DIR, { recursive: true, force: true })
})

beforeEach(async () => {
  // Clean slate per test: remove anything either user can see.
  for (const s of [userA, userB]) {
    for (const d of await dashboardRepository.list(s)) {
      await dashboardRepository.delete(s, d.id)
    }
    for (const c of await chartRepository.list(s)) {
      await chartRepository.delete(s, c.id)
    }
  }
})

describe('repository org isolation (B2 IDOR) — dashboards', () => {
  it('stamps orgId/owner from the session and ignores client-supplied values', async () => {
    const saved = await dashboardRepository.upsert(userA, {
      ...dashboardDraft('d1', 'A dashboard'),
      // Malicious client trying to plant a record into org B, owned by someone else:
      orgId: 'org-B',
      owner: 'user-b',
    } as DashboardInput)

    expect(saved).not.toBeNull()
    expect(saved!.orgId).toBe('org-A')
    expect(saved!.owner).toBe('user-a')
  })

  it('user B cannot GET a dashboard owned by org A', async () => {
    await dashboardRepository.upsert(userA, dashboardDraft('d1', 'A dashboard'))

    expect(await dashboardRepository.get(userA, 'd1')).not.toBeNull()
    // Cross-org read is indistinguishable from "not found".
    expect(await dashboardRepository.get(userB, 'd1')).toBeNull()
  })

  it('user B cannot LIST dashboards owned by org A', async () => {
    await dashboardRepository.upsert(userA, dashboardDraft('d1', 'A dashboard'))
    await dashboardRepository.upsert(userB, dashboardDraft('d2', 'B dashboard'))

    const aList = await dashboardRepository.list(userA)
    const bList = await dashboardRepository.list(userB)

    expect(aList.map((d) => d.id)).toEqual(['d1'])
    expect(bList.map((d) => d.id)).toEqual(['d2'])
    expect(bList.some((d) => d.id === 'd1')).toBe(false)
  })

  it('user B cannot UPDATE a dashboard owned by org A (rejected, original untouched)', async () => {
    await dashboardRepository.upsert(userA, dashboardDraft('d1', 'original'))

    const result = await dashboardRepository.upsert(userB, dashboardDraft('d1', 'hijacked'))
    expect(result).toBeNull() // cross-org write rejected

    // The record is unchanged and still owned by org A.
    const stillA = await dashboardRepository.get(userA, 'd1')
    expect(stillA).not.toBeNull()
    expect(stillA!.name).toBe('original')
    expect(stillA!.orgId).toBe('org-A')
    expect(stillA!.owner).toBe('user-a')
  })

  it('user B cannot DELETE a dashboard owned by org A', async () => {
    await dashboardRepository.upsert(userA, dashboardDraft('d1', 'A dashboard'))

    const deleted = await dashboardRepository.delete(userB, 'd1')
    expect(deleted).toBe(false) // no-op across orgs

    // Still there for its real owner.
    expect(await dashboardRepository.get(userA, 'd1')).not.toBeNull()
  })

  it('owner is preserved (not reassigned) when the true owner updates', async () => {
    await dashboardRepository.upsert(userA, dashboardDraft('d1', 'v1'))
    const updated = await dashboardRepository.upsert(userA, dashboardDraft('d1', 'v2'))
    expect(updated).not.toBeNull()
    expect(updated!.name).toBe('v2')
    expect(updated!.owner).toBe('user-a')
    expect(updated!.orgId).toBe('org-A')
  })
})

describe('repository org isolation (B2 IDOR) — charts', () => {
  it('user B cannot get/list/update/delete a chart owned by org A', async () => {
    await chartRepository.upsert(userA, chartDraft('c1', 'A chart'))

    // get
    expect(await chartRepository.get(userB, 'c1')).toBeNull()
    // list
    expect((await chartRepository.list(userB)).some((c) => c.id === 'c1')).toBe(false)
    // update
    expect(await chartRepository.upsert(userB, chartDraft('c1', 'hijacked'))).toBeNull()
    const stillA = await chartRepository.get(userA, 'c1')
    expect(stillA!.title).toBe('A chart')
    // delete
    expect(await chartRepository.delete(userB, 'c1')).toBe(false)
    expect(await chartRepository.get(userA, 'c1')).not.toBeNull()
  })
})
