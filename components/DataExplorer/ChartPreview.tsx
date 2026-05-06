'use client'

import {
  BarChart, Bar, LineChart, Line, AreaChart, Area,
  PieChart, Pie, Cell, ScatterChart, Scatter,
  XAxis, YAxis, CartesianGrid, Tooltip, Legend,
  ResponsiveContainer,
} from 'recharts'

export type ChartConfig = {
  type: 'bar' | 'line' | 'area' | 'pie' | 'donut' | 'scatter' | 'bigNumber'
  title: string
  description?: string
  xKey?: string | null
  yKey?: string | null
  categoryKey?: string | null
  valueKey?: string | null
  colorScheme?: 'blue' | 'green' | 'purple' | 'orange' | 'mixed'
}

type Props = {
  config: ChartConfig
  data: Record<string, unknown>[]
}

// ── Color palettes ───────────────────────────────────────────────────────────
const PALETTES = {
  blue:   ['#4c8dff', '#7ab3ff', '#a8d0ff', '#2c6de0', '#1a50c0'],
  green:  ['#4dcc88', '#7bdfa8', '#a9f0c8', '#2da060', '#1a7040'],
  purple: ['#7c68ff', '#a494ff', '#c8c0ff', '#5040d0', '#3020a0'],
  orange: ['#f4a942', '#f7c070', '#fad89e', '#d08020', '#a05000'],
  mixed:  ['#4c8dff', '#4dcc88', '#7c68ff', '#f4a942', '#ff5c6c', '#4ec9c9'],
}

function getPalette(scheme?: string) {
  return PALETTES[(scheme as keyof typeof PALETTES) || 'mixed']
}

// ── Shared chart styles ──────────────────────────────────────────────────────
const AXIS_STYLE = { fontSize: 11, fill: '#6c6c74' }
const GRID_STYLE = { stroke: '#2a2a31', strokeDasharray: '3 3' }

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

// ── Bar chart ────────────────────────────────────────────────────────────────
function BarChartView({ config, data }: Props) {
  const colors = getPalette(config.colorScheme)
  const xKey = config.xKey || Object.keys(data[0] || {})[0]
  const yKey = config.yKey || Object.keys(data[0] || {})[1]
  return (
    <ResponsiveContainer width="100%" height="100%">
      <BarChart data={data} margin={{ top: 10, right: 20, left: 0, bottom: 40 }}>
        <CartesianGrid {...GRID_STYLE} />
        <XAxis dataKey={xKey} tick={AXIS_STYLE} angle={-30} textAnchor="end" interval="preserveStartEnd" />
        <YAxis tick={AXIS_STYLE} />
        <Tooltip content={<CustomTooltip />} />
        <Bar dataKey={yKey!} fill={colors[0]} radius={[4, 4, 0, 0]} />
      </BarChart>
    </ResponsiveContainer>
  )
}

// ── Line chart ───────────────────────────────────────────────────────────────
function LineChartView({ config, data }: Props) {
  const colors = getPalette(config.colorScheme)
  const xKey = config.xKey || Object.keys(data[0] || {})[0]
  const yKey = config.yKey || Object.keys(data[0] || {})[1]
  return (
    <ResponsiveContainer width="100%" height="100%">
      <LineChart data={data} margin={{ top: 10, right: 20, left: 0, bottom: 40 }}>
        <CartesianGrid {...GRID_STYLE} />
        <XAxis dataKey={xKey} tick={AXIS_STYLE} angle={-30} textAnchor="end" interval="preserveStartEnd" />
        <YAxis tick={AXIS_STYLE} />
        <Tooltip content={<CustomTooltip />} />
        <Line type="monotone" dataKey={yKey!} stroke={colors[0]} strokeWidth={2} dot={{ r: 3, fill: colors[0] }} />
      </LineChart>
    </ResponsiveContainer>
  )
}

// ── Area chart ───────────────────────────────────────────────────────────────
function AreaChartView({ config, data }: Props) {
  const colors = getPalette(config.colorScheme)
  const xKey = config.xKey || Object.keys(data[0] || {})[0]
  const yKey = config.yKey || Object.keys(data[0] || {})[1]
  return (
    <ResponsiveContainer width="100%" height="100%">
      <AreaChart data={data} margin={{ top: 10, right: 20, left: 0, bottom: 40 }}>
        <defs>
          <linearGradient id="areaGrad" x1="0" y1="0" x2="0" y2="1">
            <stop offset="5%" stopColor={colors[0]} stopOpacity={0.3} />
            <stop offset="95%" stopColor={colors[0]} stopOpacity={0} />
          </linearGradient>
        </defs>
        <CartesianGrid {...GRID_STYLE} />
        <XAxis dataKey={xKey} tick={AXIS_STYLE} angle={-30} textAnchor="end" interval="preserveStartEnd" />
        <YAxis tick={AXIS_STYLE} />
        <Tooltip content={<CustomTooltip />} />
        <Area type="monotone" dataKey={yKey!} stroke={colors[0]} strokeWidth={2} fill="url(#areaGrad)" />
      </AreaChart>
    </ResponsiveContainer>
  )
}

