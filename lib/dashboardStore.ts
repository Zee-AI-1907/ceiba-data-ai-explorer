// Canvas Dashboard Store — localStorage-backed persistence

export type WidgetSize = 'small' | 'medium' | 'large'

export type CanvasWidget = {
  id: string
  chartId: string
  chartName: string
  chartType: string
  size: WidgetSize
  order: number
}

export type DashboardFilter = {
  id: string
  column: string
  value?: string
}

export type CanvasDashboard = {
  id: string
  name: string
  status: 'Draft' | 'Published'
  widgets: CanvasWidget[]
  filters: DashboardFilter[]
  createdAt: string
  updatedAt: string
}

const CANVAS_DASHBOARDS_KEY = 'ceiba_canvas_dashboards'

export function getCanvasDashboards(): CanvasDashboard[] {
  if (typeof window === 'undefined') return []
  try {
    return JSON.parse(localStorage.getItem(CANVAS_DASHBOARDS_KEY) || '[]')
  } catch {
    return []
  }
}

export function getCanvasDashboard(id: string): CanvasDashboard | null {
  return getCanvasDashboards().find((d) => d.id === id) ?? null
}

export function saveCanvasDashboard(dashboard: CanvasDashboard): void {
  const dashboards = getCanvasDashboards()
  const existing = dashboards.findIndex((d) => d.id === dashboard.id)
  if (existing >= 0) dashboards[existing] = dashboard
  else dashboards.unshift(dashboard)
  localStorage.setItem(CANVAS_DASHBOARDS_KEY, JSON.stringify(dashboards))
}

export function deleteCanvasDashboard(id: string): void {
  const dashboards = getCanvasDashboards().filter((d) => d.id !== id)
  localStorage.setItem(CANVAS_DASHBOARDS_KEY, JSON.stringify(dashboards))
}
