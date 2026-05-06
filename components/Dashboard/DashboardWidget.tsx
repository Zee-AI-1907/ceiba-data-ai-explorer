'use client'

import {
  BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer,
  PieChart, Pie, Cell,
  AreaChart, Area,
} from 'recharts'
import { useState } from 'react'
import { X, ChevronUp, ChevronDown, ChevronLeft, ChevronRight } from 'lucide-react'
import { clsx } from 'clsx'
import type { CanvasWidget, WidgetSize } from '@/lib/dashboardStore'
import { CommentButton } from '@/components/Comments/CommentButton'
import { CommentThread } from '@/components/Comments/CommentThread'
import { slugify } from '@/lib/commentStore'

// ─── Mock data ───────────────────────────────────────────────────────────────

const BAR_DATA = [
  { name: 'Cardiology', calls: 168 },
  { name: 'Oncology',   calls: 143 },
  { name: 'Neurology',  calls: 127 },
  { name: 'Pediatrics', calls: 98  },
  { name: 'ER',         calls: 182 },
  { name: 'ICU',        calls: 74  },
]

const BAR_DATA_2 = [
  { name: 'Dr. Ahmed',   calls: 112 },
  { name: 'Dr. Yilmaz',  calls: 87  },
  { name: 'Dr. Kaya',    calls: 134 },
  { name: 'Dr. Demir',   calls: 56  },
  { name: 'Dr. Sahin',   calls: 98  },
  { name: 'Dr. Ozturk',  calls: 145 },
]

const PIE_DATA = [
  { name: 'Consultation',  value: 42 },
  { name: 'Follow-up',     value: 28 },
  { name: 'Emergency',     value: 17 },
  { name: 'Referral',      value: 13 },
]

const PIE_COLORS = ['#7c68ff', '#4c8dff', '#4dcc88', '#f4a942']

const TREND_DATA = [
  { month: 'Jun', calls: 820  },
  { month: 'Jul', calls: 934  },
  { month: 'Aug', calls: 861  },
  { month: 'Sep', calls: 1102 },
  { month: 'Oct', calls: 1247 },
  { month: 'Nov', calls: 1183 },
  { month: 'Dec', calls: 1356 },
  { month: 'Jan', calls: 1421 },
]

const TABLE_ROWS = [
  { patient: 'John D.',   dept: 'Cardiology', duration: '12m 34s', purpose: 'Consultation' },
  { patient: 'Sara M.',   dept: 'Neurology',  duration: '8m 12s',  purpose: 'Follow-up'    },
  { patient: 'Ahmed K.',  dept: 'ICU',        duration: '23m 45s', purpose: 'Emergency'    },
  { patient: 'Lena P.',   dept: 'Pediatrics', duration: '6m 09s',  purpose: 'Referral'     },
  { patient: 'Carlos R.', dept: 'Oncology',   duration: '15m 52s', purpose: 'Consultation' },
]

// ─── Chart renders ────────────────────────────────────────────────────────────

function BarChartRender({ alt }: { alt?: boolean }) {
  const data = alt ? BAR_DATA_2 : BAR_DATA
  return (
    <ResponsiveContainer width="100%" height="100%">
      <BarChart data={data} margin={{ top: 4, right: 8, left: -20, bottom: 0 }}>
        <CartesianGrid strokeDasharray="3 3" stroke="#1f1f25" />
        <XAxis dataKey="name" tick={{ fill: '#6c6c74', fontSize: 10 }} axisLine={false} tickLine={false} />
        <YAxis tick={{ fill: '#6c6c74', fontSize: 10 }} axisLine={false} tickLine={false} />
        <Tooltip
          contentStyle={{ background: '#1b1b20', border: '1px solid #2a2a31', borderRadius: 8, fontSize: 12 }}
          labelStyle={{ color: '#a0a0a7' }}
          itemStyle={{ color: '#7c68ff' }}
        />
        <Bar dataKey="calls" fill="#7c68ff" radius={[4, 4, 0, 0]} />
      </BarChart>
    </ResponsiveContainer>
  )
}

function PieChartRender() {
  return (
    <ResponsiveContainer width="100%" height="100%">
      <PieChart>
        <Pie
          data={PIE_DATA}
          cx="50%"
          cy="50%"
          innerRadius="35%"
          outerRadius="65%"
          paddingAngle={3}
          dataKey="value"
        >
          {PIE_DATA.map((_, i) => (
            <Cell key={i} fill={PIE_COLORS[i % PIE_COLORS.length]} />
          ))}
        </Pie>
        <Tooltip
          contentStyle={{ background: '#1b1b20', border: '1px solid #2a2a31', borderRadius: 8, fontSize: 12 }}
          itemStyle={{ color: '#e8e8ea' }}
        />
      </PieChart>
    </ResponsiveContainer>
  )
}

function BigNumberRender({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex flex-col items-center justify-center h-full gap-1">
      <span className="text-[42px] font-bold text-[#e8e8ea] leading-none">{value}</span>
      <span className="text-[13px] text-[#6c6c74]">{label}</span>
    </div>
  )
}

