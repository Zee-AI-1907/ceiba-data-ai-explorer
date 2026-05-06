export type SavedChart = {
  id: string
  title: string
  type: 'bar' | 'line' | 'area' | 'pie' | 'bigNumber' | 'table'
  dataset: string
  metrics: string[]
  dimensions: string[]
  createdAt: string
  modifiedAt: string
}

const STORAGE_KEY = 'ceiba_charts'

export function getCharts(): SavedChart[] {
  if (typeof window === 'undefined') return []
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    return raw ? (JSON.parse(raw) as SavedChart[]) : []
  } catch {
    return []
  }
}

export function saveChart(chart: Omit<SavedChart, 'id' | 'createdAt' | 'modifiedAt'>): SavedChart {
  const charts = getCharts()
  const now = new Date().toISOString()
  const newChart: SavedChart = {
    ...chart,
    id: `chart_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    createdAt: now,
    modifiedAt: now,
  }
  charts.unshift(newChart)
  localStorage.setItem(STORAGE_KEY, JSON.stringify(charts))
  return newChart
}

export function deleteChart(id: string): void {
  const charts = getCharts().filter((c) => c.id !== id)
  localStorage.setItem(STORAGE_KEY, JSON.stringify(charts))
}
