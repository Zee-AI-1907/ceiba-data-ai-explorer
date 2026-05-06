'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { ArrowLeft, Bell, Info, AlertTriangle, Zap } from 'lucide-react'
import { clsx } from 'clsx'
import DataNav from '@/components/DataNav'
import {
  Alert,
  saveAlert,
  CLINICAL_METRICS,
  ALERT_OPERATORS,
  ALERT_COOLDOWNS,
  AlertSeverity,
  AlertNotificationChannel,
  AlertCooldown,
  AlertOperator,
  ClinicalMetric,
} from '@/lib/alertStore'

const severityOptions: { value: AlertSeverity; color: string; bg: string; border: string; icon: React.ElementType }[] = [
  { value: 'Low', color: 'text-[#4c8dff]', bg: 'bg-[#4c8dff15]', border: 'border-[#4c8dff40]', icon: Info },
  { value: 'Medium', color: 'text-[#f59e0b]', bg: 'bg-[#f59e0b15]', border: 'border-[#f59e0b40]', icon: AlertTriangle },
  { value: 'Critical', color: 'text-[#ff5c6c]', bg: 'bg-[#ff5c6c15]', border: 'border-[#ff5c6c40]', icon: Zap },
]

const CHANNEL_OPTIONS: AlertNotificationChannel[] = ['Email', 'Telegram', 'In-App']

