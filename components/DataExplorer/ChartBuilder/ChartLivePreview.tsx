'use client'

import {
  BarChart, Bar,
  LineChart, Line,
  AreaChart, Area,
  PieChart, Pie, Cell,
  XAxis, YAxis, CartesianGrid, Tooltip, Legend,
  ResponsiveContainer,
} from 'recharts'
import { ChartType } from './ChartTypeSelector'

const COLORS = ['#7c68ff', '#4c8dff', '#4dcc88', '#f4a942', '#ff5c6c', '#4ec9c9']
const AXIS_STYLE = { fontSize: 11, fill: '#6c6c74' }
const GRID_STYLE = { stroke: '#2a2a31', strokeDasharray: '3 3' }

// ── Mock data generators ─────────────────────────────────────────────────────

function mockBarLineData(dimension: string, metric: string) {
  const labels = ['ICU', 'ER', 'Cardiology', 'Neurology', 'Oncology', 'Pediatrics', 'Surgery', 'Radiology', 'NICU', 'Pulmonology']
  return labels.map((l) => ({
    [dimension || 'department']: l,
    [metric || 'count']: Math.floor(Math.random() * 400 + 50),
  }))
}

function mockPieData(dimension: string, metric: string) {
  const labels = ['ICU', 'ER', 'Cardiology', 'Neurology', 'Oncology', 'Pediatrics']
  return labels.map((l) => ({
    [dimension || 'department']: l,
    [metric || 'count']: Math.floor(Math.random() * 300 + 50),
  }))
}

function mockTableData(dimensions: string[], metrics: string[]) {
  const rows = ['ICU', 'ER', 'Cardiology', 'Neurology', 'Oncology', 'Pediatrics', 'Surgery', 'Radiology', 'NICU', 'Pulmonology']
  return rows.map((dept) => {
    const row: Record<string, unknown> = {}
    dimensions.forEach((d, i) => {
      const vals: Record<string, string[]> = {
        department: ['ICU', 'ER', 'Cardiology', 'Neurology', 'Oncology', 'Pediatrics', 'Surgery', 'Radiology', 'NICU', 'Pulmonology'],
        hospital_name: ['General Hospital', 'City Medical', 'St. Mary\'s', 'University Hospital'],
        unit: ['Unit A', 'Unit B', 'Unit C'],
        status: ['Active', 'Pending', 'Closed'],
        patient_name: ['J. Smith', 'A. Jones', 'M. Lee', 'P. Wang'],
      }
      row[d] = i === 0 ? dept : (vals[d]?.[Math.floor(Math.random() * (vals[d]?.length ?? 3))] ?? 'N/A')
    })
    metrics.forEach((m) => { row[m] = Math.floor(Math.random() * 500 + 10) })
    return row
  })
}

// ── Custom tooltip ────────────────────────────────────────────────────────────
function CustomTooltip({ active, payload, label }: {
  active?: boolean
  payload?: Array<{ name: string; value: unknown; color: string }>
  label?: string
}) {
  if (!active || !payload?.length) return null
  return (
    <div className="bg-[#1b1b20] border border-[#3a3a45] rounded-[8px] px-3 py-2 shadow-lg">
      {label && <p className="text-[11px] text-[#6c6c74] mb-1">{label}</p>}
      {payload.map((p, i) => (
        <p key={i} className="text-[12px] font-semibold" style={{ color: p.color }}>
          {p.name}: {typeof p.value === 'number' ? p.value.toLocaleString() : String(p.value)}
        </p>
      ))}
    </div>
  )
}

// ── Chart renderers ───────────────────────────────────────────────────────────

function BarView({ data, xKey, yKey }: { data: Record<string, unknown>[]; xKey: string; yKey: string }) {
  return (
    <ResponsiveContainer width="100%" height="100%">
      <BarChart data={data} margin={{ top: 10, right: 20, left: 0, bottom: 40 }}>
        <CartesianGrid {...GRID_STYLE} />
        <XAxis dataKey={xKey} tick={AXIS_STYLE} angle={-30} textAnchor="end" interval="preserveStartEnd" />
        <YAxis tick={AXIS_STYLE} />
        <Tooltip content={<CustomTooltip />} />
        <Bar dataKey={yKey} fill={COLORS[0]} radius={[4, 4, 0, 0]} />
      </BarChart>
    </ResponsiveContainer>
  )
}

