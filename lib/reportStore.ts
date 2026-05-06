// Report Store — localStorage-backed persistence

export type ReportScheduleFrequency = 'Daily' | 'Weekly' | 'Monthly'

export type ReportFormat = 'PDF' | 'PNG' | 'Excel'

export type ReportDelivery = 'Email' | 'Telegram'

export type ScheduledReport = {
  id: string
  name: string
  dashboards: string[]          // list of dashboard names / IDs to include
  frequency: ReportScheduleFrequency
  hour: number                  // 0-23
  minute: number                // 0-59
  deliveries: ReportDelivery[]
  email?: string
  format: ReportFormat
  createdAt: string
  nextDelivery: string          // ISO datetime string, computed on save
}

const REPORTS_KEY = 'ceiba_reports'

export function getReports(): ScheduledReport[] {
  if (typeof window === 'undefined') return []
  try {
    return JSON.parse(localStorage.getItem(REPORTS_KEY) || '[]')
  } catch {
    return []
  }
}

export function getReport(id: string): ScheduledReport | null {
  return getReports().find((r) => r.id === id) ?? null
}

export function saveReport(report: ScheduledReport): void {
  const reports = getReports()
  const idx = reports.findIndex((r) => r.id === report.id)
  if (idx >= 0) reports[idx] = report
  else reports.unshift(report)
  localStorage.setItem(REPORTS_KEY, JSON.stringify(reports))
}

export function deleteReport(id: string): void {
  const reports = getReports().filter((r) => r.id !== id)
  localStorage.setItem(REPORTS_KEY, JSON.stringify(reports))
}

/** Compute the next delivery datetime (ISO string) based on frequency + time */
export function computeNextDelivery(
  frequency: ReportScheduleFrequency,
  hour: number,
  minute: number
): string {
  const now = new Date()
  const candidate = new Date(now)
  candidate.setHours(hour, minute, 0, 0)

  if (frequency === 'Daily') {
    if (candidate <= now) candidate.setDate(candidate.getDate() + 1)
  } else if (frequency === 'Weekly') {
    // next Monday
    const day = candidate.getDay()
    const daysUntilMonday = day === 1 ? (candidate <= now ? 7 : 0) : (8 - day) % 7 || 7
    candidate.setDate(candidate.getDate() + daysUntilMonday)
  } else {
    // Monthly — 1st of next month
    candidate.setDate(1)
    if (candidate <= now) {
      candidate.setMonth(candidate.getMonth() + 1)
    }
  }

  return candidate.toISOString()
}

export const HARDCODED_DASHBOARDS = [
  'ICU Overview',
  'ED Throughput',
  'Readmission Trends',
  'Ventilator Utilization',
  'Morning Rounds Summary',
  'Weekly Clinical KPIs',
  'Mortality & LOS Report',
]
