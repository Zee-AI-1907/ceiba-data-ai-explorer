'use client'

import { clsx } from 'clsx'
import { Database, ChevronDown, ChevronRight, Hash, AlignLeft, Calendar } from 'lucide-react'
import { useState } from 'react'

export type ColumnRole = 'metric' | 'dimension' | null

export type ColumnDef = {
  name: string
  type: 'text' | 'numeric' | 'date'
}

export const DATASETS: Record<string, ColumnDef[]> = {
  'Call Sessions': [
    { name: 'department', type: 'text' },
    { name: 'hospital_name', type: 'text' },
    { name: 'unit', type: 'text' },
    { name: 'status', type: 'text' },
    { name: 'count', type: 'numeric' },
    { name: 'duration_seconds', type: 'numeric' },
    { name: 'total_calls', type: 'numeric' },
    { name: 'avg_duration', type: 'numeric' },
    { name: 'call_date', type: 'date' },
  ],
  'Call Level Dataset': [
    { name: 'department', type: 'text' },
    { name: 'status', type: 'text' },
    { name: 'patient_name', type: 'text' },
    { name: 'duration_seconds', type: 'numeric' },
    { name: 'total_calls', type: 'numeric' },
    { name: 'avg_duration', type: 'numeric' },
    { name: 'call_date', type: 'date' },
    { name: 'admission_date', type: 'date' },
  ],
  'Direct Calls Query': [
    { name: 'hospital_name', type: 'text' },
    { name: 'unit', type: 'text' },
    { name: 'status', type: 'text' },
    { name: 'count', type: 'numeric' },
    { name: 'duration_seconds', type: 'numeric' },
    { name: 'total_calls', type: 'numeric' },
    { name: 'call_date', type: 'date' },
    { name: 'discharge_date', type: 'date' },
  ],
  'Critical Patients': [
    { name: 'department', type: 'text' },
    { name: 'hospital_name', type: 'text' },
    { name: 'patient_name', type: 'text' },
    { name: 'status', type: 'text' },
    { name: 'patient_count', type: 'numeric' },
    { name: 'avg_duration', type: 'numeric' },
    { name: 'admission_date', type: 'date' },
    { name: 'discharge_date', type: 'date' },
  ],
  'Apache II': [
    { name: 'unit', type: 'text' },
    { name: 'hospital_name', type: 'text' },
    { name: 'status', type: 'text' },
    { name: 'patient_count', type: 'numeric' },
    { name: 'count', type: 'numeric' },
    { name: 'avg_duration', type: 'numeric' },
    { name: 'admission_date', type: 'date' },
  ],
}

const TYPE_ICON: Record<ColumnDef['type'], React.ReactNode> = {
  text:    <AlignLeft size={11} className="text-[#4c8dff]" />,
  numeric: <Hash size={11} className="text-[#4dcc88]" />,
  date:    <Calendar size={11} className="text-[#f4a942]" />,
}

const TYPE_LABEL: Record<ColumnDef['type'], string> = {
  text:    'Text',
  numeric: 'Numeric',
  date:    'Date',
}

type Props = {
  selectedDataset: string | null
  onSelectDataset: (name: string) => void
  columnRoles: Record<string, ColumnRole>
  onToggleColumn: (col: ColumnDef) => void
}

export default function DatasetPicker({ selectedDataset, onSelectDataset, columnRoles, onToggleColumn }: Props) {
  const [expanded, setExpanded] = useState<Record<string, boolean>>({ text: true, numeric: true, date: true })

  const columns = selectedDataset ? DATASETS[selectedDataset] ?? [] : []
  const grouped = {
    text: columns.filter((c) => c.type === 'text'),
    numeric: columns.filter((c) => c.type === 'numeric'),
    date: columns.filter((c) => c.type === 'date'),
  }

  return (
    <div className="flex flex-col h-full overflow-hidden">
      {/* Header */}
      <div className="px-4 py-3 border-b border-[#2a2a31] flex-shrink-0">
        <p className="text-[11px] font-semibold text-[#6c6c74] uppercase tracking-wider mb-2">Dataset</p>
        <div className="flex flex-col gap-1">
          {Object.keys(DATASETS).map((name) => (
            <button
              key={name}
              onClick={() => onSelectDataset(name)}
              className={clsx(
                'flex items-center gap-2 px-3 py-2 rounded-[8px] text-[12px] text-left transition-colors w-full',
                selectedDataset === name
                  ? 'bg-[#7c68ff20] border border-[#7c68ff60] text-[#a494ff]'
                  : 'border border-transparent text-[#a0a0a7] hover:bg-[#16161a] hover:text-[#e8e8ea]'
              )}
            >
              <Database size={12} className={selectedDataset === name ? 'text-[#7c68ff]' : 'text-[#44444b]'} />
              {name}
            </button>
          ))}
        </div>
      </div>

      {/* Columns */}
      {selectedDataset && (
        <div className="flex-1 overflow-y-auto px-3 py-3">
          <p className="text-[11px] font-semibold text-[#6c6c74] uppercase tracking-wider mb-2 px-1">Columns</p>
          {(Object.entries(grouped) as [ColumnDef['type'], ColumnDef[]][]).map(([type, cols]) => {
            if (!cols.length) return null
            return (
              <div key={type} className="mb-3">
                <button
                  onClick={() => setExpanded((prev) => ({ ...prev, [type]: !prev[type] }))}
                  className="flex items-center gap-1.5 w-full px-1 py-1 text-[10px] font-semibold text-[#44444b] uppercase tracking-wider hover:text-[#6c6c74]"
                >
                  {expanded[type] ? <ChevronDown size={10} /> : <ChevronRight size={10} />}
                  {TYPE_LABEL[type]}
                </button>
                {expanded[type] && (
                  <div className="mt-1 flex flex-col gap-0.5">
                    {cols.map((col) => {
                      const role = columnRoles[col.name]
                      return (
                        <button
                          key={col.name}
                          onClick={() => onToggleColumn(col)}
                          className={clsx(
                            'flex items-center justify-between gap-2 px-2 py-1.5 rounded-[6px] text-[12px] transition-colors w-full group',
                            role === 'metric'    ? 'bg-[#4dcc8820] border border-[#4dcc8840] text-[#4dcc88]'
                            : role === 'dimension' ? 'bg-[#4c8dff20] border border-[#4c8dff40] text-[#4c8dff]'
                            : 'border border-transparent text-[#a0a0a7] hover:bg-[#16161a] hover:text-[#e8e8ea]'
                          )}
                        >
                          <span className="flex items-center gap-1.5">
                            {TYPE_ICON[col.type]}
                            {col.name}
                          </span>
                          {role && (
                            <span className={clsx(
                              'text-[9px] font-bold uppercase px-1.5 py-0.5 rounded-full',
                              role === 'metric' ? 'bg-[#4dcc8830] text-[#4dcc88]' : 'bg-[#4c8dff30] text-[#4c8dff]'
                            )}>
                              {role}
                            </span>
                          )}
                        </button>
                      )
                    })}
                  </div>
                )}
              </div>
            )
          })}
          <p className="text-[10px] text-[#44444b] px-1 mt-2">Click a column to toggle Metric / Dimension</p>
        </div>
      )}

      {!selectedDataset && (
        <div className="flex-1 flex items-center justify-center">
          <p className="text-[12px] text-[#44444b]">Select a dataset above</p>
        </div>
      )}
    </div>
  )
}
