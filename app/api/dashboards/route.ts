import { NextRequest, NextResponse } from 'next/server'
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs'
import { join } from 'path'

const DATA_DIR = join(process.cwd(), '.data')
const DASHBOARDS_FILE = join(DATA_DIR, 'dashboards.json')
const CHARTS_FILE = join(DATA_DIR, 'charts.json')

function ensureDataDir() {
  if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true })
}

function readFile<T>(path: string, fallback: T): T {
  try {
    if (!existsSync(path)) return fallback
    return JSON.parse(readFileSync(path, 'utf-8'))
  } catch { return fallback }
}

function writeFile(path: string, data: unknown): void {
  ensureDataDir()
  writeFileSync(path, JSON.stringify(data, null, 2))
}

// GET /api/dashboards — list all dashboards
// GET /api/dashboards?id=xxx — get single dashboard
// POST /api/dashboards — create/update dashboard
// DELETE /api/dashboards?id=xxx — delete dashboard
// GET /api/dashboards?charts=true — list saved charts

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url)
  const id = searchParams.get('id')
  const charts = searchParams.get('charts')

  if (charts === 'true') {
    return NextResponse.json(readFile(CHARTS_FILE, []))
  }

  const dashboards = readFile(DASHBOARDS_FILE, [])
  if (id) {
    const dashboard = (dashboards as { id: string }[]).find((d) => d.id === id)
    if (!dashboard) return NextResponse.json({ error: 'Not found' }, { status: 404 })
    return NextResponse.json(dashboard)
  }
  return NextResponse.json(dashboards)
}

export async function POST(req: NextRequest) {
  const { searchParams } = new URL(req.url)
  const type = searchParams.get('type') || 'dashboard'
  const body = await req.json()

  if (type === 'chart') {
    const charts = readFile<unknown[]>(CHARTS_FILE, [])
    const idx = charts.findIndex((c: unknown) => (c as { id: string }).id === body.id)
    if (idx >= 0) charts[idx] = body
    else charts.unshift(body)
    writeFile(CHARTS_FILE, charts)
    return NextResponse.json({ ok: true })
  }

  // Dashboard
  const dashboards = readFile<unknown[]>(DASHBOARDS_FILE, [])
  const idx = dashboards.findIndex((d: unknown) => (d as { id: string }).id === body.id)
  if (idx >= 0) dashboards[idx] = { ...dashboards[idx] as object, ...body, updatedAt: new Date().toISOString() }
  else dashboards.unshift({ ...body, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() })
  writeFile(DASHBOARDS_FILE, dashboards)
  return NextResponse.json({ ok: true })
}

export async function DELETE(req: NextRequest) {
  const { searchParams } = new URL(req.url)
  const id = searchParams.get('id')
  const type = searchParams.get('type') || 'dashboard'

  if (type === 'chart') {
    const charts = readFile<unknown[]>(CHARTS_FILE, []).filter((c: unknown) => (c as { id: string }).id !== id)
    writeFile(CHARTS_FILE, charts)
  } else {
    const dashboards = readFile<unknown[]>(DASHBOARDS_FILE, []).filter((d: unknown) => (d as { id: string }).id !== id)
    writeFile(DASHBOARDS_FILE, dashboards)
  }
  return NextResponse.json({ ok: true })
}
