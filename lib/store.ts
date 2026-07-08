/**
 * store.ts — Client-side dashboard/chart persistence.
 *
 * SOURCE OF TRUTH IS THE SERVER (AR4). persistDashboard/persistChart now AWAIT
 * the server write and return the server's canonical record. localStorage is a
 * render cache written THROUGH only AFTER the server confirms — it is no longer
 * authoritative. (Old behaviour: fire-and-forget POST, localStorage treated as
 * the source of truth. That is what made server org-scoping impossible.)
 *
 * Types are the canonical ones from lib/domain.ts. For backward compatibility the
 * historical names `Dashboard` and `SavedChart` are preserved here as the
 * client-facing INPUT aliases (server-stamped orgId/owner/updatedAt are optional
 * on the client; the server stamps them on write).
 *
 * TODO (read-path refetch): fetchDashboards/fetchDashboard currently merge server
 * data with the localStorage cache in the calling pages. Once WS-G lands the
 * server store, the pages should drop the localStorage seed and refetch on focus
 * so the server is the *only* read source. Tracked as a follow-up; the write path
 * is already server-authoritative.
 */

import type {
  Chart,
  Dashboard as CanonicalDashboard,
  ChartInput,
  DashboardInput,
} from '@/lib/domain'

// Backward-compatible public names. These are the client-facing INPUT shapes.
export type SavedChart = ChartInput
export type Dashboard = DashboardInput

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

/**
 * Persist a dashboard. Server is authoritative: we AWAIT the POST, and only if it
 * succeeds do we write the server's returned record through to the localStorage
 * render cache. On failure we throw so callers can surface the error rather than
 * silently diverging from the server.
 */
export async function persistDashboard(dashboard: Dashboard): Promise<CanonicalDashboard> {
  const res = await fetch('/api/dashboards', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(dashboard),
  })
  if (!res.ok) {
    throw new Error(`Failed to save dashboard (${res.status})`)
  }
  const saved: CanonicalDashboard = await res.json()
  // Write-through cache only AFTER the server confirms.
  saveDashboard(saved)
  return saved
}

/**
 * Persist a chart. Same server-authoritative contract as persistDashboard.
 */
export async function persistChart(chart: SavedChart): Promise<Chart> {
  const res = await fetch('/api/dashboards?type=chart', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(chart),
  })
  if (!res.ok) {
    throw new Error(`Failed to save chart (${res.status})`)
  }
  const saved: Chart = await res.json()
  saveChart(saved)
  return saved
}
