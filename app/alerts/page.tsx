'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'
import { Plus, Bell, Trash2, ToggleLeft, ToggleRight, AlertTriangle, Info, Zap } from 'lucide-react'
import { clsx } from 'clsx'
import DataNav from '@/components/DataNav'
import {
  Alert,
  getAlerts,
  deleteAlert,
  toggleAlertStatus,
} from '@/lib/alertStore'
import { SkeletonTable } from '@/components/Skeleton'

const severityConfig = {
  Low: { label: 'Low', color: 'text-[#4c8dff]', bg: 'bg-[#4c8dff15]', border: 'border-[#4c8dff40]', icon: Info },
  Medium: { label: 'Medium', color: 'text-[#f59e0b]', bg: 'bg-[#f59e0b15]', border: 'border-[#f59e0b40]', icon: AlertTriangle },
  Critical: { label: 'Critical', color: 'text-[#ff5c6c]', bg: 'bg-[#ff5c6c15]', border: 'border-[#ff5c6c40]', icon: Zap },
}

function formatLastTriggered(ts?: string): string {
  if (!ts) return 'Never'
  const d = new Date(ts)
  const diff = Date.now() - d.getTime()
  const mins = Math.floor(diff / 60000)
  if (mins < 60) return `${mins}m ago`
  const hours = Math.floor(mins / 60)
  if (hours < 24) return `${hours}h ago`
  return `${Math.floor(hours / 24)}d ago`
}

