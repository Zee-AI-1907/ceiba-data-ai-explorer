import type { ChartConfig } from '@/components/DataExplorer/ChartPreview'

export type SavedChart = {
  id: string
  title: string
  description?: string
  config: ChartConfig
  data: Record<string, unknown>[]
  createdAt: string
  queryName?: string
}

export type Dashboard = {
  id: string
  name: string
  status: 'Draft' | 'Published'
  charts: SavedChart[]
  createdAt: string
  updatedAt: string
  owner: string
}

const CHARTS_KEY = 'ceiba_saved_charts'
const DASHBOARDS_KEY = 'ceiba_dashboards'

export function getSavedCharts(): SavedChart[] {
  if (typeof window === 'undefined') return []
  try {
    return JSON.parse(localStorage.getItem(CHARTS_KEY) || '[]')
  } catch {
    return []
  }
}

export function saveChart(chart: SavedChart): void {
  const charts = getSavedCharts()
  const existing = charts.findIndex((c) => c.id === chart.id)
  if (existing >= 0) charts[existing] = chart
  else charts.unshift(chart)
  localStorage.setItem(CHARTS_KEY, JSON.stringify(charts))
}

export function getDashboards(): Dashboard[] {
  if (typeof window === 'undefined') return []
  try {
    return JSON.parse(localStorage.getItem(DASHBOARDS_KEY) || '[]')
  } catch {
    return []
  }
}

export function saveDashboard(dashboard: Dashboard): void {
  const dashboards = getDashboards()
  const existing = dashboards.findIndex((d) => d.id === dashboard.id)
  if (existing >= 0) dashboards[existing] = dashboard
  else dashboards.unshift(dashboard)
  localStorage.setItem(DASHBOARDS_KEY, JSON.stringify(dashboards))
}

export function deleteDashboard(id: string): void {
  const dashboards = getDashboards().filter((d) => d.id !== id)
  localStorage.setItem(DASHBOARDS_KEY, JSON.stringify(dashboards))
}

// API-backed functions (use these in components)
export async function fetchDashboards(): Promise<Dashboard[]> {
  try {
    const res = await fetch('/api/dashboards')
    return res.ok ? res.json() : []
  } catch { return [] }
}

export async function fetchDashboard(id: string): Promise<Dashboard | null> {
  try {
    const res = await fetch(`/api/dashboards?id=${id}`)
    return res.ok ? res.json() : null
  } catch { return null }
}

export async function persistDashboard(dashboard: Dashboard): Promise<void> {
  saveDashboard(dashboard) // keep localStorage for instant UI
  await fetch('/api/dashboards', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(dashboard),
  }).catch(() => {}) // fire-and-forget, localStorage is the source of truth
}

export async function persistChart(chart: SavedChart): Promise<void> {
  saveChart(chart) // keep localStorage for instant UI
  await fetch('/api/dashboards?type=chart', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(chart),
  }).catch(() => {})
}
