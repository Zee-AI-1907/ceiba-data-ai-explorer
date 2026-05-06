'use client'

import { useState, useEffect } from 'react'
import { useParams, useRouter } from 'next/navigation'
import DataNav from '@/components/DataNav'
import { ChartPreview } from '@/components/DataExplorer/ChartPreview'
import { getDashboards, saveDashboard, fetchDashboard, persistDashboard, type Dashboard, type SavedChart } from '@/lib/store'
import { ArrowLeft, MoreHorizontal, Trash2, Plus } from 'lucide-react'

function StatusBadge({ status }: { status: string }) {
  return status === 'Published' ? (
    <span className="px-2 py-0.5 rounded-full text-[10px] font-semibold bg-[#4dcc8820] text-[#4dcc88] border border-[#4dcc8840]">
      Published
    </span>
  ) : (
    <span className="px-2 py-0.5 rounded-full text-[10px] font-semibold bg-[#6c6c7420] text-[#6c6c74] border border-[#6c6c7440]">
      Draft
    </span>
  )
}

function ChartCard({
  chart,
  onRemove,
}: {
  chart: SavedChart
  onRemove: () => void
}) {
  const [showMenu, setShowMenu] = useState(false)

  return (
    <div className="bg-[#16161a] border border-[#2a2a31] rounded-[12px] p-4 flex flex-col gap-3">
      {/* Card header */}
      <div className="flex items-start justify-between gap-2">
        <div>
          <p className="text-[13px] font-semibold text-[#e8e8ea] leading-tight">{chart.title}</p>
          {chart.description && (
            <p className="text-[11px] text-[#6c6c74] mt-0.5">{chart.description}</p>
          )}
        </div>
        <div className="relative flex-shrink-0">
          <button
            onClick={() => setShowMenu((v) => !v)}
            className="w-6 h-6 flex items-center justify-center rounded-[6px] text-[#6c6c74] hover:text-[#a0a0a7] hover:bg-[#1f1f25] transition-colors"
          >
            <MoreHorizontal size={13} />
          </button>
          {showMenu && (
            <div className="absolute right-0 top-7 z-10 bg-[#1b1b20] border border-[#2a2a31] rounded-[8px] shadow-xl overflow-hidden min-w-[140px]">
              <button
                onClick={() => { onRemove(); setShowMenu(false) }}
                className="flex items-center gap-2 w-full px-3 py-2 text-[12px] text-[#ff5c6c] hover:bg-[#ff5c6c10] transition-colors"
              >
                <Trash2 size={12} />
                Remove from dashboard
              </button>
            </div>
          )}
        </div>
      </div>

      {/* Chart area */}
      <div style={{ height: 280 }} className="w-full">
        <ChartPreview config={chart.config} data={chart.data} />
      </div>

      {/* Footer */}
      {chart.queryName && (
        <p className="text-[10px] text-[#44444b] border-t border-[#1f1f25] pt-2">
          Source: {chart.queryName}
        </p>
      )}
    </div>
  )
}