export default function AlertsPage() {
  const [alerts, setAlerts] = useState<Alert[]>([])
  // QA fix: track loading state to show skeleton while localStorage hydrates on client
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    setAlerts(getAlerts())
    setLoading(false)
  }, [])

  function handleDelete(id: string) {
    deleteAlert(id)
    setAlerts(getAlerts())
  }

  function handleToggle(id: string) {
    toggleAlertStatus(id)
    setAlerts(getAlerts())
  }

  return (
    <div className="flex flex-col h-screen bg-[#0d0d10] text-[#e8e8ea]">
      <DataNav activePage="alerts" />

      <div className="flex-1 overflow-auto px-6 py-6">
        {/* Header */}
        <div className="flex items-center justify-between mb-6">
          <div className="flex items-center gap-3">
            <div className="w-8 h-8 rounded-[10px] bg-[#7c68ff20] border border-[#7c68ff40] flex items-center justify-center">
              <Bell size={15} className="text-[#7c68ff]" />
            </div>
            <div>
              <h1 className="text-[18px] font-bold text-[#e8e8ea]">Threshold Alerts</h1>
              <p className="text-[12px] text-[#6c6c74]">{alerts.length} alert{alerts.length !== 1 ? 's' : ''} configured</p>
            </div>
          </div>
          <Link
            href="/alerts/new"
            className="flex items-center gap-2 px-4 py-2 rounded-[10px] bg-[#7c68ff] text-white text-[13px] font-semibold hover:bg-[#8f7dff] transition-all shadow-[0_2px_12px_rgba(124,104,255,0.4)]"
          >
            <Plus size={14} />
            New Alert
          </Link>
        </div>

        {/* Loading skeleton */}
        {loading && (
          <div className="bg-[#111114] border border-[#2a2a31] rounded-[14px] overflow-hidden">
            <SkeletonTable rows={4} />
          </div>
        )}

        {/* Empty state */}
        {!loading && alerts.length === 0 && (
          <div className="flex flex-col items-center justify-center py-24 gap-4">
            <div className="w-16 h-16 rounded-2xl bg-[#16161a] border border-[#2a2a31] flex items-center justify-center">
              <Bell size={28} className="text-[#2a2a31]" />
            </div>
            <p className="text-[14px] text-[#44444b]">No alerts configured yet</p>
            <Link
              href="/alerts/new"
              className="flex items-center gap-2 px-4 py-2 rounded-[10px] bg-[#7c68ff20] border border-[#7c68ff40] text-[#7c68ff] text-[13px] font-semibold hover:bg-[#7c68ff30] transition-all"
            >
              <Plus size={13} />
              Create your first alert
            </Link>
          </div>
        )}

        {/* Alerts table */}
        {!loading && alerts.length > 0 && (
          <div className="bg-[#111114] border border-[#2a2a31] rounded-[14px] overflow-hidden">
            {/* Table header */}
            <div className="grid grid-cols-[2fr_2fr_1.5fr_1fr_1fr_1fr_auto] gap-4 px-5 py-3 bg-[#16161a] border-b border-[#2a2a31]">
              {['Name', 'Condition', 'Channels', 'Severity', 'Last Triggered', 'Status', ''].map((h) => (
                <span key={h} className="text-[10px] font-semibold text-[#44444b] uppercase tracking-wider">{h}</span>
              ))}
            </div>

            {/* Rows */}
            {alerts.map((alert) => {
              const sev = severityConfig[alert.severity]
              const SevIcon = sev.icon
              return (
                <div
                  key={alert.id}
                  className="grid grid-cols-[2fr_2fr_1.5fr_1fr_1fr_1fr_auto] gap-4 items-center px-5 py-4 border-b border-[#1f1f25] last:border-b-0 hover:bg-[#13131a] transition-colors"
                >
                  {/* Name */}
                  <span className="text-[13px] font-medium text-[#e8e8ea] truncate">{alert.name}</span>

                  {/* Condition */}
                  <div className="flex items-center gap-1.5">
                    <span className="text-[12px] text-[#a0a0a7] truncate">
                      {alert.metric} {alert.operator} {alert.value}
                    </span>
                  </div>

                  {/* Channels */}
                  <div className="flex flex-wrap gap-1">
                    {alert.channels.map((ch) => (
                      <span
                        key={ch}
                        className="px-2 py-0.5 rounded-[5px] bg-[#1f1f25] border border-[#2a2a31] text-[10px] text-[#6c6c74]"
                      >
                        {ch}
                      </span>
                    ))}
                  </div>

                  {/* Severity chip */}
                  <div className={clsx('flex items-center gap-1.5 px-2.5 py-1 rounded-[7px] border w-fit', sev.bg, sev.border)}>
                    <SevIcon size={10} className={sev.color} />
                    <span className={clsx('text-[11px] font-semibold', sev.color)}>{alert.severity}</span>
                  </div>

                  {/* Last triggered */}
                  <span className="text-[12px] text-[#6c6c74]">{formatLastTriggered(alert.lastTriggered)}</span>

                  {/* Status toggle */}
                  <button
                    onClick={() => handleToggle(alert.id)}
                    className="flex items-center gap-1.5 group"
                    title={alert.status === 'Active' ? 'Pause alert' : 'Activate alert'}
                  >
                    {alert.status === 'Active' ? (
                      <>
                        <ToggleRight size={22} className="text-[#4dcc88] group-hover:text-[#5fdb97] transition-colors" />
                        <span className="text-[11px] text-[#4dcc88] font-medium">Active</span>
                      </>
                    ) : (
                      <>
                        <ToggleLeft size={22} className="text-[#44444b] group-hover:text-[#6c6c74] transition-colors" />
                        <span className="text-[11px] text-[#44444b] font-medium">Paused</span>
                      </>
                    )}
                  </button>

                  {/* Delete */}
                  <button
                    onClick={() => handleDelete(alert.id)}
                    className="w-7 h-7 flex items-center justify-center rounded-[7px] bg-[#16161a] border border-[#2a2a31] text-[#44444b] hover:text-[#ff5c6c] hover:border-[#ff5c6c40] hover:bg-[#ff5c6c10] transition-all"
                    title="Delete alert"
                  >
                    <Trash2 size={12} />
                  </button>
                </div>
              )
            })}
          </div>
        )}
      </div>
    </div>
  )
}
