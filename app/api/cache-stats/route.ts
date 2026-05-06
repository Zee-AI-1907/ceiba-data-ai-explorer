import { NextResponse } from 'next/server'
import { sqlCache, chartCache } from '@/lib/cache'

export async function GET() {
  return NextResponse.json({
    sql: sqlCache.stats(),
    chart: chartCache.stats(),
  })
}