export default function DashboardDetailPage() {
  const params = useParams()
  const router = useRouter()
  const id = params?.id as string

  const [dashboard, setDashboard] = useState<Dashboard | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    async function load() {
      // Try localStorage first for instant render
      const local = getDashboards().find((d) => d.id === id) ?? null
      if (local) {
        setDashboard(local)
        setLoading(false)
      }
      // Merge with API data (API may have more up-to-date server state)
      try {
        const remote = await fetchDashboard(id)
        if (remote) {
          // localStorage takes priority — if local exists, prefer it
          setDashboard((prev) => prev ?? remote)
        } else if (!local) {
          setDashboard(null)
        }
      } catch {
        // ignore
      } finally {
        setLoading(false)
      }
    }
    load()
  }, [id])

  const removeChart = (chartId: string) => {
    if (!dashboard) return
    const updated: Dashboard = {
      ...dashboard,
      charts: dashboard.charts.filter((c) => c.id !== chartId),
      updatedAt: new Date().toISOString(),
    }
    persistDashboard(updated)
    setDashboard(updated)
  }

  if (loading) {
    return (
      <div className="min-h-screen bg-[#0b0b0c] flex items-center justify-center">
        <div className="flex gap-1">
          {[0, 1, 2].map((i) => (
            <div
              key={i}
              className="w-2 h-2 rounded-full bg-[#7c68ff] animate-bounce"
              style={{ animationDelay: `${i * 0.15}s` }}
            />
          ))}
        </div>
      </div>
    )
  }

  if (!dashboard) {
    return (
      <div className="min-h-screen bg-[#0b0b0c] text-[#e8e8ea] flex flex-col">
        <DataNav activePage="dashboards" />
        <div className="flex-1 flex flex-col items-center justify-center gap-4">
          <p className="text-[16px] font-semibold text-[#e8e8ea]">Dashboard not found</p>
          <p className="text-[12px] text-[#6c6c74]">This dashboard may have been deleted or doesn&apos;t exist.</p>
          <button
            onClick={() => router.push('/dashboards')}
            className="flex items-center gap-1.5 px-4 py-2 rounded-[8px] bg-[#7c68ff] text-white text-[13px] font-semibold hover:bg-[#9080ff] transition-all"
          >
            <ArrowLeft size={13} />
            Back to Dashboards
          </button>
        </div>
      </div>
    )
  }

  return (
    <div className="min-h-screen bg-[#0b0b0c] text-[#e8e8ea] flex flex-col">
      <DataNav activePage="dashboards" />

      {/* Header */}
      <div className="flex items-center justify-between px-6 py-4 border-b border-[#1f1f25]">
        <div className="flex items-center gap-3">
          <button
            onClick={() => router.push('/dashboards')}
            className="w-7 h-7 flex items-center justify-center rounded-[7px] text-[#6c6c74] hover:text-[#a0a0a7] hover:bg-[#16161a] transition-colors"
          >
            <ArrowLeft size={14} />
          </button>
          <div className="flex items-center gap-2.5">
            <h1 className="text-[17px] font-semibold text-[#e8e8ea]">{dashboard.name}</h1>
            <StatusBadge status={dashboard.status} />
          </div>
        </div>
        <div className="flex items-center gap-2">
          <span className="text-[11px] text-[#44444b]">
            {dashboard.charts.length} chart{dashboard.charts.length !== 1 ? 's' : ''}
          </span>
          <button
            onClick={() => router.push('/data-explorer')}
            className="flex items-center gap-1.5 px-3 py-1.5 text-[12px] font-semibold text-white rounded-[8px] bg-[#7c68ff] hover:bg-[#9080ff] shadow-[0_2px_10px_rgba(124,104,255,0.3)] transition-all"
          >
            <Plus size={13} />
            Add Chart
          </button>
          <button className="px-3 py-1.5 text-[12px] font-medium text-[#a0a0a7] border border-[#2a2a31] rounded-[8px] hover:bg-[#16161a] hover:text-[#e8e8ea] transition-colors">
            EDIT
          </button>
        </div>
      </div>

      {/* Content */}
      <div className="flex-1 px-6 py-5">
        {dashboard.charts.length === 0 ? (
          <div className="flex flex-col items-center justify-center gap-4 py-20 text-center">
            <div className="w-14 h-14 rounded-2xl bg-[#16161a] border border-[#2a2a31] flex items-center justify-center">
              <Plus size={22} className="text-[#44444b]" />
            </div>
            <p className="text-[15px] font-semibold text-[#e8e8ea]">No charts yet</p>
            <p className="text-[12px] text-[#6c6c74] max-w-[280px]">
              Go to SQL Lab to create some. After running a query and generating a chart, hit &quot;Save Chart&quot; then &quot;Add to Dashboard&quot;.
            </p>
            <button
              onClick={() => router.push('/data-explorer')}
              className="flex items-center gap-1.5 px-4 py-2 rounded-[8px] bg-[#7c68ff] text-white text-[13px] font-semibold hover:bg-[#9080ff] transition-all"
            >
              Go to SQL Lab
            </button>
          </div>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
            {dashboard.charts.map((chart) => (
              <ChartCard
                key={chart.id}
                chart={chart}
                onRemove={() => removeChart(chart.id)}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
