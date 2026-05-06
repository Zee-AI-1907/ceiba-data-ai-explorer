// Alert Store — localStorage-backed persistence

export type AlertOperator = '>' | '<' | '>=' | '<=' | '=='

export type AlertSeverity = 'Low' | 'Medium' | 'Critical'

export type AlertStatus = 'Active' | 'Paused'

export type AlertNotificationChannel = 'Email' | 'Telegram' | 'In-App'

export type AlertCooldown = '1h' | '4h' | '24h'

export type ClinicalMetric =
  | 'ICU Occupancy %'
  | 'Readmission Rate'
  | 'Average LOS (days)'
  | 'Ventilator Count'
  | 'ED Wait Time (min)'
  | 'Mortality Flag Count'
  | 'Daily Admissions'

export type Alert = {
  id: string
  name: string
  metric: ClinicalMetric
  operator: AlertOperator
  value: number
  severity: AlertSeverity
  channels: AlertNotificationChannel[]
  cooldown: AlertCooldown
  status: AlertStatus
  lastTriggered?: string
  createdAt: string
}

const ALERTS_KEY = 'ceiba_alerts'

export function getAlerts(): Alert[] {
  if (typeof window === 'undefined') return []
  try {
    return JSON.parse(localStorage.getItem(ALERTS_KEY) || '[]')
  } catch {
    return []
  }
}

export function getAlert(id: string): Alert | null {
  return getAlerts().find((a) => a.id === id) ?? null
}

export function saveAlert(alert: Alert): void {
  const alerts = getAlerts()
  const idx = alerts.findIndex((a) => a.id === alert.id)
  if (idx >= 0) alerts[idx] = alert
  else alerts.unshift(alert)
  localStorage.setItem(ALERTS_KEY, JSON.stringify(alerts))
}

export function deleteAlert(id: string): void {
  const alerts = getAlerts().filter((a) => a.id !== id)
  localStorage.setItem(ALERTS_KEY, JSON.stringify(alerts))
}

export function toggleAlertStatus(id: string): void {
  const alerts = getAlerts()
  const idx = alerts.findIndex((a) => a.id === id)
  if (idx >= 0) {
    alerts[idx].status = alerts[idx].status === 'Active' ? 'Paused' : 'Active'
    localStorage.setItem(ALERTS_KEY, JSON.stringify(alerts))
  }
}

export const CLINICAL_METRICS: ClinicalMetric[] = [
  'ICU Occupancy %',
  'Readmission Rate',
  'Average LOS (days)',
  'Ventilator Count',
  'ED Wait Time (min)',
  'Mortality Flag Count',
  'Daily Admissions',
]

export const ALERT_OPERATORS: AlertOperator[] = ['>', '<', '>=', '<=', '==']

export const ALERT_COOLDOWNS: AlertCooldown[] = ['1h', '4h', '24h']
