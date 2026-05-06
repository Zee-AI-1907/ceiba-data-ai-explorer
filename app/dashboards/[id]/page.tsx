'use client'

import { useState, useEffect, useCallback } from 'react'
import { useParams, useRouter } from 'next/navigation'
import DataNav from '@/components/DataNav'
import { ChartPreview } from '@/components/DataExplorer/ChartPreview'
import { DashboardCanvas } from '@/components/Dashboard/DashboardCanvas'
import { ChartLibraryPanel, type ChartLibraryItem } from '@/components/Dashboard/ChartLibraryPanel'
import { DashboardFilters } from '@/components/Dashboard/DashboardFilters'
import {
  getDashboards, saveDashboard, fetchDashboard, persistDashboard,
  type Dashboard, type SavedChart,
} from '@/lib/store'
import {
  getCanvasDashboard, saveCanvasDashboard,
  type CanvasDashboard, type CanvasWidget, type DashboardFilter, type WidgetSize,
} from '@/lib/dashboardStore'
import { ArrowLeft, MoreHorizontal, Trash2, Plus, Save, Globe, Eye, Pencil, MessageCircle } from 'lucide-react'
import { clsx } from 'clsx'
import { CommentButton } from '@/components/Comments/CommentButton'
import { CommentThread } from '@/components/Comments/CommentThread'

// ─── Toast ────────────────────────────────────────────────────────────────────

function Toast({ message, onDone }: { message: string; onDone: () => void }) {
  useEffect(() => {
    const t = setTimeout(onDone, 2500)
    return () => clearTimeout(t)
  }, [onDone])

  return (
    <div className="fixed bottom-6 left-1/2 -translate-x-1/2 z-50 flex items-center gap-2 px-4 py-2.5 rounded-[10px] bg-[#4dcc88] text-[#0b0b0c] text-[13px] font-semibold shadow-[0_4px_24px_rgba(77,204,136,0.4)]">
      <span>✓</span>
      {message}
    </div>
  )
}

// ─── Legacy chart card (for old-style dashboards) ─────────────────────────────

function StatusBadge({ status }: { status: string }) {
  return status === 'Published' ? (
    <span className="px-2 py-0.5 rounded-full text-[10px] font-semibold bg-[#4dcc8820] text-[#4dcc88] border border-[#4dcc8840]">Published</span>
  ) : (
    <span className="px-2 py-0.5 rounded-full text-[10px] font-semibold bg-[#6c6c7420] text-[#6c6c74] border border-[#6c6c7440]">Draft</span>
  )
}

function ChartCard({ chart, onRemove }: { chart: SavedChart; onRemove: () => void }) {
  const [showMenu, setShowMenu] = useState(false)
  return (
    <div className="bg-[#16161a] border border-[#2a2a31] rounded-[12px] p-4 flex flex-col gap-3">
      <div className="flex items-start justify-between gap-2">
        <div>
          <p className="text-[13px] font-semibold text-[#e8e8ea] leading-tight">{chart.title}</p>
          {chart.description && <p className="text-[11px] text-[#6c6c74] mt-0.5">{chart.description}</p>}
        </div>
        <div className="relative flex-shrink-0">
          <button
            onClick={() => setShowMenu((v) => !v)}
            className="w-6 h-6 flex items-center justify-center rounded-[6px] text-[#6c6c74] hover:text-[#a0a0a7] hover:bg-[#1f1f25] transition-colors"
          >
            <MoreHorizontal size={13} />
          </button>
          {showMenu && (
            <div className="absolute right-0 top-7 z-10 bg-[#1b1b20] border border-[#2a2a31] rounded-[8px] shadow-xl overflow-hidden min-w-[140px]">
              <button
                onClick={() => { onRemove(); setShowMenu(false) }}
                className="flex items-center gap-2 w-full px-3 py-2 text-[12px] text-[#ff5c6c] hover:bg-[#ff5c6c10] transition-colors"
              >
                <Trash2 size={12} />
                Remove from dashboard
              </button>
            </div>
          )}
        </div>
      </div>
      <div style={{ height: 280 }} className="w-full">
        <ChartPreview config={chart.config} data={chart.data} />
      </div>
      {chart.queryName && (
        <p className="text-[10px] text-[#44444b] border-t border-[#1f1f25] pt-2">Source: {chart.queryName}</p>
      )}
    </div>
  )
}

// ─── Canvas dashboard view/edit ───────────────────────────────────────────────