function LineView({ data, xKey, yKey }: { data: Record<string, unknown>[]; xKey: string; yKey: string }) {
  return (
    <ResponsiveContainer width="100%" height="100%">
      <LineChart data={data} margin={{ top: 10, right: 20, left: 0, bottom: 40 }}>
        <CartesianGrid {...GRID_STYLE} />
        <XAxis dataKey={xKey} tick={AXIS_STYLE} angle={-30} textAnchor="end" interval="preserveStartEnd" />
        <YAxis tick={AXIS_STYLE} />
        <Tooltip content={<CustomTooltip />} />
        <Line type="monotone" dataKey={yKey} stroke={COLORS[1]} strokeWidth={2} dot={{ r: 3, fill: COLORS[1] }} />
      </LineChart>
    </ResponsiveContainer>
  )
}

function AreaView({ data, xKey, yKey }: { data: Record<string, unknown>[]; xKey: string; yKey: string }) {
  return (
    <ResponsiveContainer width="100%" height="100%">
      <AreaChart data={data} margin={{ top: 10, right: 20, left: 0, bottom: 40 }}>
        <defs>
          <linearGradient id="liveAreaGrad" x1="0" y1="0" x2="0" y2="1">
            <stop offset="5%" stopColor={COLORS[0]} stopOpacity={0.35} />
            <stop offset="95%" stopColor={COLORS[0]} stopOpacity={0} />
          </linearGradient>
        </defs>
        <CartesianGrid {...GRID_STYLE} />
        <XAxis dataKey={xKey} tick={AXIS_STYLE} angle={-30} textAnchor="end" interval="preserveStartEnd" />
        <YAxis tick={AXIS_STYLE} />
        <Tooltip content={<CustomTooltip />} />
        <Area type="monotone" dataKey={yKey} stroke={COLORS[0]} strokeWidth={2} fill="url(#liveAreaGrad)" />
      </AreaChart>
    </ResponsiveContainer>
  )
}

function PieView({ data, nameKey, valueKey }: { data: Record<string, unknown>[]; nameKey: string; valueKey: string }) {
  return (
    <ResponsiveContainer width="100%" height="100%">
      <PieChart>
        <Pie
          data={data}
          dataKey={valueKey}
          nameKey={nameKey}
          cx="50%"
          cy="50%"
          outerRadius="70%"
          paddingAngle={2}
          label={({ name, percent }: { name?: string; percent?: number }) =>
            `${name ?? ''} ${((percent ?? 0) * 100).toFixed(0)}%`
          }
          labelLine={false}
        >
          {data.map((_, i) => <Cell key={i} fill={COLORS[i % COLORS.length]} />)}
        </Pie>
        <Tooltip formatter={(v) => (typeof v === 'number' ? v.toLocaleString() : String(v))} />
        <Legend wrapperStyle={{ fontSize: 11, color: '#a0a0a7' }} />
      </PieChart>
    </ResponsiveContainer>
  )
}

function BigNumberView({ value, label }: { value: number; label: string }) {
  const formatted = value >= 1_000_000
    ? `${(value / 1_000_000).toFixed(1)}M`
    : value >= 1_000
    ? `${(value / 1_000).toFixed(1)}K`
    : value.toLocaleString()
  return (
    <div className="flex flex-col items-center justify-center h-full gap-3">
      <p className="text-[13px] text-[#6c6c74] font-medium uppercase tracking-wider">{label || 'Total'}</p>
      <p className="text-[64px] font-black leading-none" style={{ color: COLORS[2] }}>
        {formatted}
      </p>
      <p className="text-[11px] text-[#44444b]">Mock aggregate value</p>
    </div>
  )
}

