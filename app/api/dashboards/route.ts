import { NextRequest, NextResponse } from 'next/server'
import { requireOrg, requireAuthWithPermission } from '@/lib/apiAuth'
import { dashboardRepository, chartRepository } from '@/lib/repository'
import type { ChartInput, DashboardInput } from '@/lib/domain'

/**
 * /api/dashboards — dashboards + charts, org+owner scoped via the repository
 * (AR2/B2/H2). All scoping/stamping lives in lib/repository.ts; this handler only
 * authenticates, authorises, and delegates.
 *
 * GET    /api/dashboards            → list dashboards in caller's org
 * GET    /api/dashboards?id=xxx     → single dashboard (404 if not in caller's org)
 * GET    /api/dashboards?charts=true → list charts in caller's org
 * POST   /api/dashboards            → upsert dashboard (dashboard:write)
 * POST   /api/dashboards?type=chart → upsert chart (chart:write)
 * DELETE /api/dashboards?id=xxx     → delete dashboard/chart in caller's org
 */

export async function GET(req: NextRequest) {
  const { session, error } = await requireOrg(req)
  if (error) return error

  const { searchParams } = new URL(req.url)
  const id = searchParams.get('id')
  const charts = searchParams.get('charts')

  if (charts === 'true') {
    const rows = await chartRepository.list(session)
    return NextResponse.json(rows)
  }

  if (id) {
    const dashboard = await dashboardRepository.get(session, id)
    if (!dashboard) return NextResponse.json({ error: 'Not found' }, { status: 404 })
    return NextResponse.json(dashboard)
  }

  const dashboards = await dashboardRepository.list(session)
  return NextResponse.json(dashboards)
}

export async function POST(req: NextRequest) {
  const { searchParams } = new URL(req.url)
  const type = searchParams.get('type') || 'dashboard'

  // Permission-gate per entity kind (H2).
  const permission = type === 'chart' ? 'chart:write' : 'dashboard:write'
  const { session, error } = await requireAuthWithPermission(req, permission)
  if (error) return error

  // Universal body guard (N5): malformed JSON → 400, never a 500.
  let body: unknown
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: 'Invalid request body' }, { status: 400 })
  }
  if (!body || typeof body !== 'object') {
    return NextResponse.json({ error: 'Invalid request body' }, { status: 400 })
  }

  if (type === 'chart') {
    // Server derives orgId/owner — any client-supplied values are ignored by the repo.
    const saved = await chartRepository.upsert(session, body as ChartInput)
    if (!saved) {
      // Cross-org write attempt (B2) — do not confirm the record exists elsewhere.
      return NextResponse.json({ error: 'Not found' }, { status: 404 })
    }
    return NextResponse.json(saved)
  }

  const saved = await dashboardRepository.upsert(session, body as DashboardInput)
  if (!saved) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 })
  }
  return NextResponse.json(saved)
}

export async function DELETE(req: NextRequest) {
  const { searchParams } = new URL(req.url)
  const type = searchParams.get('type') || 'dashboard'

  const permission = type === 'chart' ? 'chart:write' : 'dashboard:write'
  const { session, error } = await requireAuthWithPermission(req, permission)
  if (error) return error

  const id = searchParams.get('id')
  if (!id) {
    return NextResponse.json({ error: 'id is required' }, { status: 400 })
  }

  const removed =
    type === 'chart'
      ? await chartRepository.delete(session, id)
      : await dashboardRepository.delete(session, id)

  return NextResponse.json({ ok: removed })
}
