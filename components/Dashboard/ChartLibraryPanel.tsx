'use client'

import { Plus, BarChart2, PieChart, Hash, Table2 } from 'lucide-react'
import { clsx } from 'clsx'

export type ChartLibraryItem = {
  id: string
  name: string
  type: string
}

export const CHART_LIBRARY: ChartLibraryItem[] = [
  { id: 'call-duration-user',     name: 'Call Duration by User',   type: 'Bar Chart'                   },
  { id: 'direct-calls-user',      name: 'Direct Calls by User',    type: 'Bar Chart'                   },
  { id: 'direct-calls-session',   name: 'Direct Calls by Session', type: 'Pie Chart'                   },
  { id: 'avg-call-duration',      name: 'Average Call Duration',   type: 'Big Number'                  },
  { id: 'total-call-duration',    name: 'Total Call Duration',     type: 'Big Number'                  },
  { id: 'monthly-direct-calls',   name: 'Monthly Direct Calls',    type: 'Big Number with Trendline'   },
  { id: 'detail-table',           name: 'Detail Table',            type: 'Table'                       },
]

const TYPE_ICON: Record<string, React.ReactNode> = {
  'Bar Chart':                  <BarChart2 size={12} />,
  'Pie Chart':                  <PieChart size={12} />,
  'Big Number':                 <Hash size={12} />,
  'Big Number with Trendline':  <Hash size={12} />,
  'Table':                      <Table2 size={12} />,
}

const TYPE_COLOR: Record<string, string> = {
  'Bar Chart':                  '#7c68ff',
  'Pie Chart':                  '#4c8dff',
  'Big Number':                 '#4dcc88',
  'Big Number with Trendline':  '#4dcc88',
  'Table':                      '#f4a942',
}

type Props = {
  onAddChart: (chart: ChartLibraryItem) => void
  addedIds: Set<string>
}

export function ChartLibraryPanel({ onAddChart, addedIds }: Props) {
  return (
    <div className="w-[220px] flex-shrink-0 bg-[#111114] border-r border-[#1f1f25] flex flex-col overflow-hidden">
      {/* Panel header */}
      <div className="px-4 pt-4 pb-3 border-b border-[#1f1f25]">
        <p className="text-[11px] font-semibold text-[#a0a0a7] uppercase tracking-wider">Chart Library</p>
        <p className="text-[10px] text-[#44444b] mt-0.5">Click + to add to canvas</p>
      </div>

      {/* Chart list */}
      <div className="flex-1 overflow-y-auto py-2">
        {CHART_LIBRARY.map((chart) => {
          const color = TYPE_COLOR[chart.type] ?? '#a0a0a7'
          const icon  = TYPE_ICON[chart.type] ?? <BarChart2 size={12} />
          const added = addedIds.has(chart.id)

          return (
            <div
              key={chart.id}
              className={clsx(
                'flex items-start justify-between gap-2 px-3 py-2.5 mx-2 rounded-[8px] mb-0.5 group',
                'hover:bg-[#16161a] transition-colors',
              )}
            >
              <div className="flex flex-col gap-1 min-w-0">
                {/* Type badge */}
                <span
                  className="flex items-center gap-1 text-[9px] font-semibold w-fit px-1.5 py-0.5 rounded-[4px]"
                  style={{ background: `${color}20`, color }}
                >
                  {icon}
                  {chart.type}
                </span>
                {/* Chart name */}
                <span className="text-[11px] text-[#a0a0a7] leading-tight">{chart.name}</span>
              </div>

              <button
                onClick={() => onAddChart(chart)}
                disabled={added}
                className={clsx(
                  'flex-shrink-0 w-6 h-6 rounded-[5px] flex items-center justify-center transition-all mt-0.5',
                  added
                    ? 'text-[#4dcc88] bg-[#4dcc8820] cursor-default'
                    : 'text-[#6c6c74] hover:text-white hover:bg-[#7c68ff] border border-[#2a2a31] hover:border-[#7c68ff]',
                )}
                title={added ? 'Already on canvas' : 'Add to canvas'}
              >
                {added ? '✓' : <Plus size={11} />}
              </button>
            </div>
          )
        })}
      </div>
    </div>
  )
}
