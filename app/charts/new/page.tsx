'use client'

import { useState, useCallback, useEffect } from 'react'
import { useRouter } from 'next/navigation'
import Link from 'next/link'
import { ArrowLeft, Save, CheckCircle2, ChevronRight, ChevronLeft } from 'lucide-react'
import { clsx } from 'clsx'
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

  // Mobile wizard step (0 = Dataset, 1 = Configure, 2 = Preview)
  const [mobileStep, setMobileStep] = useState(0)
  const MOBILE_STEPS = ['Dataset', 'Configure', 'Preview']

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

      {/* Mobile step indicator */}
      <div className="md:hidden flex items-center px-4 py-3 border-b border-[#1f1f25] bg-[#0d0d10] flex-shrink-0">
        {MOBILE_STEPS.map((step, idx) => (
          <div key={step} className="flex items-center">
            <button
              onClick={() => setMobileStep(idx)}
              className={clsx(
                'flex items-center gap-1.5 text-[12px] font-semibold transition-colors',
                mobileStep === idx ? 'text-[#7c68ff]' : mobileStep > idx ? 'text-[#4dcc88]' : 'text-[#44444b]'
              )}
            >
              <span
                className={clsx(
                  'w-5 h-5 rounded-full flex items-center justify-center text-[10px] font-bold',
                  mobileStep === idx ? 'bg-[#7c68ff] text-white' : mobileStep > idx ? 'bg-[#4dcc8840] text-[#4dcc88]' : 'bg-[#2a2a31] text-[#44444b]'
                )}
              >
                {mobileStep > idx ? '✓' : idx + 1}
              </span>
              {step}
            </button>
            {idx < MOBILE_STEPS.length - 1 && (
              <ChevronRight size={13} className="mx-2 text-[#2a2a31] flex-shrink-0" />
            )}
          </div>
        ))}
      </div>

      {/* 3-column layout - desktop: all 3 visible; mobile: one step at a time */}
      <div className="flex flex-1 overflow-hidden" style={{ height: 'calc(100vh - 110px)' }}>
        {/* Left: Dataset & Column Picker (~25%) */}
        <div className={clsx(
          'border-r border-[#1f1f25] flex flex-col overflow-hidden',
          // Mobile: show only on step 0
          mobileStep === 0 ? 'flex w-full' : 'hidden',
          // Desktop: always visible at 25%
          'md:flex md:w-[25%] md:min-w-[200px]'
        )}>
          <DatasetPicker
            selectedDataset={selectedDataset}
            onSelectDataset={handleSelectDataset}
            columnRoles={columnRoles}
            onToggleColumn={handleToggleColumn}
          />
        </div>

        {/* Center: Config Panel (~30%) */}
        <div className={clsx(
          'border-r border-[#1f1f25] flex flex-col overflow-hidden',
          // Mobile: show only on step 1
          mobileStep === 1 ? 'flex w-full' : 'hidden',
          // Desktop: always visible at 30%
          'md:flex md:w-[30%] md:min-w-[240px]'
        )}>
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
        <div className={clsx(
          'flex flex-col overflow-hidden bg-[#0d0d10]',
          // Mobile: show only on step 2
          mobileStep === 2 ? 'flex flex-1' : 'hidden',
          // Desktop: always visible as flex-1
          'md:flex md:flex-1'
        )}>
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

      {/* Mobile Next/Back navigation */}
      <div className="md:hidden flex items-center justify-between px-4 py-3 border-t border-[#1f1f25] bg-[#0d0d10] flex-shrink-0">
        <button
          onClick={() => setMobileStep(s => Math.max(0, s - 1))}
          disabled={mobileStep === 0}
          className="flex items-center gap-1.5 px-4 py-2.5 min-h-[44px] rounded-[8px] text-[13px] font-medium border border-[#2a2a31] text-[#a0a0a7] disabled:opacity-30 hover:bg-[#16161a] transition-colors"
        >
          <ChevronLeft size={15} /> Back
        </button>
        <span className="text-[12px] text-[#44444b]">{mobileStep + 1} of {MOBILE_STEPS.length}</span>
        {mobileStep < MOBILE_STEPS.length - 1 ? (
          <button
            onClick={() => setMobileStep(s => Math.min(MOBILE_STEPS.length - 1, s + 1))}
            className="flex items-center gap-1.5 px-4 py-2.5 min-h-[44px] rounded-[8px] text-[13px] font-semibold bg-[#7c68ff] text-white hover:bg-[#9080ff] transition-colors"
          >
            Next <ChevronRight size={15} />
          </button>
        ) : (
          <button
            onClick={handleSave}
            className="flex items-center gap-1.5 px-4 py-2.5 min-h-[44px] rounded-[8px] text-[13px] font-semibold bg-[#7c68ff] text-white hover:bg-[#9080ff] transition-colors"
          >
            <Save size={14} /> Save
          </button>
        )}
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
