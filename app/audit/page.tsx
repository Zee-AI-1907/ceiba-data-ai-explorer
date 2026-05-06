'use client'

import { useEffect, useState, useCallback } from 'react'
import { clsx } from 'clsx'
import { ShieldCheck, Download, RefreshCw, ChevronLeft, ChevronRight } from 'lucide-react'
import type { AuditEvent, AuditAction, AuditSeverity } from '@/lib/auditLog'

// ── Constants ─────────────────────────────────────────────────────────────────

const PAGE_SIZE = 50

// Severity colours
const severityStyle: Record<AuditSeverity, string> = {
  INFO: 'bg-[#2a2a31] text-[#a0a0a7] border border-[#3a3a45]',
  WARNING: 'bg-[#f59e0b20] text-[#f59e0b] border border-[#f59e0b40]',
  CRITICAL: 'bg-[#ff5c6c20] text-[#ff5c6c] border border-[#ff5c6c40]',
}

// Action badge colours
const actionStyle: Partial<Record<AuditAction, string>> = {
  QUERY_RUN: 'bg-[#4c8dff20] text-[#4c8dff] border border-[#4c8dff40]',
  DATA_VIEW: 'bg-[#7c68ff20] text-[#7c68ff] border border-[#7c68ff40]',
  NARRATIVE_GENERATED: 'bg-[#f59e0b20] text-[#f59e0b] border border-[#f59e0b40]',
  DATA_EXPORT_CSV: 'bg-[#4dcc8820] text-[#4dcc88] border border-[#4dcc8840]',
  DATA_EXPORT_EXCEL: 'bg-[#4dcc8820] text-[#4dcc88] border border-[#4dcc8840]',
  QUERY_FAILED: 'bg-[#ff5c6c20] text-[#ff5c6c] border border-[#ff5c6c40]',
  LOGIN: 'bg-[#4dcc8820] text-[#4dcc88] border border-[#4dcc8840]',
  LOGOUT: 'bg-[#2a2a31] text-[#a0a0a7] border border-[#3a3a45]',
  LOGIN_FAILED: 'bg-[#ff5c6c20] text-[#ff5c6c] border border-[#ff5c6c40]',
}

function formatTs(iso: string): string {
  try {
    return new Date(iso).toLocaleString('en-US', {
      month: 'short',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: false,
    })
  } catch {
    return iso
  }
}

function eventsToCSV(events: AuditEvent[]): string {
  const headers = ['id', 'timestamp', 'userId', 'userEmail', 'action', 'resourceType', 'detail', 'rowsAffected', 'ipAddress', 'severity']
  const rows = events.map((e) =>
    headers.map((h) => {
      const v = e[h as keyof AuditEvent]
      if (v === undefined || v === null) return ''
      return `"${String(v).replace(/"/g, '""')}"`
    }).join(',')
  )
  return [headers.join(','), ...rows].join('\n')
}

// ── Component ─────────────────────────────────────────────────────────────────

