'use client'

import { useState, useCallback, useEffect } from 'react'
import { useRouter } from 'next/navigation'
import DataNav from '@/components/DataNav'
import { DashboardCanvas } from '@/components/Dashboard/DashboardCanvas'
import { ChartLibraryPanel, type ChartLibraryItem } from '@/components/Dashboard/ChartLibraryPanel'
import { DashboardFilters } from '@/components/Dashboard/DashboardFilters'
import { saveCanvasDashboard, type CanvasWidget, type CanvasDashboard, type DashboardFilter, type WidgetSize } from '@/lib/dashboardStore'
import { ArrowLeft, Save, Globe, Eye, Pencil } from 'lucide-react'
import { clsx } from 'clsx'

// ─── Toast ────────────────────────────────────────────────────────────────────

function Toast({ message, onDone }: { message: string; onDone: () => void }) {
  useEffect(() => {
    const t = setTimeout(onDone, 2500)
    return () => clearTimeout(t)
  }, [onDone])

  return (
    <div className="fixed bottom-6 left-1/2 -translate-x-1/2 z-50 flex items-center gap-2 px-4 py-2.5 rounded-[10px] bg-[#4dcc88] text-[#0b0b0c] text-[13px] font-semibold shadow-[0_4px_24px_rgba(77,204,136,0.4)] animate-in fade-in slide-in-from-bottom-2">
      <span>✓</span>
      {message}
    </div>
  )
}

// ─── Page ─────────────────────────────────────────────────────────────────────

