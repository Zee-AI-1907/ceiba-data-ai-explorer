import { NextRequest, NextResponse } from 'next/server'
import { sqlCache, chartCache } from '@/lib/cache'
import { requireAuthWithPermission } from '@/lib/apiAuth'

// GET /api/cache-stats — internal cache sizes for the SQL + chart LLM caches.
// §6a / P3-1: this exposes internals (cache shape/size) and MUST be admin-only.
// Previously used `requireAuth`, so ANY authenticated user could read it.
export async function GET(req: NextRequest) {
  const { error } = await requireAuthWithPermission(req, 'admin:manage')
  if (error) return error

  return NextResponse.json({
    sql: sqlCache.stats(),
    chart: chartCache.stats(),
  })
}
