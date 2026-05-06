'use client'

import { clsx } from 'clsx'
import { BarChart2, TrendingUp, AreaChart, PieChart, Hash, Table } from 'lucide-react'

export type ChartType = 'bar' | 'line' | 'area' | 'pie' | 'bigNumber' | 'table'

const CHART_TYPES: { type: ChartType; label: string; icon: React.ReactNode }[] = [
  { type: 'bar',       label: 'Bar',        icon: <BarChart2 size={18} /> },
  { type: 'line',      label: 'Line',       icon: <TrendingUp size={18} /> },
  { type: 'area',      label: 'Area',       icon: <AreaChart size={18} /> },
  { type: 'pie',       label: 'Pie',        icon: <PieChart size={18} /> },
  { type: 'bigNumber', label: 'Big Number', icon: <Hash size={18} /> },
  { type: 'table',     label: 'Table',      icon: <Table size={18} /> },
]

type Props = {
  selected: ChartType
  onChange: (type: ChartType) => void
}

export default function ChartTypeSelector({ selected, onChange }: Props) {
  return (
    <div>
      <p className="text-[11px] font-semibold text-[#6c6c74] uppercase tracking-wider mb-2">Chart Type</p>
      <div className="grid grid-cols-3 gap-2">
        {CHART_TYPES.map(({ type, label, icon }) => (
          <button
            key={type}
            onClick={() => onChange(type)}
            className={clsx(
              'flex flex-col items-center justify-center gap-1.5 py-3 px-2 rounded-[10px] border text-[11px] font-medium transition-all',
              selected === type
                ? 'bg-[#7c68ff20] border-[#7c68ff] text-[#a494ff] shadow-[0_0_0_1px_#7c68ff40]'
                : 'bg-[#111114] border-[#2a2a31] text-[#6c6c74] hover:border-[#3a3a45] hover:text-[#a0a0a7] hover:bg-[#16161a]'
            )}
          >
            <span className={selected === type ? 'text-[#7c68ff]' : 'text-[#44444b]'}>{icon}</span>
            {label}
          </button>
        ))}
      </div>
    </div>
  )
}