function BigNumberTrendRender({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex flex-col h-full">
      <div className="flex flex-col items-center justify-center flex-shrink-0 pt-3 pb-1">
        <span className="text-[38px] font-bold text-[#e8e8ea] leading-none">{value}</span>
        <span className="text-[12px] text-[#6c6c74] mt-1">{label}</span>
      </div>
      <div className="flex-1 min-h-0">
        <ResponsiveContainer width="100%" height="100%">
          <AreaChart data={TREND_DATA} margin={{ top: 4, right: 8, left: -20, bottom: 0 }}>
            <defs>
              <linearGradient id="trendGrad" x1="0" y1="0" x2="0" y2="1">
                <stop offset="5%"  stopColor="#4dcc88" stopOpacity={0.25} />
                <stop offset="95%" stopColor="#4dcc88" stopOpacity={0} />
              </linearGradient>
            </defs>
            <CartesianGrid strokeDasharray="3 3" stroke="#1f1f25" />
            <XAxis dataKey="month" tick={{ fill: '#6c6c74', fontSize: 10 }} axisLine={false} tickLine={false} />
            <YAxis tick={{ fill: '#6c6c74', fontSize: 10 }} axisLine={false} tickLine={false} />
            <Tooltip
              contentStyle={{ background: '#1b1b20', border: '1px solid #2a2a31', borderRadius: 8, fontSize: 12 }}
              itemStyle={{ color: '#4dcc88' }}
            />
            <Area type="monotone" dataKey="calls" stroke="#4dcc88" strokeWidth={2} fill="url(#trendGrad)" dot={false} />
          </AreaChart>
        </ResponsiveContainer>
      </div>
    </div>
  )
}