// ── Pie / Donut chart ────────────────────────────────────────────────────────
function PieChartView({ config, data, donut = false }: Props & { donut?: boolean }) {
  const colors = getPalette(config.colorScheme)
  const nameKey = config.categoryKey || Object.keys(data[0] || {})[0]
  const valueKey = config.valueKey || config.yKey || Object.keys(data[0] || {})[1]
  const innerRadius = donut ? '55%' : '0%'
  return (
    <ResponsiveContainer width="100%" height="100%">
      <PieChart>
        <Pie
          data={data}
          dataKey={valueKey!}
          nameKey={nameKey!}
          cx="50%"
          cy="50%"
          outerRadius="70%"
          innerRadius={innerRadius}
          paddingAngle={donut ? 3 : 1}
          label={({ name, percent }) => `${name} ${((percent ?? 0) * 100).toFixed(0)}%`}
          labelLine={false}
        >
          {data.map((_, i) => (
            <Cell key={i} fill={colors[i % colors.length]} />
          ))}
        </Pie>
        <Tooltip formatter={(v) => (typeof v === 'number' ? v.toLocaleString() : String(v))} />
        <Legend wrapperStyle={{ fontSize: 11, color: '#a0a0a7' }} />
      </PieChart>
    </ResponsiveContainer>
  )
}

// ── Scatter chart ────────────────────────────────────────────────────────────
function ScatterChartView({ config, data }: Props) {
  const colors = getPalette(config.colorScheme)
  const xKey = config.xKey || Object.keys(data[0] || {})[0]
  const yKey = config.yKey || Object.keys(data[0] || {})[1]
  return (
    <ResponsiveContainer width="100%" height="100%">
      <ScatterChart margin={{ top: 10, right: 20, left: 0, bottom: 10 }}>
        <CartesianGrid {...GRID_STYLE} />
        <XAxis dataKey={xKey} name={xKey} tick={AXIS_STYLE} />
        <YAxis dataKey={yKey} name={yKey} tick={AXIS_STYLE} />
        <Tooltip cursor={{ strokeDasharray: '3 3' }} content={<CustomTooltip />} />
        <Scatter data={data} fill={colors[0]} opacity={0.8} />
      </ScatterChart>
    </ResponsiveContainer>
  )
}

// ── Big Number ───────────────────────────────────────────────────────────────
function BigNumberView({ config, data }: Props) {
  const valueKey = config.valueKey || config.yKey || Object.keys(data[0] || {})[1]
  const colors = getPalette(config.colorScheme)

  // Sum or use first row
  const total = data.reduce((acc, row) => {
    const v = row[valueKey!]
    return acc + (typeof v === 'number' ? v : parseFloat(String(v)) || 0)
  }, 0)

  const formatted = total >= 1_000_000
    ? `${(total / 1_000_000).toFixed(1)}M`
    : total >= 1_000
    ? `${(total / 1_000).toFixed(1)}K`
    : total.toLocaleString()

  return (
    <div className="flex flex-col items-center justify-center h-full gap-2">
      <p className="text-[13px] text-[#6c6c74] font-medium">{config.title}</p>
      <p className="text-[52px] font-black leading-none" style={{ color: colors[0] }}>
        {formatted}
      </p>
      {config.description && (
        <p className="text-[12px] text-[#44444b] text-center max-w-[200px]">
          {config.description}
        </p>
      )}
    </div>
  )
}

// ── Main export ──────────────────────────────────────────────────────────────
export function ChartPreview({ config, data }: Props) {
  if (!data || data.length === 0) return (
    <div className="flex items-center justify-center h-full text-[#44444b] text-[12px]">
      No data to chart
    </div>
  )

  const chart = () => {
    switch (config.type) {
      case 'bar':       return <BarChartView config={config} data={data} />
      case 'line':      return <LineChartView config={config} data={data} />
      case 'area':      return <AreaChartView config={config} data={data} />
      case 'pie':       return <PieChartView config={config} data={data} />
      case 'donut':     return <PieChartView config={config} data={data} donut />
      case 'scatter':   return <ScatterChartView config={config} data={data} />
      case 'bigNumber': return <BigNumberView config={config} data={data} />
      default:          return <BarChartView config={config} data={data} />
    }
  }

  return (
    <div className="flex flex-col h-full">
      {config.type !== 'bigNumber' && (
        <div className="px-4 pt-3 pb-1 flex-shrink-0">
          <p className="text-[13px] font-semibold text-[#e8e8ea]">{config.title}</p>
          {config.description && (
            <p className="text-[11px] text-[#6c6c74] mt-0.5">{config.description}</p>
          )}
        </div>
      )}
      <div className="flex-1 min-h-0 px-2 pb-3">
        {chart()}
      </div>
    </div>
  )
}