export default function NewDashboardPage() {
  const router = useRouter()

  const [name, setName]           = useState('Untitled Dashboard')
  const [editingName, setEditingName] = useState(false)
  const [nameInput, setNameInput] = useState('Untitled Dashboard')
  const [editMode, setEditMode]   = useState(true)
  const [widgets, setWidgets]     = useState<CanvasWidget[]>([])
  const [filters, setFilters]     = useState<DashboardFilter[]>([])
  const [toast, setToast]         = useState<string | null>(null)
  const [status, setStatus]       = useState<'Draft' | 'Published'>('Draft')

  // Track which chart IDs are already on canvas
  const addedIds = new Set(widgets.map((w) => w.chartId))

  const handleAddChart = useCallback((chart: ChartLibraryItem) => {
    const newWidget: CanvasWidget = {
      id:        `widget-${Date.now()}`,
      chartId:   chart.id,
      chartName: chart.name,
      chartType: chart.type,
      size:      'medium',
      order:     widgets.length,
    }
    setWidgets((prev) => [...prev, newWidget])
  }, [widgets.length])

  const handleRemove = (id: string) => {
    setWidgets((prev) => prev.filter((w) => w.id !== id).map((w, i) => ({ ...w, order: i })))
  }

  const handleMove = (id: string, direction: 'up' | 'down' | 'left' | 'right') => {
    setWidgets((prev) => {
      const sorted = [...prev].sort((a, b) => a.order - b.order)
      const idx = sorted.findIndex((w) => w.id === id)
      if (idx < 0) return prev
      const delta = (direction === 'up' || direction === 'left') ? -1 : 1
      const newIdx = Math.max(0, Math.min(sorted.length - 1, idx + delta))
      if (newIdx === idx) return prev
      // Swap
      const copy = [...sorted]
      const tmp = copy[idx]
      copy[idx] = copy[newIdx]
      copy[newIdx] = tmp
      return copy.map((w, i) => ({ ...w, order: i }))
    })
  }

  const handleSizeChange = (id: string, size: WidgetSize) => {
    setWidgets((prev) => prev.map((w) => w.id === id ? { ...w, size } : w))
  }

  const handleSave = () => {
    const id = `cdash-${Date.now()}`
    const dashboard: CanvasDashboard = {
      id,
      name,
      status,
      widgets,
      filters,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    }
    saveCanvasDashboard(dashboard)
    setToast('Dashboard saved!')
    setTimeout(() => router.push(`/dashboards/${id}`), 1200)
  }

  const handlePublish = () => {
    setStatus('Published')
    setToast('Dashboard published!')
  }

  const commitName = () => {
    if (nameInput.trim()) setName(nameInput.trim())
    else setNameInput(name)
    setEditingName(false)
  }

  return (
    <div className="min-h-screen bg-[#0d0d10] text-[#e8e8ea] flex flex-col">
      <DataNav activePage="dashboards" />

      {/* ── Top bar ──────────────────────────────────────────────── */}
      <div className="flex items-center justify-between px-4 py-3 border-b border-[#1f1f25] bg-[#0d0d10] flex-shrink-0">
        <div className="flex items-center gap-3 min-w-0">
          <button
            onClick={() => router.push('/dashboards')}
            className="w-7 h-7 flex items-center justify-center rounded-[7px] text-[#6c6c74] hover:text-[#a0a0a7] hover:bg-[#16161a] transition-colors flex-shrink-0"
          >
            <ArrowLeft size={14} />
          </button>

          {/* Editable title */}
          {editingName ? (
            <input
              autoFocus
              value={nameInput}
              onChange={(e) => setNameInput(e.target.value)}
              onBlur={commitName}
              onKeyDown={(e) => { if (e.key === 'Enter') commitName(); if (e.key === 'Escape') { setNameInput(name); setEditingName(false) } }}
              className="text-[15px] font-semibold bg-transparent border-b border-[#7c68ff] outline-none text-[#e8e8ea] min-w-[200px]"
            />
          ) : (
            <button
              onClick={() => setEditingName(true)}
              className="flex items-center gap-1.5 group"
            >
              <span className="text-[15px] font-semibold text-[#e8e8ea]">{name}</span>
              <Pencil size={11} className="text-[#44444b] group-hover:text-[#7c68ff] transition-colors" />
            </button>
          )}

          <span className={clsx(
            'px-2 py-0.5 rounded-full text-[9px] font-semibold',
            status === 'Published'
              ? 'bg-[#4dcc8820] text-[#4dcc88] border border-[#4dcc8840]'
              : 'bg-[#6c6c7420] text-[#6c6c74] border border-[#6c6c7440]',
          )}>
            {status}
          </span>
        </div>

        <div className="flex items-center gap-2 flex-shrink-0">
          {/* Edit / View toggle */}
          <div className="flex items-center bg-[#16161a] border border-[#2a2a31] rounded-[8px] p-0.5">
            <button
              onClick={() => setEditMode(true)}
              className={clsx('flex items-center gap-1 px-2.5 py-1 rounded-[6px] text-[11px] font-medium transition-all',
                editMode ? 'bg-[#7c68ff] text-white' : 'text-[#6c6c74] hover:text-[#a0a0a7]')}
            >
              <Pencil size={10} /> Edit
            </button>
            <button
              onClick={() => setEditMode(false)}
              className={clsx('flex items-center gap-1 px-2.5 py-1 rounded-[6px] text-[11px] font-medium transition-all',
                !editMode ? 'bg-[#7c68ff] text-white' : 'text-[#6c6c74] hover:text-[#a0a0a7]')}
            >
              <Eye size={10} /> View
            </button>
          </div>

          <button
            onClick={handlePublish}
            className="flex items-center gap-1.5 px-3 py-1.5 text-[12px] font-semibold rounded-[8px] border border-[#2a2a31] text-[#a0a0a7] hover:bg-[#16161a] hover:text-[#e8e8ea] transition-all"
          >
            <Globe size={12} />
            Publish
          </button>

          <button
            onClick={handleSave}
            className="flex items-center gap-1.5 px-3 py-1.5 text-[12px] font-semibold text-white rounded-[8px] bg-[#7c68ff] hover:bg-[#9080ff] shadow-[0_2px_10px_rgba(124,104,255,0.3)] transition-all"
          >
            <Save size={12} />
            Save
          </button>
        </div>
      </div>

      {/* ── Filters bar ──────────────────────────────────────────── */}
      <DashboardFilters
        filters={filters}
        editMode={editMode}
        onFiltersChange={setFilters}
      />

      {/* ── Body: sidebar + canvas ────────────────────────────────── */}
      <div className="flex flex-1 overflow-hidden">
        {editMode && (
          <ChartLibraryPanel
            onAddChart={handleAddChart}
            addedIds={addedIds}
          />
        )}

        <DashboardCanvas
          widgets={widgets}
          editMode={editMode}
          onRemove={handleRemove}
          onMove={handleMove}
          onSizeChange={handleSizeChange}
        />
      </div>

      {/* Toast */}
      {toast && <Toast message={toast} onDone={() => setToast(null)} />}
    </div>
  )
}