function TableRender() {
  return (
    <div className="h-full overflow-auto">
      <table className="w-full text-[11px]">
        <thead>
          <tr className="border-b border-[#2a2a31]">
            {['Patient', 'Department', 'Duration', 'Purpose'].map((h) => (
              <th key={h} className="text-left px-2 py-1.5 text-[#6c6c74] font-semibold uppercase tracking-wider text-[10px]">{h}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {TABLE_ROWS.map((row, i) => (
            <tr key={i} className={clsx('border-b border-[#1f1f25]', i % 2 === 1 ? 'bg-[#111114]' : '')}>
              <td className="px-2 py-1.5 text-[#e8e8ea]">{row.patient}</td>
              <td className="px-2 py-1.5 text-[#a0a0a7]">{row.dept}</td>
              <td className="px-2 py-1.5 text-[#4dcc88] font-mono">{row.duration}</td>
              <td className="px-2 py-1.5 text-[#4c8dff]">{row.purpose}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

// ─── Chart dispatcher ─────────────────────────────────────────────────────────

function ChartContent({ widget }: { widget: CanvasWidget }) {
  const t = widget.chartType.toLowerCase()
  const n = widget.chartName.toLowerCase()

  if (t.includes('big number with trendline') || t.includes('trendline')) {
    const label = n.includes('monthly') ? 'Monthly Direct Calls' : 'Trend'
    const value = n.includes('monthly') ? '1,421' : '847'
    return <BigNumberTrendRender label={label} value={value} />
  }
  if (t.includes('big number')) {
    const isAvg = n.includes('average')
    return <BigNumberRender label={isAvg ? 'Avg Call Duration' : 'Total Call Duration'} value={isAvg ? '14m 32s' : '1,247'} />
  }
  if (t.includes('bar')) {
    const alt = n.includes('user')
    return <BarChartRender alt={alt} />
  }
  if (t.includes('pie')) {
    return <PieChartRender />
  }
  if (t.includes('table')) {
    return <TableRender />
  }
  // fallback
  return <BarChartRender />
}

// ─── Size config ──────────────────────────────────────────────────────────────

const SIZE_SPANS: Record<WidgetSize, string> = {
  small:  'col-span-1 row-span-1',
  medium: 'col-span-1 md:col-span-2 row-span-1',
  large:  'col-span-1 md:col-span-2 row-span-1 md:row-span-2',
}

const SIZE_HEIGHT: Record<WidgetSize, string> = {
  small:  'h-[260px]',
  medium: 'h-[260px]',
  large:  'h-[540px]',
}

const SIZE_LABELS: WidgetSize[] = ['small', 'medium', 'large']

const TYPE_BADGE_COLORS: Record<string, string> = {
  'Bar Chart':                  '#7c68ff',
  'Pie Chart':                  '#4c8dff',
  'Big Number':                 '#4dcc88',
  'Big Number with Trendline':  '#4dcc88',
  'Table':                      '#f4a942',
  'Pivot Table':                '#a0a0a7',
}

// ─── Component ────────────────────────────────────────────────────────────────

type Props = {
  widget: CanvasWidget
  editMode: boolean
  isFirst: boolean
  isLast: boolean
  onRemove: () => void
  onMoveUp: () => void
  onMoveDown: () => void
  onMoveLeft: () => void
  onMoveRight: () => void
  onSizeChange: (size: WidgetSize) => void
}

export function DashboardWidget({
  widget,
  editMode,
  isFirst,
  isLast,
  onRemove,
  onMoveUp,
  onMoveDown,
  onMoveLeft,
  onMoveRight,
  onSizeChange,
}: Props) {
  const badgeColor = TYPE_BADGE_COLORS[widget.chartType] ?? '#a0a0a7'
  const sizeIdx = SIZE_LABELS.indexOf(widget.size)
  const [commentsOpen, setCommentsOpen] = useState(false)
  const widgetResourceId = slugify(widget.chartName)

  return (
    <div
      className={clsx(
        SIZE_SPANS[widget.size],
        'bg-[#16161a] border border-[#2a2a31] rounded-[12px] flex flex-col',
        'shadow-[0_4px_24px_rgba(0,0,0,0.4)] transition-all',
        editMode && 'hover:border-[#7c68ff40]',
      )}
    >
      {/* Header */}
      <div className="flex items-center justify-between px-3 pt-3 pb-2 flex-shrink-0">
        <div className="flex items-center gap-2 min-w-0">
          {editMode && (
            <span className="text-[#3a3a45] cursor-grab select-none text-[14px] flex-shrink-0" title="Drag handle">⠿</span>
          )}
          <span
            className="text-[10px] font-semibold px-1.5 py-0.5 rounded-[5px] flex-shrink-0"
            style={{ background: `${badgeColor}20`, color: badgeColor }}
          >
            {widget.chartType}
          </span>
          <span className="text-[12px] font-semibold text-[#e8e8ea] truncate">{widget.chartName}</span>
        </div>
        <div className="flex items-center gap-1 flex-shrink-0 ml-1">
          <CommentButton
            resourceType="widget"
            resourceId={widgetResourceId}
            isOpen={commentsOpen}
            onClick={() => setCommentsOpen((v) => !v)}
          />
          {editMode && (
            <button
              onClick={onRemove}
              className="w-5 h-5 flex items-center justify-center rounded-[4px] text-[#44444b] hover:text-[#ff5c6c] hover:bg-[#ff5c6c15] transition-colors"
              title="Remove"
            >
              <X size={11} />
            </button>
          )}
        </div>
      </div>

      {/* Chart area */}
      <div className={clsx('flex-1 px-2 pb-2 min-h-0', SIZE_HEIGHT[widget.size])}>
        <ChartContent widget={widget} />
      </div>

      {/* Inline comment thread */}
      {commentsOpen && (
        <div className="px-2 pb-2">
          <CommentThread
            resourceType="widget"
            resourceId={widgetResourceId}
            resourceLabel={widget.chartName}
            onClose={() => setCommentsOpen(false)}
            mode="inline"
          />
        </div>
      )}

      {/* Edit controls */}
      {editMode && (
        <div className="flex items-center justify-between px-3 pb-2 pt-1 border-t border-[#1f1f25] flex-shrink-0">
          {/* Size toggle */}
          <div className="flex items-center gap-1">
            <span className="text-[9px] text-[#44444b] uppercase tracking-wider mr-1">Size</span>
            {SIZE_LABELS.map((s, i) => (
              <button
                key={s}
                onClick={() => onSizeChange(s)}
                className={clsx(
                  'px-1.5 py-0.5 text-[9px] font-semibold rounded-[4px] uppercase transition-colors',
                  widget.size === s
                    ? 'bg-[#7c68ff] text-white'
                    : 'text-[#44444b] hover:text-[#a0a0a7] hover:bg-[#1f1f25]',
                )}
              >
                {s[0]}
              </button>
            ))}
          </div>

          {/* Position arrows */}
          <div className="flex items-center gap-0.5">
            <button
              onClick={onMoveUp}
              disabled={isFirst}
              className="w-6 h-6 flex items-center justify-center rounded-[4px] text-[#44444b] hover:text-[#a0a0a7] hover:bg-[#1f1f25] disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
              title="Move up"
            >
              <ChevronUp size={12} />
            </button>
            <button
              onClick={onMoveDown}
              disabled={isLast}
              className="w-6 h-6 flex items-center justify-center rounded-[4px] text-[#44444b] hover:text-[#a0a0a7] hover:bg-[#1f1f25] disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
              title="Move down"
            >
              <ChevronDown size={12} />
            </button>
            <button
              onClick={onMoveLeft}
              disabled={isFirst}
              className="w-6 h-6 flex items-center justify-center rounded-[4px] text-[#44444b] hover:text-[#a0a0a7] hover:bg-[#1f1f25] disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
              title="Move left"
            >
              <ChevronLeft size={12} />
            </button>
            <button
              onClick={onMoveRight}
              disabled={isLast}
              className="w-6 h-6 flex items-center justify-center rounded-[4px] text-[#44444b] hover:text-[#a0a0a7] hover:bg-[#1f1f25] disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
              title="Move right"
            >
              <ChevronRight size={12} />
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
