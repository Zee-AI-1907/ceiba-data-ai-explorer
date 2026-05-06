'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'
import { Plus, FileText, Trash2, Clock, Mail, Send } from 'lucide-react'
import { clsx } from 'clsx'
import DataNav from '@/components/DataNav'
import { ScheduledReport, getReports, deleteReport } from '@/lib/reportStore'
import { SkeletonCard } from '@/components/Skeleton'

function formatNextDelivery(iso: string): string {
  const d = new Date(iso)
  const now = new Date()
  const diff = d.getTime() - now.getTime()
  if (diff < 0) return 'Overdue'
  const hours = Math.floor(diff / 3600000)
  if (hours < 1) {
    const mins = Math.floor(diff / 60000)
    return `in ${mins}m`
  }
  if (hours < 24) return `in ${hours}h`
  const days = Math.floor(hours / 24)
  return `in ${days}d`
}

const formatColors: Record<string, string> = {
  PDF: 'text-[#ff5c6c] bg-[#ff5c6c15] border-[#ff5c6c40]',
  PNG: 'text-[#4c8dff] bg-[#4c8dff15] border-[#4c8dff40]',
  Excel: 'text-[#4dcc88] bg-[#4dcc8815] border-[#4dcc8840]',
}

export default function ReportsPage() {
  const [reports, setReports] = useState<ScheduledReport[]>([])
  // QA fix: track loading state to show skeleton while localStorage hydrates on client
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    setReports(getReports())
    setLoading(false)
  }, [])

  function handleDelete(id: string) {
    deleteReport(id)
    setReports(getReports())
  }

  return (
    <div className="flex flex-col h-screen bg-[#0d0d10] text-[#e8e8ea]">
      <DataNav activePage="reports" />

      <div className="flex-1 overflow-auto px-6 py-6">
        {/* Header */}
        <div className="flex items-center justify-between mb-6">
          <div className="flex items-center gap-3">
            <div className="w-8 h-8 rounded-[10px] bg-[#4c8dff20] border border-[#4c8dff40] flex items-center justify-center">
              <FileText size={15} className="text-[#4c8dff]" />
            </div>
            <div>
              <h1 className="text-[18px] font-bold text-[#e8e8ea]">Scheduled Reports</h1>
              <p className="text-[12px] text-[#6c6c74]">{reports.length} report{reports.length !== 1 ? 's' : ''} scheduled</p>
            </div>
          </div>
          <Link
            href="/reports/new"
            className="flex items-center gap-2 px-4 py-2 rounded-[10px] bg-[#4c8dff] text-white text-[13px] font-semibold hover:bg-[#6aa3ff] transition-all shadow-[0_2px_12px_rgba(76,141,255,0.4)]"
          >
            <Plus size={14} />
            New Report
          </Link>
        </div>

        {/* Loading skeleton */}
        {loading && (
          <div className="grid grid-cols-1 gap-3">
            {[1, 2, 3].map((i) => <SkeletonCard key={i} />)}
          </div>
        )}

        {/* Empty state */}
        {!loading && reports.length === 0 && (
          <div className="flex flex-col items-center justify-center py-24 gap-4">
            <div className="w-16 h-16 rounded-2xl bg-[#16161a] border border-[#2a2a31] flex items-center justify-center">
              <FileText size={28} className="text-[#2a2a31]" />
            </div>
            <p className="text-[14px] text-[#44444b]">No reports scheduled yet</p>
            <Link
              href="/reports/new"
              className="flex items-center gap-2 px-4 py-2 rounded-[10px] bg-[#4c8dff20] border border-[#4c8dff40] text-[#4c8dff] text-[13px] font-semibold hover:bg-[#4c8dff30] transition-all"
            >
              <Plus size={13} />
              Schedule your first report
            </Link>
          </div>
        )}

        {/* Reports list */}
        {!loading && reports.length > 0 && (
          <div className="space-y-3">
            {reports.map((report) => (
              <div
                key={report.id}
                className="bg-[#111114] border border-[#2a2a31] rounded-[14px] p-5 hover:border-[#3a3a45] transition-all"
              >
                <div className="flex items-start justify-between gap-4">
                  {/* Left */}
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 mb-2">
                      <span className="text-[14px] font-semibold text-[#e8e8ea]">{report.name}</span>
                      <span className={clsx('px-2 py-0.5 rounded-[5px] border text-[10px] font-semibold', formatColors[report.format])}>
                        {report.format}
                      </span>
                    </div>

                    {/* Meta row */}
                    <div className="flex flex-wrap items-center gap-3 text-[12px] text-[#6c6c74]">
                      <span className="flex items-center gap-1.5">
                        <Clock size={11} className="text-[#44444b]" />
                        {report.frequency} at {String(report.hour).padStart(2, '0')}:{String(report.minute).padStart(2, '0')}
                      </span>
                      <span className="text-[#2a2a31]">·</span>
                      <span className="flex items-center gap-1">
                        {report.deliveries.map((d) => (
                          <span key={d} className="flex items-center gap-1">
                            {d === 'Email' ? <Mail size={10} /> : <Send size={10} />}
                            {d}
                          </span>
                        ))}
                      </span>
                      <span className="text-[#2a2a31]">·</span>
                      <span className="text-[#44444b]">{report.dashboards.length} dashboard{report.dashboards.length !== 1 ? 's' : ''}</span>
                    </div>

                    {/* Dashboards chips */}
                    <div className="flex flex-wrap gap-1.5 mt-3">
                      {report.dashboards.map((d) => (
                        <span
                          key={d}
                          className="px-2 py-0.5 rounded-[5px] bg-[#1f1f25] border border-[#2a2a31] text-[10px] text-[#6c6c74]"
                        >
                          {d}
                        </span>
                      ))}
                    </div>
                  </div>

                  {/* Right */}
                  <div className="flex flex-col items-end gap-3 flex-shrink-0">
                    <button
                      onClick={() => handleDelete(report.id)}
                      className="w-7 h-7 flex items-center justify-center rounded-[7px] bg-[#16161a] border border-[#2a2a31] text-[#44444b] hover:text-[#ff5c6c] hover:border-[#ff5c6c40] hover:bg-[#ff5c6c10] transition-all"
                      title="Delete report"
                    >
                      <Trash2 size={12} />
                    </button>
                    <div className="flex flex-col items-end gap-0.5">
                      <span className="text-[10px] text-[#44444b] uppercase tracking-wider">Next delivery</span>
                      <span className="text-[12px] font-semibold text-[#4dcc88]">
                        {formatNextDelivery(report.nextDelivery)}
                      </span>
                    </div>
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
