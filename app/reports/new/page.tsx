'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { ArrowLeft, FileText, Check } from 'lucide-react'
import { clsx } from 'clsx'
import DataNav from '@/components/DataNav'
import {
  ScheduledReport,
  saveReport,
  computeNextDelivery,
  HARDCODED_DASHBOARDS,
  ReportScheduleFrequency,
  ReportFormat,
  ReportDelivery,
} from '@/lib/reportStore'

const FREQUENCIES: ReportScheduleFrequency[] = ['Daily', 'Weekly', 'Monthly']
const FORMATS: ReportFormat[] = ['PDF', 'PNG', 'Excel']
const DELIVERY_OPTIONS: ReportDelivery[] = ['Email', 'Telegram']

const formatColors: Record<ReportFormat, string> = {
  PDF: 'text-[#ff5c6c] bg-[#ff5c6c15] border-[#ff5c6c60]',
  PNG: 'text-[#4c8dff] bg-[#4c8dff15] border-[#4c8dff60]',
  Excel: 'text-[#4dcc88] bg-[#4dcc8815] border-[#4dcc8860]',
}

export default function NewReportPage() {
  const router = useRouter()

  const [name, setName] = useState('')
  const [selectedDashboards, setSelectedDashboards] = useState<string[]>([])
  const [frequency, setFrequency] = useState<ReportScheduleFrequency>('Daily')
  const [hour, setHour] = useState(7)
  const [minute, setMinute] = useState(0)
  const [deliveries, setDeliveries] = useState<ReportDelivery[]>(['Email'])
  const [email, setEmail] = useState('')
  const [format, setFormat] = useState<ReportFormat>('PDF')
  const [saved, setSaved] = useState(false)
  const [nextDelivery, setNextDelivery] = useState('')
  const [errors, setErrors] = useState<Record<string, string>>({})

  function toggleDashboard(d: string) {
    setSelectedDashboards((prev) =>
      prev.includes(d) ? prev.filter((x) => x !== d) : [...prev, d]
    )
  }

  function toggleDelivery(d: ReportDelivery) {
    setDeliveries((prev) =>
      prev.includes(d) ? prev.filter((x) => x !== d) : [...prev, d]
    )
  }

  function validate(): boolean {
    const errs: Record<string, string> = {}
    if (!name.trim()) errs.name = 'Report name is required'
    if (selectedDashboards.length === 0) errs.dashboards = 'Select at least one dashboard'
    if (deliveries.length === 0) errs.deliveries = 'Select at least one delivery method'
    if (deliveries.includes('Email') && !email.trim()) errs.email = 'Email address is required'
    setErrors(errs)
    return Object.keys(errs).length === 0
  }

  function handleSave() {
    if (!validate()) return

    const nd = computeNextDelivery(frequency, hour, minute)

    const report: ScheduledReport = {
      id: `report-${Date.now()}`,
      name: name.trim(),
      dashboards: selectedDashboards,
      frequency,
      hour,
      minute,
      deliveries,
      email: deliveries.includes('Email') ? email.trim() : undefined,
      format,
      createdAt: new Date().toISOString(),
      nextDelivery: nd,
    }

    saveReport(report)
    setNextDelivery(nd)
    setSaved(true)
  }

  if (saved) {
    return (
      <div className="flex flex-col h-screen bg-[#0d0d10] text-[#e8e8ea]">
        <DataNav activePage="reports" />
        <div className="flex-1 flex flex-col items-center justify-center gap-6">
          <div className="w-16 h-16 rounded-2xl bg-[#4dcc8820] border border-[#4dcc8840] flex items-center justify-center">
            <Check size={28} className="text-[#4dcc88]" />
          </div>
          <div className="text-center">
            <h2 className="text-[20px] font-bold text-[#e8e8ea] mb-1">Report Scheduled!</h2>
            <p className="text-[13px] text-[#6c6c74]">
              Next delivery:{' '}
              <span className="text-[#4dcc88] font-semibold">
                {new Date(nextDelivery).toLocaleString(undefined, {
                  weekday: 'short',
                  month: 'short',
                  day: 'numeric',
                  hour: '2-digit',
                  minute: '2-digit',
                })}
              </span>
            </p>
          </div>
          <div className="flex gap-3">
            <button
              onClick={() => router.push('/reports')}
              className="px-6 py-2.5 rounded-[10px] bg-[#4c8dff] text-white text-[13px] font-semibold hover:bg-[#6aa3ff] transition-all"
            >
              Back to Reports
            </button>
            <button
              onClick={() => { setSaved(false); setName(''); setSelectedDashboards([]); setEmail('') }}
              className="px-5 py-2.5 rounded-[10px] bg-[#16161a] border border-[#2a2a31] text-[13px] text-[#6c6c74] hover:text-[#e8e8ea] hover:border-[#3a3a45] transition-all"
            >
              New Report
            </button>
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className="flex flex-col h-screen bg-[#0d0d10] text-[#e8e8ea]">
      <DataNav activePage="reports" />

      <div className="flex-1 overflow-auto px-6 py-6">
        {/* Header */}
        <div className="flex items-center gap-3 mb-6">
          <button
            onClick={() => router.push('/reports')}
            className="w-8 h-8 flex items-center justify-center rounded-[8px] bg-[#16161a] border border-[#2a2a31] text-[#6c6c74] hover:text-[#e8e8ea] hover:border-[#3a3a45] transition-all"
          >
            <ArrowLeft size={14} />
          </button>
          <div className="flex items-center gap-3">
            <div className="w-8 h-8 rounded-[10px] bg-[#4c8dff20] border border-[#4c8dff40] flex items-center justify-center">
              <FileText size={15} className="text-[#4c8dff]" />
            </div>
            <div>
              <h1 className="text-[18px] font-bold text-[#e8e8ea]">New Scheduled Report</h1>
              <p className="text-[12px] text-[#6c6c74]">Configure automatic report delivery</p>
            </div>
          </div>
        </div>

        {/* Form */}
        <div className="max-w-[680px] space-y-6">

          {/* Report Name */}
          <div className="bg-[#111114] border border-[#2a2a31] rounded-[16px] p-5 space-y-1.5">
            <label className="text-[11px] font-semibold text-[#6c6c74] uppercase tracking-wider">Report Name</label>
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g. Morning Rounds Summary"
              className={clsx(
                'w-full px-3.5 py-2.5 rounded-[10px] bg-[#0d0d10] border text-[13px] text-[#e8e8ea] placeholder:text-[#44444b] outline-none transition-all',
                errors.name ? 'border-[#ff5c6c]' : 'border-[#2a2a31] focus:border-[#4c8dff]'
              )}
            />
            {errors.name && <p className="text-[11px] text-[#ff5c6c]">{errors.name}</p>}
          </div>

          {/* Dashboards */}
          <div className="bg-[#111114] border border-[#2a2a31] rounded-[16px] p-5 space-y-3">
            <div>
              <label className="text-[11px] font-semibold text-[#6c6c74] uppercase tracking-wider">Content — Dashboards</label>
              <p className="text-[11px] text-[#44444b] mt-0.5">Select dashboards to include in this report</p>
            </div>
            <div className="grid grid-cols-2 gap-2">
              {HARDCODED_DASHBOARDS.map((d) => {
                const active = selectedDashboards.includes(d)
                return (
                  <button
                    key={d}
                    onClick={() => toggleDashboard(d)}
                    className={clsx(
                      'flex items-center gap-2.5 px-3.5 py-2.5 rounded-[10px] border text-[12px] text-left transition-all',
                      active
                        ? 'bg-[#4c8dff15] border-[#4c8dff50] text-[#4c8dff]'
                        : 'bg-[#0d0d10] border-[#2a2a31] text-[#6c6c74] hover:border-[#3a3a45] hover:text-[#a0a0a7]'
                    )}
                  >
                    <span className={clsx('w-3.5 h-3.5 rounded-[4px] border flex items-center justify-center flex-shrink-0', active ? 'bg-[#4c8dff] border-[#4c8dff]' : 'border-[#2a2a31]')}>
                      {active && <Check size={8} className="text-white" />}
                    </span>
                    {d}
                  </button>
                )
              })}
            </div>
            {errors.dashboards && <p className="text-[11px] text-[#ff5c6c]">{errors.dashboards}</p>}
          </div>

          {/* Schedule */}
          <div className="bg-[#111114] border border-[#2a2a31] rounded-[16px] p-5 space-y-4">
            <label className="text-[11px] font-semibold text-[#6c6c74] uppercase tracking-wider">Schedule</label>

            {/* Frequency */}
            <div className="flex gap-2">
              {FREQUENCIES.map((f) => (
                <button
                  key={f}
                  onClick={() => setFrequency(f)}
                  className={clsx(
                    'px-4 py-2 rounded-[10px] border text-[12px] font-semibold transition-all',
                    frequency === f
                      ? 'bg-[#7c68ff20] border-[#7c68ff60] text-[#7c68ff]'
                      : 'bg-[#0d0d10] border-[#2a2a31] text-[#44444b] hover:text-[#6c6c74] hover:border-[#3a3a45]'
                  )}
                >
                  {f}
                </button>
              ))}
            </div>

            {/* Time picker */}
            <div className="flex items-center gap-3">
              <span className="text-[12px] text-[#6c6c74]">at</span>
              <div className="flex items-center gap-1">
                <select
                  value={hour}
                  onChange={(e) => setHour(Number(e.target.value))}
                  className="px-3 py-2 rounded-[8px] bg-[#0d0d10] border border-[#2a2a31] text-[13px] text-[#e8e8ea] outline-none focus:border-[#7c68ff] transition-all"
                >
                  {Array.from({ length: 24 }, (_, i) => (
                    <option key={i} value={i}>{String(i).padStart(2, '0')}</option>
                  ))}
                </select>
                <span className="text-[#44444b] font-bold">:</span>
                <select
                  value={minute}
                  onChange={(e) => setMinute(Number(e.target.value))}
                  className="px-3 py-2 rounded-[8px] bg-[#0d0d10] border border-[#2a2a31] text-[13px] text-[#e8e8ea] outline-none focus:border-[#7c68ff] transition-all"
                >
                  {[0, 15, 30, 45].map((m) => (
                    <option key={m} value={m}>{String(m).padStart(2, '0')}</option>
                  ))}
                </select>
              </div>
            </div>
          </div>

          {/* Delivery */}
          <div className="bg-[#111114] border border-[#2a2a31] rounded-[16px] p-5 space-y-4">
            <label className="text-[11px] font-semibold text-[#6c6c74] uppercase tracking-wider">Delivery</label>

            <div className="flex gap-2">
              {DELIVERY_OPTIONS.map((d) => {
                const active = deliveries.includes(d)
                return (
                  <button
                    key={d}
                    onClick={() => toggleDelivery(d)}
                    className={clsx(
                      'flex items-center gap-2 px-4 py-2 rounded-[10px] border text-[12px] font-semibold transition-all',
                      active
                        ? 'bg-[#4dcc8820] border-[#4dcc8840] text-[#4dcc88]'
                        : 'bg-[#0d0d10] border-[#2a2a31] text-[#44444b] hover:text-[#6c6c74] hover:border-[#3a3a45]'
                    )}
                  >
                    <span className={clsx('w-3 h-3 rounded-[3px] border flex items-center justify-center flex-shrink-0', active ? 'bg-[#4dcc88] border-[#4dcc88]' : 'border-[#2a2a31]')}>
                      {active && <span className="text-white text-[8px]">✓</span>}
                    </span>
                    {d}
                  </button>
                )
              })}
            </div>
            {errors.deliveries && <p className="text-[11px] text-[#ff5c6c]">{errors.deliveries}</p>}

            {deliveries.includes('Email') && (
              <div className="space-y-1.5">
                <label className="text-[11px] text-[#44444b]">Email address</label>
                <input
                  type="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  placeholder="user@hospital.com"
                  className={clsx(
                    'w-full px-3.5 py-2.5 rounded-[10px] bg-[#0d0d10] border text-[13px] text-[#e8e8ea] placeholder:text-[#44444b] outline-none transition-all',
                    errors.email ? 'border-[#ff5c6c]' : 'border-[#2a2a31] focus:border-[#4c8dff]'
                  )}
                />
                {errors.email && <p className="text-[11px] text-[#ff5c6c]">{errors.email}</p>}
              </div>
            )}
          </div>

          {/* Format */}
          <div className="bg-[#111114] border border-[#2a2a31] rounded-[16px] p-5 space-y-3">
            <label className="text-[11px] font-semibold text-[#6c6c74] uppercase tracking-wider">Output Format</label>
            <div className="flex gap-2">
              {FORMATS.map((f) => (
                <button
                  key={f}
                  onClick={() => setFormat(f)}
                  className={clsx(
                    'px-4 py-2 rounded-[10px] border text-[12px] font-semibold transition-all',
                    format === f
                      ? formatColors[f]
                      : 'bg-[#0d0d10] border-[#2a2a31] text-[#44444b] hover:text-[#6c6c74] hover:border-[#3a3a45]'
                  )}
                >
                  {f}
                </button>
              ))}
            </div>
          </div>

          {/* Actions */}
          <div className="flex items-center gap-3 pb-6">
            <button
              onClick={handleSave}
              className="flex items-center gap-2 px-6 py-2.5 rounded-[10px] bg-[#4c8dff] text-white text-[13px] font-semibold hover:bg-[#6aa3ff] transition-all shadow-[0_2px_12px_rgba(76,141,255,0.4)]"
            >
              Schedule Report
            </button>
            <button
              onClick={() => router.push('/reports')}
              className="px-5 py-2.5 rounded-[10px] bg-[#16161a] border border-[#2a2a31] text-[13px] text-[#6c6c74] hover:text-[#e8e8ea] hover:border-[#3a3a45] transition-all"
            >
              Cancel
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
