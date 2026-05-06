'use client'

import { useState, useCallback, useEffect } from 'react'
import { useRouter } from 'next/navigation'
import Link from 'next/link'
import { ArrowLeft, Save, CheckCircle2, ChevronRight } from 'lucide-react'
import DataNav from '@/components/DataNav'
import DatasetPicker, { ColumnDef, ColumnRole } from '@/components/DataExplorer/ChartBuilder/DatasetPicker'
import ConfigPanel, { FilterDef } from '@/components/DataExplorer/ChartBuilder/ConfigPanel'
import ChartLivePreview from '@/components/DataExplorer/ChartBuilder/ChartLivePreview'
import { ChartType } from '@/components/DataExplorer/ChartBuilder/ChartTypeSelector'
import { saveChart } from '@/lib/chartStore'

export default function NewChartPage() {
  const router = useRouter()

  // Dataset & columns
  const [selectedDataset, setSelectedDataset] = useState<string | null>(null)
  const [columnRoles, setColumnRoles] = useState<Record<string, ColumnRole>>({})

  // Chart config
  const [chartType, setChartType] = useState<ChartType>('bar')
  const [title, setTitle] = useState('')
  const [filters, setFilters] = useState<FilterDef[]>([])

  // Toast
  const [toast, setToast] = useState<{ visible: boolean; message: string }>({ visible: false, message: '' })

  const metrics = Object.entries(columnRoles)
    .filter(([, role]) => role === 'metric')
    .map(([col]) => col)

  const dimensions = Object.entries(columnRoles)
    .filter(([, role]) => role === 'dimension')
    .map(([col]) => col)

  const handleToggleColumn = useCallback((col: ColumnDef) => {
    setColumnRoles((prev) => {
      const current = prev[col.name]
      if (!current) {
        // Assign based on type: numeric → metric, text/date → dimension
        const role: ColumnRole = col.type === 'numeric' ? 'metric' : 'dimension'
        return { ...prev, [col.name]: role }
      }
      if (current === 'metric') {
        return { ...prev, [col.name]: 'dimension' }
      }
      // dimension → remove
      const next = { ...prev }
      delete next[col.name]
      return next
    })
  }, [])

  const handleSelectDataset = useCallback((name: string) => {
    setSelectedDataset(name)
    setColumnRoles({})
  }, [])

  const handleAddFilter = useCallback(() => {
    const id = `f_${Date.now()}`
    setFilters((prev) => [...prev, { id, column: '', operator: '=', value: '' }])
  }, [])

  const handleRemoveFilter = useCallback((id: string) => {
    setFilters((prev) => prev.filter((f) => f.id !== id))
  }, [])

  const showToast = (message: string) => {
    setToast({ visible: true, message })
    setTimeout(() => setToast({ visible: false, message: '' }), 3000)
  }

  const handleSave = () => {
    if (!title.trim()) {
      showToast('Please enter a chart title')
      return
    }
    if (!selectedDataset) {
      showToast('Please select a dataset')
      return
    }

    saveChart({
      title: title.trim(),
      type: chartType,
      dataset: selectedDataset,
      metrics,
      dimensions,
    })

    showToast('Chart saved successfully!')
    setTimeout(() => router.push('/charts'), 1500)
  }

  return (
    <div className="min-h-screen bg-[#0b0b0c] text-[#e8e8ea] flex flex-col">
      <DataNav activePage="charts" />

      {/* Header */}
      <div className="flex items-center justify-between px-6 py-3.5 border-b border-[#1f1f25] flex-shrink-0">
        <div className="flex items-center gap-3">
          <Link
            href="/charts"
            className="flex items-center gap-1.5 text-[#6c6c74] hover:text-[#a0a0a7] transition-colors text-[12px]"
          >
            <ArrowLeft size={14} />
          </Link>
          {/* Breadcrumb */}
          <div className="flex items-center gap-1.5 text-[13px]">
            <Link href="/charts" className="text-[#4c8dff] hover:underline">Charts</Link>
            <ChevronRight size={13} className="text-[#44444b]" />
            <span className="text-[#a0a0a7]">New Chart</span>
          </div>
        </div>

        <div className="flex items-center gap-2">
          <Link
            href="/charts"
            className="px-3 py-1.5 text-[12px] font-medium text-[#a0a0a7] border border-[#2a2a31] rounded-[8px] hover:bg-[#16161a] hover:text-[#e8e8ea] transition-colors"
          >
            Cancel
          </Link>
          <button
            onClick={handleSave}
            className="flex items-center gap-1.5 px-4 py-1.5 text-[12px] font-semibold text-white rounded-[8px] bg-[#7c68ff] hover:bg-[#9080ff] shadow-[0_2px_10px_rgba(124,104,255,0.3)] transition-all"
          >
            <Save size={13} />
            Save Chart
          </button>
        </div>
      </div>

      {/* 3-column layout */}
      <div className="flex flex-1 overflow-hidden" style={{ height: 'calc(100vh - 110px)' }}>
        {/* Left: Dataset & Column Picker (~25%) */}
        <div className="w-[25%] min-w-[200px] border-r border-[#1f1f25] flex flex-col overflow-hidden">
          <DatasetPicker
            selectedDataset={selectedDataset}
            onSelectDataset={handleSelectDataset}
            columnRoles={columnRoles}
            onToggleColumn={handleToggleColumn}
          />
        </div>

        {/* Center: Config Panel (~30%) */}
        <div className="w-[30%] min-w-[240px] border-r border-[#1f1f25] flex flex-col overflow-hidden">
          <ConfigPanel
            chartType={chartType}
            onChartTypeChange={setChartType}
            title={title}
            onTitleChange={setTitle}
            metrics={metrics}
            dimensions={dimensions}
            onRemoveMetric={(col) =>
              setColumnRoles((prev) => { const n = { ...prev }; delete n[col]; return n })
            }
            onRemoveDimension={(col) =>
              setColumnRoles((prev) => { const n = { ...prev }; delete n[col]; return n })
            }
            filters={filters}
            onAddFilter={handleAddFilter}
            onRemoveFilter={handleRemoveFilter}
          />
        </div>

        {/* Right: Live Preview (~45%) */}
        <div className="flex-1 flex flex-col overflow-hidden bg-[#0d0d10]">
          <div className="px-5 py-3 border-b border-[#1f1f25] flex-shrink-0">
            <p className="text-[11px] font-semibold text-[#6c6c74] uppercase tracking-wider">Live Preview</p>
          </div>
          <div className="flex-1 overflow-hidden">
            <ChartLivePreview
              chartType={chartType}
              title={title}
              metrics={metrics}
              dimensions={dimensions}
            />
          </div>
        </div>
      </div>

      {/* Toast */}
      {toast.visible && (
        <div className="fixed bottom-6 left-1/2 -translate-x-1/2 z-50 flex items-center gap-2.5 px-4 py-3 rounded-[10px] bg-[#1b1b20] border border-[#3a3a45] shadow-2xl text-[13px] text-[#e8e8ea] animate-in fade-in slide-in-from-bottom-4">
          <CheckCircle2 size={16} className="text-[#4dcc88]" />
          {toast.message}
        </div>
      )}
    </div>
  )
}
