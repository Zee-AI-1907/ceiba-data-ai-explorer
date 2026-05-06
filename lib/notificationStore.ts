// Notification Store — obfuscated-localStorage-backed

export type NotificationSeverity = 'critical' | 'warning' | 'info'

export type AppNotification = {
  id: string
  message: string
  severity: NotificationSeverity
  timestamp: string
  read: boolean
}

import { secureGetSync, secureSetSync } from '@/lib/secureStorage'

const NOTIFICATIONS_KEY = 'notifications'

const SEED_NOTIFICATIONS: AppNotification[] = [
  {
    id: 'notif-1',
    message: '🔴 CRITICAL: ICU Occupancy reached 92% — threshold 85%',
    severity: 'critical',
    timestamp: new Date(Date.now() - 1000 * 60 * 12).toISOString(),
    read: false,
  },
  {
    id: 'notif-2',
    message: '🟡 WARNING: Average LOS exceeded 4.2 days in Unit 3',
    severity: 'warning',
    timestamp: new Date(Date.now() - 1000 * 60 * 45).toISOString(),
    read: false,
  },
  {
    id: 'notif-3',
    message: "✅ Report 'Morning Rounds Summary' delivered at 07:00",
    severity: 'info',
    timestamp: new Date(Date.now() - 1000 * 60 * 120).toISOString(),
    read: false,
  },
  {
    id: 'notif-4',
    message: '🔴 CRITICAL: Ventilator Count dropped below threshold of 5',
    severity: 'critical',
    timestamp: new Date(Date.now() - 1000 * 60 * 180).toISOString(),
    read: true,
  },
]

function seed(): void {
  if (typeof window === 'undefined') return
  if (secureGetSync<AppNotification[]>(NOTIFICATIONS_KEY) === null) {
    secureSetSync(NOTIFICATIONS_KEY, SEED_NOTIFICATIONS)
  }
}

export function getNotifications(): AppNotification[] {
  if (typeof window === 'undefined') return []
  seed()
  return secureGetSync<AppNotification[]>(NOTIFICATIONS_KEY) ?? []
}

export function getUnreadCount(): number {
  return getNotifications().filter((n) => !n.read).length
}

export function markAsRead(id: string): void {
  const notifications = getNotifications()
  const idx = notifications.findIndex((n) => n.id === id)
  if (idx >= 0) {
    notifications[idx].read = true
    secureSetSync(NOTIFICATIONS_KEY, notifications)
  }
}

export function markAllRead(): void {
  const notifications = getNotifications().map((n) => ({ ...n, read: true }))
  secureSetSync(NOTIFICATIONS_KEY, notifications)
}

export function clearAll(): void {
  secureSetSync(NOTIFICATIONS_KEY, [])
}

export function addNotification(notif: Omit<AppNotification, 'id' | 'timestamp' | 'read'>): void {
  const notifications = getNotifications()
  notifications.unshift({
    ...notif,
    id: `notif-${Date.now()}`,
    timestamp: new Date().toISOString(),
    read: false,
  })
  secureSetSync(NOTIFICATIONS_KEY, notifications)
}