function TableView({ data, columns }: { data: Record<string, unknown>[]; columns: string[] }) {
  return (
    <div className="overflow-auto h-full">
      <table className="w-full text-left">
        <thead>
          <tr className="border-b border-[#2a2a31] bg-[#111114] sticky top-0">
            {columns.map((col) => (
              <th key={col} className="px-3 py-2 text-[10px] font-semibold text-[#6c6c74] uppercase tracking-wider whitespace-nowrap">
                {col}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {data.map((row, i) => (
            <tr key={i} className={`border-b border-[#1f1f25] ${i % 2 === 1 ? 'bg-[#0f0f12]' : ''} hover:bg-[#16161a] transition-colors`}>
              {columns.map((col) => (
                <td key={col} className="px-3 py-2 text-[12px] text-[#a0a0a7] whitespace-nowrap">
                  {String(row[col] ?? '—')}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

// ── Main component ────────────────────────────────────────────────────────────

type Props = {
  chartType: ChartType
  title: string
  metrics: string[]
  dimensions: string[]
}

export default function ChartLivePreview({ chartType, title, metrics, dimensions }: Props) {
  const dim0 = dimensions[0] || 'department'
  const met0 = metrics[0] || 'count'

  const hasData = metrics.length > 0 || dimensions.length > 0

  if (!hasData && chartType !== 'bigNumber') {
    return (
      <div className="flex flex-col items-center justify-center h-full gap-3 text-center px-6">
        <div className="w-12 h-12 rounded-full bg-[#16161a] border border-[#2a2a31] flex items-center justify-center">
          <span className="text-2xl">📊</span>
        </div>
        <p className="text-[13px] text-[#6c6c74]">Select a dataset and assign columns to preview your chart</p>
        <p className="text-[11px] text-[#44444b]">Assign at least one Metric or Dimension from the left panel</p>
      </div>
    )
  }

  const chartTitle = title || 'Untitled Chart'

  const renderChart = () => {
    switch (chartType) {
      case 'bar': {
        const data = mockBarLineData(dim0, met0)
        return <BarView data={data} xKey={dim0} yKey={met0} />
      }
      case 'line': {
        const data = mockBarLineData(dim0, met0)
        return <LineView data={data} xKey={dim0} yKey={met0} />
      }
      case 'area': {
        const data = mockBarLineData(dim0, met0)
        return <AreaView data={data} xKey={dim0} yKey={met0} />
      }
      case 'pie': {
        const data = mockPieData(dim0, met0)
        return <PieView data={data} nameKey={dim0} valueKey={met0} />
      }
      case 'bigNumber': {
        const value = Math.floor(Math.random() * 50000 + 1000)
        return <BigNumberView value={value} label={met0} />
      }
      case 'table': {
        const allCols = [...dimensions, ...metrics]
        const effectiveDims = dimensions.length > 0 ? dimensions : ['department']
        const effectiveMets = metrics.length > 0 ? metrics : ['count']
        const data = mockTableData(effectiveDims, effectiveMets)
        const cols = allCols.length > 0 ? allCols : ['department', 'count']
        return <TableView data={data} columns={cols} />
      }
      default:
        return null
    }
  }

  return (
    <div className="flex flex-col h-full">
      {/* Chart title */}
      <div className="px-5 pt-4 pb-3 flex-shrink-0 border-b border-[#1f1f25]">
        <p className="text-[14px] font-semibold text-[#e8e8ea]">{chartTitle}</p>
        {(metrics.length > 0 || dimensions.length > 0) && (
          <p className="text-[11px] text-[#6c6c74] mt-0.5">
            {metrics.length > 0 && `Metrics: ${metrics.join(', ')}`}
            {metrics.length > 0 && dimensions.length > 0 && ' · '}
            {dimensions.length > 0 && `Dimensions: ${dimensions.join(', ')}`}
          </p>
        )}
      </div>

      {/* Chart area */}
      <div className="flex-1 min-h-0 px-3 py-4">
        {renderChart()}
      </div>

      <div className="px-5 py-2 border-t border-[#1f1f25] flex-shrink-0">
        <p className="text-[10px] text-[#44444b]">Live preview using mock data · Actual data will load on save</p>
      </div>
    </div>
  )
}
