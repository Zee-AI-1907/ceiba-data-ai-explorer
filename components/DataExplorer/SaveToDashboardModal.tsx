'use client'

import { useState, useEffect } from 'react'
import { X, Plus, LayoutDashboard } from 'lucide-react'
import { getDashboards, saveDashboard, type Dashboard, type SavedChart } from '@/lib/store'

type Props = {
  chart: SavedChart
  onClose: () => void
  onAdded: (dashboardName: string) => void
}

export function SaveToDashboardModal({ chart, onClose, onAdded }: Props) {
  const [dashboards, setDashboards] = useState<Dashboard[]>([])
  const [newName, setNewName] = useState('')
  const [showNewInput, setShowNewInput] = useState(false)

  useEffect(() => {
    setDashboards(getDashboards())
  }, [])

  const addToDashboard = (dashboard: Dashboard) => {
    const alreadyExists = dashboard.charts.some((c) => c.id === chart.id)
    const updated: Dashboard = {
      ...dashboard,
      charts: alreadyExists ? dashboard.charts : [...dashboard.charts, chart],
      updatedAt: new Date().toISOString(),
    }
    saveDashboard(updated)
    onAdded(dashboard.name)
    onClose()
  }

  const createAndAdd = () => {
    const name = newName.trim()
    if (!name) return
    const newDashboard: Dashboard = {
      id: String(Date.now()),
      name,
      status: 'Draft',
      charts: [chart],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      owner: 'You',
    }
    saveDashboard(newDashboard)
    onAdded(name)
    onClose()
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
      <div className="bg-[#16161a] border border-[#2a2a31] rounded-[12px] w-[380px] max-h-[480px] flex flex-col shadow-2xl">
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-[#2a2a31]">
          <div className="flex items-center gap-2">
            <LayoutDashboard size={15} className="text-[#7c68ff]" />
            <span className="text-[14px] font-semibold text-[#e8e8ea]">Add to Dashboard</span>
          </div>
          <button
            onClick={onClose}
            className="w-6 h-6 flex items-center justify-center rounded-[6px] text-[#6c6c74] hover:text-[#a0a0a7] hover:bg-[#1f1f25] transition-colors"
          >
            <X size={13} />
          </button>
        </div>

        {/* Chart preview info */}
        <div className="px-5 py-3 border-b border-[#2a2a31] bg-[#111114]">
          <p className="text-[11px] text-[#6c6c74] mb-0.5">Adding chart:</p>
          <p className="text-[13px] font-medium text-[#e8e8ea]">{chart.title}</p>
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto px-5 py-4 flex flex-col gap-2">
          {/* Create New Dashboard option */}
          {!showNewInput ? (
            <button
              onClick={() => setShowNewInput(true)}
              className="flex items-center gap-2 w-full px-3.5 py-3 rounded-[10px] border border-dashed border-[#3a3a45] text-[12px] text-[#7c68ff] hover:border-[#7c68ff60] hover:bg-[#7c68ff08] transition-all"
            >
              <Plus size={13} />
              <span className="font-medium">Create New Dashboard</span>
            </button>
          ) : (
            <div className="flex gap-2">
              <input
                autoFocus
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && createAndAdd()}
                placeholder="Dashboard name…"
                className="flex-1 px-3 py-2 rounded-[8px] bg-[#111114] border border-[#2a2a31] text-[12px] text-[#e8e8ea] placeholder-[#44444b] outline-none focus:border-[#7c68ff60]"
              />
              <button
                onClick={createAndAdd}
                disabled={!newName.trim()}
                className="px-3 py-2 rounded-[8px] bg-[#7c68ff] text-white text-[12px] font-semibold hover:bg-[#9080ff] disabled:opacity-40 disabled:cursor-not-allowed transition-all"
              >
                Create
              </button>
              <button
                onClick={() => { setShowNewInput(false); setNewName('') }}
                className="px-2 py-2 rounded-[8px] text-[#6c6c74] hover:text-[#a0a0a7] transition-colors"
              >
                <X size={13} />
              </button>
            </div>
          )}

          {/* Existing dashboards */}
          {dashboards.length > 0 && (
            <div className="flex flex-col gap-1.5 mt-1">
              <p className="text-[10px] font-semibold text-[#44444b] uppercase tracking-wider mb-1">
                Existing Dashboards
              </p>
              {dashboards.map((d) => (
                <button
                  key={d.id}
                  onClick={() => addToDashboard(d)}
                  className="flex items-center justify-between w-full px-3.5 py-2.5 rounded-[10px] bg-[#111114] border border-[#2a2a31] hover:border-[#7c68ff40] hover:bg-[#1b1b20] transition-all group"
                >
                  <div className="flex items-center gap-2.5">
                    <LayoutDashboard size={13} className="text-[#6c6c74] group-hover:text-[#7c68ff] transition-colors" />
                    <span className="text-[12px] text-[#a0a0a7] group-hover:text-[#e8e8ea] transition-colors font-medium">
                      {d.name}
                    </span>
                  </div>
                  <div className="flex items-center gap-2">
                    <span className="text-[10px] text-[#44444b]">{d.charts.length} chart{d.charts.length !== 1 ? 's' : ''}</span>
                    <span className={`text-[10px] font-medium ${d.status === 'Published' ? 'text-[#4dcc88]' : 'text-[#6c6c74]'}`}>
                      {d.status}
                    </span>
                  </div>
                </button>
              ))}
            </div>
          )}

          {dashboards.length === 0 && !showNewInput && (
            <p className="text-[12px] text-[#44444b] text-center py-4">
              No dashboards yet. Create one above!
            </p>
          )}
        </div>
      </div>
    </div>
  )
}