export default function AuditLogPage() {
  const [events, setEvents] = useState<AuditEvent[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [page, setPage] = useState(1)

  const fetchEvents = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const res = await fetch('/api/audit')
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const data = await res.json()
      setEvents(Array.isArray(data.events) ? data.events : [])
      setPage(1)
    } catch (e) {
      setError(String(e))
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    fetchEvents()
  }, [fetchEvents])

  const totalPages = Math.max(1, Math.ceil(events.length / PAGE_SIZE))
  const pageEvents = events.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE)

  function handleExportCSV() {
    const csv = eventsToCSV(events)
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `ceiba-audit-log-${new Date().toISOString().slice(0, 10)}.csv`
    a.click()
    URL.revokeObjectURL(url)
  }

  return (
    <div className="min-h-screen bg-[#0b0b0c] text-[#e8e8ea] p-6">
      {/* Header */}
      <div className="flex items-center justify-between mb-6 flex-wrap gap-3">
        <div className="flex items-center gap-3">
          <div className="w-8 h-8 rounded-[8px] bg-[#f59e0b20] border border-[#f59e0b40] flex items-center justify-center">
            <ShieldCheck size={15} className="text-[#f59e0b]" />
          </div>
          <div>
            <h1 className="text-[18px] font-bold text-[#e8e8ea]">Audit Log</h1>
            <p className="text-[11px] text-[#6c6c74]">HIPAA access log — all PHI data access events</p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={fetchEvents}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-[8px] bg-[#16161a] border border-[#2a2a31] text-[11px] text-[#a0a0a7] hover:text-[#e8e8ea] hover:border-[#3a3a45] transition-all"
          >
            <RefreshCw size={11} className={loading ? 'animate-spin' : ''} />
            Refresh
          </button>
          <button
            onClick={handleExportCSV}
            disabled={events.length === 0}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-[8px] bg-[#7c68ff] text-white text-[11px] font-semibold hover:bg-[#9080ff] disabled:opacity-40 disabled:cursor-not-allowed transition-all shadow-[0_2px_8px_rgba(124,104,255,0.3)]"
          >
            <Download size={11} />
            Export CSV
          </button>
        </div>
      </div>

      {/* Stats chips */}
      <div className="flex gap-3 mb-5 flex-wrap">
        {(['INFO', 'WARNING', 'CRITICAL'] as AuditSeverity[]).map((sev) => {
          const count = events.filter((e) => e.severity === sev).length
          return (
            <div key={sev} className={clsx('flex items-center gap-2 px-3 py-1.5 rounded-[8px] text-[11px] font-semibold', severityStyle[sev])}>
              {sev}: {count}
            </div>
          )
        })}
        <div className="px-3 py-1.5 rounded-[8px] text-[11px] text-[#6c6c74] bg-[#16161a] border border-[#2a2a31]">
          Total: {events.length}
        </div>
      </div>

      {/* Error state */}
      {error && (
        <div className="mb-4 px-4 py-3 rounded-[10px] bg-[#ff5c6c15] border border-[#ff5c6c40] text-[#ff5c6c] text-[12px]">
          Failed to load audit log: {error}
        </div>
      )}

      {/* Table */}
      <div className="rounded-[12px] border border-[#2a2a31] overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-[11px]">
            <thead>
              <tr className="bg-[#111114] border-b border-[#2a2a31]">
                {['Timestamp', 'User', 'Action', 'Resource', 'Detail', 'Rows', 'Severity'].map((h) => (
                  <th key={h} className="text-left px-4 py-3 text-[#6c6c74] font-semibold whitespace-nowrap">{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {loading && (
                <tr>
                  <td colSpan={7} className="px-4 py-8 text-center text-[#44444b]">Loading…</td>
                </tr>
              )}
              {!loading && pageEvents.length === 0 && (
                <tr>
                  <td colSpan={7} className="px-4 py-8 text-center text-[#44444b]">No audit events found.</td>
                </tr>
              )}
              {!loading && pageEvents.map((event) => (
                <tr key={event.id} className="border-b border-[#1f1f25] hover:bg-[#111114] transition-colors">
                  <td className="px-4 py-3 text-[#6c6c74] whitespace-nowrap font-mono">{formatTs(event.timestamp)}</td>
                  <td className="px-4 py-3 text-[#a0a0a7] max-w-[140px] truncate">{event.userEmail}</td>
                  <td className="px-4 py-3 whitespace-nowrap">
                    <span className={clsx('px-2 py-0.5 rounded-full text-[10px] font-semibold', actionStyle[event.action] ?? 'bg-[#2a2a31] text-[#a0a0a7] border border-[#3a3a45]')}>
                      {event.action}
                    </span>
                  </td>
                  <td className="px-4 py-3 text-[#6c6c74] whitespace-nowrap">{event.resourceType}</td>
                  <td className="px-4 py-3 text-[#a0a0a7] max-w-[260px] truncate" title={event.detail}>{event.detail}</td>
                  <td className="px-4 py-3 text-[#6c6c74] text-right">{event.rowsAffected ?? '—'}</td>
                  <td className="px-4 py-3 whitespace-nowrap">
                    <span className={clsx('px-2 py-0.5 rounded-full text-[10px] font-semibold', severityStyle[event.severity])}>
                      {event.severity}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {/* Pagination */}
      {totalPages > 1 && (
        <div className="flex items-center justify-between mt-4 text-[11px] text-[#6c6c74]">
          <span>Page {page} of {totalPages} ({events.length} events)</span>
          <div className="flex items-center gap-1">
            <button
              onClick={() => setPage((p) => Math.max(1, p - 1))}
              disabled={page === 1}
              className="w-7 h-7 flex items-center justify-center rounded-[7px] bg-[#16161a] border border-[#2a2a31] hover:border-[#3a3a45] disabled:opacity-40 disabled:cursor-not-allowed transition-all"
            >
              <ChevronLeft size={12} />
            </button>
            <button
              onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
              disabled={page === totalPages}
              className="w-7 h-7 flex items-center justify-center rounded-[7px] bg-[#16161a] border border-[#2a2a31] hover:border-[#3a3a45] disabled:opacity-40 disabled:cursor-not-allowed transition-all"
            >
              <ChevronRight size={12} />
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
