'use client'

import { useState } from 'react'
import { Plus, X, ChevronDown } from 'lucide-react'
import { clsx } from 'clsx'
import type { DashboardFilter } from '@/lib/dashboardStore'

const FILTER_COLUMNS = [
  'Department',
  'Hospital',
  'Date Range',
  'Call Purpose',
  'User',
  'Status',
]

type Props = {
  filters: DashboardFilter[]
  editMode: boolean
  onFiltersChange: (filters: DashboardFilter[]) => void
}

export function DashboardFilters({ filters, editMode, onFiltersChange }: Props) {
  const [showDropdown, setShowDropdown] = useState(false)

  const addFilter = (column: string) => {
    const newFilter: DashboardFilter = {
      id: `filter-${Date.now()}`,
      column,
      value: undefined,
    }
    onFiltersChange([...filters, newFilter])
    setShowDropdown(false)
  }

  const removeFilter = (id: string) => {
    onFiltersChange(filters.filter((f) => f.id !== id))
  }

  return (
    <div className="flex items-center gap-2 px-4 py-2 border-b border-[#1f1f25] bg-[#0d0d10] flex-wrap min-h-[44px]">
      {/* Active filter chips */}
      {filters.map((filter) => (
        <div
          key={filter.id}
          className="flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-[#7c68ff20] border border-[#7c68ff40] text-[11px] text-[#a0a0a7]"
        >
          <span className="text-[#7c68ff] font-semibold">{filter.column}</span>
          {filter.value && <span>: {filter.value}</span>}
          {editMode && (
            <button
              onClick={() => removeFilter(filter.id)}
              className="text-[#6c6c74] hover:text-[#ff5c6c] transition-colors ml-0.5"
            >
              <X size={10} />
            </button>
          )}
        </div>
      ))}

      {/* Add filter */}
      {editMode && (
        <div className="relative">
          <button
            onClick={() => setShowDropdown((v) => !v)}
            className={clsx(
              'flex items-center gap-1 px-2.5 py-1 rounded-full text-[11px] font-medium transition-all',
              'border border-dashed border-[#2a2a31] text-[#44444b]',
              'hover:border-[#7c68ff] hover:text-[#7c68ff]',
            )}
          >
            <Plus size={10} />
            Add Filter
            <ChevronDown size={9} />
          </button>

          {showDropdown && (
            <div className="absolute left-0 top-8 z-20 bg-[#1b1b20] border border-[#2a2a31] rounded-[8px] shadow-xl overflow-hidden min-w-[160px]">
              {FILTER_COLUMNS.map((col) => (
                <button
                  key={col}
                  onClick={() => addFilter(col)}
                  className="flex items-center w-full px-3 py-2 text-[12px] text-[#a0a0a7] hover:bg-[#7c68ff20] hover:text-[#e8e8ea] transition-colors"
                >
                  {col}
                </button>
              ))}
            </div>
          )}
        </div>
      )}

      {filters.length === 0 && !editMode && (
        <span className="text-[11px] text-[#2a2a31] italic">No filters applied</span>
      )}
    </div>
  )
}