function CanvasDashboardView({ id }: { id: string }) {
  const router = useRouter()
  const [dashboard, setDashboard]         = useState<CanvasDashboard | null>(null)
  const [loading, setLoading]             = useState(true)
  const [editMode, setEditMode]           = useState(false)
  const [editingName, setEditingName]     = useState(false)
  const [nameInput, setNameInput]         = useState('')
  const [toast, setToast]                 = useState<string | null>(null)
  const [commentsOpen, setCommentsOpen]   = useState(false)

  useEffect(() => {
    const d = getCanvasDashboard(id)
    setDashboard(d)
    setNameInput(d?.name ?? '')
    setLoading(false)
  }, [id])

  const addedIds = new Set(dashboard?.widgets.map((w) => w.chartId) ?? [])

  const handleAddChart = useCallback((chart: ChartLibraryItem) => {
    setDashboard((prev) => {
      if (!prev) return prev
      const newWidget: CanvasWidget = {
        id:        `widget-${Date.now()}`,
        chartId:   chart.id,
        chartName: chart.name,
        chartType: chart.type,
        size:      'medium',
        order:     prev.widgets.length,
      }
      return { ...prev, widgets: [...prev.widgets, newWidget] }
    })
  }, [])

  const handleRemove = (widgetId: string) => {
    setDashboard((prev) => {
      if (!prev) return prev
      return {
        ...prev,
        widgets: prev.widgets.filter((w) => w.id !== widgetId).map((w, i) => ({ ...w, order: i })),
      }
    })
  }

  const handleMove = (widgetId: string, direction: 'up' | 'down' | 'left' | 'right') => {
    setDashboard((prev) => {
      if (!prev) return prev
      const sorted = [...prev.widgets].sort((a, b) => a.order - b.order)
      const idx = sorted.findIndex((w) => w.id === widgetId)
      if (idx < 0) return prev
      const delta = (direction === 'up' || direction === 'left') ? -1 : 1
      const newIdx = Math.max(0, Math.min(sorted.length - 1, idx + delta))
      if (newIdx === idx) return prev
      const copy = [...sorted]
      const tmp = copy[idx]; copy[idx] = copy[newIdx]; copy[newIdx] = tmp
      return { ...prev, widgets: copy.map((w, i) => ({ ...w, order: i })) }
    })
  }

  const handleSizeChange = (widgetId: string, size: WidgetSize) => {
    setDashboard((prev) => {
      if (!prev) return prev
      return { ...prev, widgets: prev.widgets.map((w) => w.id === widgetId ? { ...w, size } : w) }
    })
  }

  const handleFiltersChange = (filters: DashboardFilter[]) => {
    setDashboard((prev) => prev ? { ...prev, filters } : prev)
  }

  const handleSave = () => {
    if (!dashboard) return
    const updated = { ...dashboard, updatedAt: new Date().toISOString() }
    saveCanvasDashboard(updated)
    setDashboard(updated)
    setToast('Dashboard saved!')
  }

  const handlePublish = () => {
    setDashboard((prev) => {
      if (!prev) return prev
      const updated = { ...prev, status: 'Published' as const, updatedAt: new Date().toISOString() }
      saveCanvasDashboard(updated)
      return updated
    })
    setToast('Dashboard published!')
  }

  const commitName = () => {
    const trimmed = nameInput.trim()
    if (trimmed && dashboard) setDashboard({ ...dashboard, name: trimmed })
    else setNameInput(dashboard?.name ?? '')
    setEditingName(false)
  }

  if (loading) {
    return (
      <div className="flex-1 flex items-center justify-center">
        <div className="flex gap-1">
          {[0,1,2].map((i) => (
            <div key={i} className="w-2 h-2 rounded-full bg-[#7c68ff] animate-bounce" style={{ animationDelay: `${i * 0.15}s` }} />
          ))}
        </div>
      </div>
    )
  }

  if (!dashboard) return null // caller handles 404

  return (
    <>
      {/* Top bar */}
      <div className="flex items-center justify-between px-4 py-3 border-b border-[#1f1f25] flex-shrink-0">
        <div className="flex items-center gap-3 min-w-0">
          <button onClick={() => router.push('/dashboards')} className="w-7 h-7 flex items-center justify-center rounded-[7px] text-[#6c6c74] hover:text-[#a0a0a7] hover:bg-[#16161a] transition-colors flex-shrink-0">
            <ArrowLeft size={14} />
          </button>
          {editingName ? (
            <input autoFocus value={nameInput} onChange={(e) => setNameInput(e.target.value)}
              onBlur={commitName}
              onKeyDown={(e) => { if (e.key === 'Enter') commitName(); if (e.key === 'Escape') { setNameInput(dashboard.name); setEditingName(false) } }}
              className="text-[15px] font-semibold bg-transparent border-b border-[#7c68ff] outline-none text-[#e8e8ea] min-w-[200px]"
            />
          ) : (
            <button onClick={() => editMode && setEditingName(true)} className={clsx('flex items-center gap-1.5', editMode && 'group')}>
              <span className="text-[15px] font-semibold text-[#e8e8ea]">{dashboard.name}</span>
              {editMode && <Pencil size={11} className="text-[#44444b] group-hover:text-[#7c68ff] transition-colors" />}
            </button>
          )}
          <StatusBadge status={dashboard.status} />
        </div>
        <div className="flex items-center gap-2 flex-shrink-0">
          <div className="flex items-center bg-[#16161a] border border-[#2a2a31] rounded-[8px] p-0.5">
            <button onClick={() => setEditMode(true)} className={clsx('flex items-center gap-1 px-2.5 py-1 rounded-[6px] text-[11px] font-medium transition-all', editMode ? 'bg-[#7c68ff] text-white' : 'text-[#6c6c74] hover:text-[#a0a0a7]')}>
              <Pencil size={10} /> Edit
            </button>
            <button onClick={() => setEditMode(false)} className={clsx('flex items-center gap-1 px-2.5 py-1 rounded-[6px] text-[11px] font-medium transition-all', !editMode ? 'bg-[#7c68ff] text-white' : 'text-[#6c6c74] hover:text-[#a0a0a7]')}>
              <Eye size={10} /> View
            </button>
          </div>
          <CommentButton
            resourceType="dashboard"
            resourceId={id}
            isOpen={commentsOpen}
            onClick={() => setCommentsOpen((v) => !v)}
            className="px-3 py-1.5 border border-[#2a2a31] text-[12px]"
          />
          <button onClick={handlePublish} className="flex items-center gap-1.5 px-3 py-1.5 text-[12px] font-semibold rounded-[8px] border border-[#2a2a31] text-[#a0a0a7] hover:bg-[#16161a] hover:text-[#e8e8ea] transition-all">
            <Globe size={12} /> Publish
          </button>
          <button onClick={handleSave} className="flex items-center gap-1.5 px-3 py-1.5 text-[12px] font-semibold text-white rounded-[8px] bg-[#7c68ff] hover:bg-[#9080ff] shadow-[0_2px_10px_rgba(124,104,255,0.3)] transition-all">
            <Save size={12} /> Save
          </button>
        </div>
      </div>

      {/* Filters */}
      <DashboardFilters filters={dashboard.filters} editMode={editMode} onFiltersChange={handleFiltersChange} />

      {/* Body */}
      <div className="flex flex-1 overflow-hidden">
        {editMode && (
          <ChartLibraryPanel onAddChart={handleAddChart} addedIds={addedIds} />
        )}
        <DashboardCanvas
          widgets={dashboard.widgets}
          editMode={editMode}
          onRemove={handleRemove}
          onMove={handleMove}
          onSizeChange={handleSizeChange}
        />
      </div>

      {/* Dashboard comments slide-over */}
      {commentsOpen && (
        <>
          {/* Backdrop */}
          <div
            className="fixed inset-0 z-40"
            onClick={() => setCommentsOpen(false)}
          />
          {/* Panel */}
          <div
            className="fixed right-0 top-0 h-full w-[360px] z-50 bg-[#0d0d10] border-l border-[#2a2a31] shadow-[−4px_0_32px_rgba(0,0,0,0.6)] flex flex-col"
            style={{ transform: 'translateX(0)', transition: 'transform 0.2s ease' }}
          >
            <CommentThread
              resourceType="dashboard"
              resourceId={id}
              resourceLabel={dashboard?.name ?? id}
              onClose={() => setCommentsOpen(false)}
              mode="slideover"
            />
          </div>
        </>
      )}

      {toast && <Toast message={toast} onDone={() => setToast(null)} />}
    </>
  )
}

