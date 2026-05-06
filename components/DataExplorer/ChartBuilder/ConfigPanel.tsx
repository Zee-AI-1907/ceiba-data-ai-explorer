'use client'

import { clsx } from 'clsx'
import { Plus, X, Filter } from 'lucide-react'
import ChartTypeSelector, { ChartType } from './ChartTypeSelector'

export type FilterDef = {
  id: string
  column: string
  operator: string
  value: string
}

type Props = {
  chartType: ChartType
  onChartTypeChange: (type: ChartType) => void
  title: string
  onTitleChange: (t: string) => void
  metrics: string[]
  dimensions: string[]
  onRemoveMetric: (col: string) => void
  onRemoveDimension: (col: string) => void
  filters: FilterDef[]
  onAddFilter: () => void
  onRemoveFilter: (id: string) => void
}

const OPERATORS = ['=', '!=', '>', '<', '>=', '<=', 'LIKE', 'IN']

export default function ConfigPanel({
  chartType,
  onChartTypeChange,
  title,
  onTitleChange,
  metrics,
  dimensions,
  onRemoveMetric,
  onRemoveDimension,
  filters,
  onAddFilter,
  onRemoveFilter,
}: Props) {
  return (
    <div className="flex flex-col h-full overflow-y-auto px-4 py-4 gap-5">
      {/* Chart Type */}
      <ChartTypeSelector selected={chartType} onChange={onChartTypeChange} />

      {/* Title */}
      <div>
        <p className="text-[11px] font-semibold text-[#6c6c74] uppercase tracking-wider mb-2">Chart Title</p>
        <input
          type="text"
          value={title}
          onChange={(e) => onTitleChange(e.target.value)}
          placeholder="Enter chart title..."
          className="w-full px-3 py-2 rounded-[8px] bg-[#111114] border border-[#2a2a31] text-[13px] text-[#e8e8ea] placeholder-[#44444b] outline-none focus:border-[#7c68ff] transition-colors"
        />
      </div>

      {/* Metrics */}
      <div>
        <p className="text-[11px] font-semibold text-[#6c6c74] uppercase tracking-wider mb-2">
          Metrics <span className="text-[#44444b] normal-case">(Y-axis / values)</span>
        </p>
        <div className="min-h-[48px] rounded-[8px] border border-dashed border-[#2a2a31] p-2 flex flex-wrap gap-1.5">
          {metrics.length === 0 && (
            <span className="text-[11px] text-[#44444b] self-center px-1">
              Assign numeric columns as Metric
            </span>
          )}
          {metrics.map((m) => (
            <span
              key={m}
              className="flex items-center gap-1 px-2 py-1 rounded-full bg-[#4dcc8820] border border-[#4dcc8840] text-[#4dcc88] text-[11px] font-medium"
            >
              {m}
              <button onClick={() => onRemoveMetric(m)} className="hover:text-white ml-0.5">
                <X size={10} />
              </button>
            </span>
          ))}
        </div>
      </div>

      {/* Dimensions */}
      <div>
        <p className="text-[11px] font-semibold text-[#6c6c74] uppercase tracking-wider mb-2">
          Dimensions <span className="text-[#44444b] normal-case">(X-axis / groups)</span>
        </p>
        <div className="min-h-[48px] rounded-[8px] border border-dashed border-[#2a2a31] p-2 flex flex-wrap gap-1.5">
          {dimensions.length === 0 && (
            <span className="text-[11px] text-[#44444b] self-center px-1">
              Assign text/date columns as Dimension
            </span>
          )}
          {dimensions.map((d) => (
            <span
              key={d}
              className="flex items-center gap-1 px-2 py-1 rounded-full bg-[#4c8dff20] border border-[#4c8dff40] text-[#4c8dff] text-[11px] font-medium"
            >
              {d}
              <button onClick={() => onRemoveDimension(d)} className="hover:text-white ml-0.5">
                <X size={10} />
              </button>
            </span>
          ))}
        </div>
      </div>

      {/* Filters */}
      <div>
        <div className="flex items-center justify-between mb-2">
          <p className="text-[11px] font-semibold text-[#6c6c74] uppercase tracking-wider">Filters</p>
          <button
            onClick={onAddFilter}
            className="flex items-center gap-1 text-[11px] text-[#7c68ff] hover:text-[#a494ff] transition-colors"
          >
            <Plus size={12} /> Add Filter
          </button>
        </div>
        {filters.length === 0 && (
          <div className="flex items-center gap-2 px-3 py-2.5 rounded-[8px] border border-dashed border-[#2a2a31] text-[11px] text-[#44444b]">
            <Filter size={12} /> No filters applied
          </div>
        )}
        <div className="flex flex-col gap-2">
          {filters.map((f) => (
            <div
              key={f.id}
              className="flex items-center gap-2 px-3 py-2 rounded-[8px] bg-[#111114] border border-[#2a2a31]"
            >
              <div className="flex-1 grid grid-cols-3 gap-1.5">
                <input
                  defaultValue={f.column}
                  placeholder="column"
                  className="text-[11px] bg-[#16161a] border border-[#2a2a31] rounded-[6px] px-2 py-1 text-[#a0a0a7] outline-none focus:border-[#7c68ff]"
                />
                <select
                  defaultValue={f.operator}
                  className="text-[11px] bg-[#16161a] border border-[#2a2a31] rounded-[6px] px-2 py-1 text-[#a0a0a7] outline-none focus:border-[#7c68ff]"
                >
                  {OPERATORS.map((op) => (
                    <option key={op} value={op}>{op}</option>
                  ))}
                </select>
                <input
                  defaultValue={f.value}
                  placeholder="value"
                  className="text-[11px] bg-[#16161a] border border-[#2a2a31] rounded-[6px] px-2 py-1 text-[#a0a0a7] outline-none focus:border-[#7c68ff]"
                />
              </div>
              <button
                onClick={() => onRemoveFilter(f.id)}
                className="text-[#44444b] hover:text-[#ff5c6c] transition-colors flex-shrink-0"
              >
                <X size={13} />
              </button>
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}
