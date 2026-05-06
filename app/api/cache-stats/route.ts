import { NextRequest, NextResponse } from 'next/server'
import { sqlCache, chartCache } from '@/lib/cache'
import { requireAuth } from '@/lib/apiAuth'

export async function GET(req: NextRequest) {
  const { error } = await requireAuth(req)
  if (error) return error

  return NextResponse.json({
    sql: sqlCache.stats(),
    chart: chartCache.stats(),
  })
}