// ─── Main page ────────────────────────────────────────────────────────────────

export default function DashboardDetailPage() {
  const params  = useParams()
  const router  = useRouter()
  const id      = params?.id as string

  const [dashboard, setDashboard]   = useState<Dashboard | null>(null)
  const [isCanvas, setIsCanvas]     = useState(false)
  const [loading, setLoading]       = useState(true)

  useEffect(() => {
    // Check canvas dashboards first
    const canvas = getCanvasDashboard(id)
    if (canvas) {
      setIsCanvas(true)
      setLoading(false)
      return
    }
    // Fall back to legacy store
    async function load() {
      const local = getDashboards().find((d) => d.id === id) ?? null
      if (local) { setDashboard(local); setLoading(false) }
      try {
        const remote = await fetchDashboard(id)
        if (remote) setDashboard((prev) => prev ?? remote)
        else if (!local) setDashboard(null)
      } catch { /* ignore */ }
      finally { setLoading(false) }
    }
    load()
  }, [id])

  const removeChart = (chartId: string) => {
    if (!dashboard) return
    const updated: Dashboard = {
      ...dashboard,
      charts: dashboard.charts.filter((c) => c.id !== chartId),
      updatedAt: new Date().toISOString(),
    }
    persistDashboard(updated)
    setDashboard(updated)
  }

  // ── Canvas route ──
  if (isCanvas) {
    return (
      <div className="min-h-screen bg-[#0d0d10] text-[#e8e8ea] flex flex-col">
        <DataNav activePage="dashboards" />
        <CanvasDashboardView id={id} />
      </div>
    )
  }

  // ── Loading ──
  if (loading) {
    return (
      <div className="min-h-screen bg-[#0b0b0c] flex items-center justify-center">
        <div className="flex gap-1">
          {[0,1,2].map((i) => (
            <div key={i} className="w-2 h-2 rounded-full bg-[#7c68ff] animate-bounce" style={{ animationDelay: `${i * 0.15}s` }} />
          ))}
        </div>
      </div>
    )
  }

  // ── 404 ──
  if (!dashboard) {
    return (
      <div className="min-h-screen bg-[#0b0b0c] text-[#e8e8ea] flex flex-col">
        <DataNav activePage="dashboards" />
        <div className="flex-1 flex flex-col items-center justify-center gap-4">
          <p className="text-[16px] font-semibold text-[#e8e8ea]">Dashboard not found</p>
          <p className="text-[12px] text-[#6c6c74]">This dashboard may have been deleted or doesn&apos;t exist.</p>
          <button onClick={() => router.push('/dashboards')} className="flex items-center gap-1.5 px-4 py-2 rounded-[8px] bg-[#7c68ff] text-white text-[13px] font-semibold hover:bg-[#9080ff] transition-all">
            <ArrowLeft size={13} /> Back to Dashboards
          </button>
        </div>
      </div>
    )
  }

  // ── Legacy dashboard ──
  return (
    <div className="min-h-screen bg-[#0b0b0c] text-[#e8e8ea] flex flex-col">
      <DataNav activePage="dashboards" />

      <div className="flex items-center justify-between px-6 py-4 border-b border-[#1f1f25]">
        <div className="flex items-center gap-3">
          <button onClick={() => router.push('/dashboards')} className="w-7 h-7 flex items-center justify-center rounded-[7px] text-[#6c6c74] hover:text-[#a0a0a7] hover:bg-[#16161a] transition-colors">
            <ArrowLeft size={14} />
          </button>
          <div className="flex items-center gap-2.5">
            <h1 className="text-[17px] font-semibold text-[#e8e8ea]">{dashboard.name}</h1>
            <StatusBadge status={dashboard.status} />
          </div>
        </div>
        <div className="flex items-center gap-2">
          <span className="text-[11px] text-[#44444b]">{dashboard.charts.length} chart{dashboard.charts.length !== 1 ? 's' : ''}</span>
          <button onClick={() => router.push('/data-explorer')} className="flex items-center gap-1.5 px-3 py-1.5 text-[12px] font-semibold text-white rounded-[8px] bg-[#7c68ff] hover:bg-[#9080ff] shadow-[0_2px_10px_rgba(124,104,255,0.3)] transition-all">
            <Plus size={13} /> Add Chart
          </button>
        </div>
      </div>

      <div className="flex-1 px-6 py-5">
        {dashboard.charts.length === 0 ? (
          <div className="flex flex-col items-center justify-center gap-4 py-20 text-center">
            <div className="w-14 h-14 rounded-2xl bg-[#16161a] border border-[#2a2a31] flex items-center justify-center">
              <Plus size={22} className="text-[#44444b]" />
            </div>
            <p className="text-[15px] font-semibold text-[#e8e8ea]">No charts yet</p>
            <p className="text-[12px] text-[#6c6c74] max-w-[280px]">Go to SQL Lab to create some and add them to this dashboard.</p>
            <button onClick={() => router.push('/data-explorer')} className="flex items-center gap-1.5 px-4 py-2 rounded-[8px] bg-[#7c68ff] text-white text-[13px] font-semibold hover:bg-[#9080ff] transition-all">
              Go to SQL Lab
            </button>
          </div>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
            {dashboard.charts.map((chart) => (
              <ChartCard key={chart.id} chart={chart} onRemove={() => removeChart(chart.id)} />
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