export default function NewAlertPage() {
  const router = useRouter()

  const [name, setName] = useState('')
  const [metric, setMetric] = useState<ClinicalMetric>(CLINICAL_METRICS[0])
  const [operator, setOperator] = useState<AlertOperator>('>')
  const [value, setValue] = useState('')
  const [severity, setSeverity] = useState<AlertSeverity>('Medium')
  const [channels, setChannels] = useState<AlertNotificationChannel[]>(['In-App'])
  const [cooldown, setCooldown] = useState<AlertCooldown>('4h')
  const [errors, setErrors] = useState<Record<string, string>>({})

  function toggleChannel(ch: AlertNotificationChannel) {
    setChannels((prev) =>
      prev.includes(ch) ? prev.filter((c) => c !== ch) : [...prev, ch]
    )
  }

  function validate(): boolean {
    const errs: Record<string, string> = {}
    if (!name.trim()) errs.name = 'Alert name is required'
    if (!value.trim() || isNaN(Number(value))) errs.value = 'Enter a valid number'
    if (channels.length === 0) errs.channels = 'Select at least one channel'
    setErrors(errs)
    return Object.keys(errs).length === 0
  }

  function handleSave() {
    if (!validate()) return

    const alert: Alert = {
      id: `alert-${Date.now()}`,
      name: name.trim(),
      metric,
      operator,
      value: Number(value),
      severity,
      channels,
      cooldown,
      status: 'Active',
      createdAt: new Date().toISOString(),
    }

    saveAlert(alert)
    router.push('/alerts')
  }

  return (
    <div className="flex flex-col h-screen bg-[#0d0d10] text-[#e8e8ea]">
      <DataNav activePage="alerts" />

      <div className="flex-1 overflow-auto px-6 py-6">
        {/* Header */}
        <div className="flex items-center gap-3 mb-6">
          <button
            onClick={() => router.push('/alerts')}
            className="w-8 h-8 flex items-center justify-center rounded-[8px] bg-[#16161a] border border-[#2a2a31] text-[#6c6c74] hover:text-[#e8e8ea] hover:border-[#3a3a45] transition-all"
          >
            <ArrowLeft size={14} />
          </button>
          <div className="flex items-center gap-3">
            <div className="w-8 h-8 rounded-[10px] bg-[#7c68ff20] border border-[#7c68ff40] flex items-center justify-center">
              <Bell size={15} className="text-[#7c68ff]" />
            </div>
            <div>
              <h1 className="text-[18px] font-bold text-[#e8e8ea]">New Threshold Alert</h1>
              <p className="text-[12px] text-[#6c6c74]">Configure when to get notified</p>
            </div>
          </div>
        </div>

        {/* Form card */}
        <div className="max-w-[680px] bg-[#111114] border border-[#2a2a31] rounded-[16px] p-6 space-y-6">

          {/* Alert Name */}
          <div className="space-y-1.5">
            <label className="text-[11px] font-semibold text-[#6c6c74] uppercase tracking-wider">Alert Name</label>
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g. ICU High Occupancy"
              className={clsx(
                'w-full px-3.5 py-2.5 rounded-[10px] bg-[#0d0d10] border text-[13px] text-[#e8e8ea] placeholder:text-[#44444b] outline-none transition-all',
                errors.name
                  ? 'border-[#ff5c6c] focus:border-[#ff5c6c]'
                  : 'border-[#2a2a31] focus:border-[#7c68ff]'
              )}
            />
            {errors.name && <p className="text-[11px] text-[#ff5c6c]">{errors.name}</p>}
          </div>

          {/* Metric + Condition row */}
          <div className="space-y-1.5">
            <label className="text-[11px] font-semibold text-[#6c6c74] uppercase tracking-wider">Condition</label>
            <div className="flex gap-2">
              {/* Metric */}
              <select
                value={metric}
                onChange={(e) => setMetric(e.target.value as ClinicalMetric)}
                className="flex-1 px-3.5 py-2.5 rounded-[10px] bg-[#0d0d10] border border-[#2a2a31] text-[13px] text-[#e8e8ea] outline-none focus:border-[#7c68ff] transition-all"
              >
                {CLINICAL_METRICS.map((m) => (
                  <option key={m} value={m}>{m}</option>
                ))}
              </select>

              {/* Operator */}
              <select
                value={operator}
                onChange={(e) => setOperator(e.target.value as AlertOperator)}
                className="w-[80px] px-3 py-2.5 rounded-[10px] bg-[#0d0d10] border border-[#2a2a31] text-[13px] text-[#e8e8ea] outline-none focus:border-[#7c68ff] transition-all text-center"
              >
                {ALERT_OPERATORS.map((op) => (
                  <option key={op} value={op}>{op}</option>
                ))}
              </select>

              {/* Value */}
              <input
                type="number"
                value={value}
                onChange={(e) => setValue(e.target.value)}
                placeholder="85"
                className={clsx(
                  'w-[100px] px-3.5 py-2.5 rounded-[10px] bg-[#0d0d10] border text-[13px] text-[#e8e8ea] placeholder:text-[#44444b] outline-none transition-all',
                  errors.value
                    ? 'border-[#ff5c6c] focus:border-[#ff5c6c]'
                    : 'border-[#2a2a31] focus:border-[#7c68ff]'
                )}
              />
            </div>
            {errors.value && <p className="text-[11px] text-[#ff5c6c]">{errors.value}</p>}
            {/* Preview */}
            {name && value && (
              <p className="text-[12px] text-[#6c6c74]">
                Trigger when <span className="text-[#7c68ff]">{metric}</span> is{' '}
                <span className="text-[#7c68ff]">{operator} {value}</span>
              </p>
            )}
          </div>

          {/* Severity */}
          <div className="space-y-2">
            <label className="text-[11px] font-semibold text-[#6c6c74] uppercase tracking-wider">Severity</label>
            <div className="flex gap-2">
              {severityOptions.map(({ value: sev, color, bg, border, icon: SevIcon }) => (
                <button
                  key={sev}
                  onClick={() => setSeverity(sev)}
                  className={clsx(
                    'flex items-center gap-2 px-4 py-2 rounded-[10px] border text-[12px] font-semibold transition-all',
                    severity === sev
                      ? clsx(bg, border, color)
                      : 'bg-[#16161a] border-[#2a2a31] text-[#44444b] hover:text-[#6c6c74] hover:border-[#3a3a45]'
                  )}
                >
                  <SevIcon size={12} />
                  {sev}
                </button>
              ))}
            </div>
          </div>

          {/* Notification channels */}
          <div className="space-y-2">
            <label className="text-[11px] font-semibold text-[#6c6c74] uppercase tracking-wider">Notification Channels</label>
            <div className="flex gap-2 flex-wrap">
              {CHANNEL_OPTIONS.map((ch) => {
                const active = channels.includes(ch)
                return (
                  <button
                    key={ch}
                    onClick={() => toggleChannel(ch)}
                    className={clsx(
                      'flex items-center gap-2 px-4 py-2 rounded-[10px] border text-[12px] font-semibold transition-all',
                      active
                        ? 'bg-[#7c68ff20] border-[#7c68ff60] text-[#7c68ff]'
                        : 'bg-[#16161a] border-[#2a2a31] text-[#44444b] hover:text-[#6c6c74] hover:border-[#3a3a45]'
                    )}
                  >
                    <span className={clsx('w-3 h-3 rounded-[3px] border flex items-center justify-center', active ? 'bg-[#7c68ff] border-[#7c68ff]' : 'border-[#2a2a31]')}>
                      {active && <span className="text-white text-[8px]">✓</span>}
                    </span>
                    {ch}
                  </button>
                )
              })}
            </div>
            {errors.channels && <p className="text-[11px] text-[#ff5c6c]">{errors.channels}</p>}
          </div>

          {/* Cooldown */}
          <div className="space-y-2">
            <label className="text-[11px] font-semibold text-[#6c6c74] uppercase tracking-wider">Re-alert Cooldown</label>
            <div className="flex gap-2">
              {ALERT_COOLDOWNS.map((cd) => (
                <button
                  key={cd}
                  onClick={() => setCooldown(cd)}
                  className={clsx(
                    'px-4 py-2 rounded-[10px] border text-[12px] font-semibold transition-all',
                    cooldown === cd
                      ? 'bg-[#4dcc8820] border-[#4dcc8840] text-[#4dcc88]'
                      : 'bg-[#16161a] border-[#2a2a31] text-[#44444b] hover:text-[#6c6c74] hover:border-[#3a3a45]'
                  )}
                >
                  Every {cd}
                </button>
              ))}
            </div>
          </div>

          {/* Actions */}
          <div className="flex items-center gap-3 pt-2 border-t border-[#2a2a31]">
            <button
              onClick={handleSave}
              className="flex items-center gap-2 px-6 py-2.5 rounded-[10px] bg-[#7c68ff] text-white text-[13px] font-semibold hover:bg-[#8f7dff] transition-all shadow-[0_2px_12px_rgba(124,104,255,0.4)]"
            >
              Save Alert
            </button>
            <button
              onClick={() => router.push('/alerts')}
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
