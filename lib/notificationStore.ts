// Notification Store — localStorage-backed

export type NotificationSeverity = 'critical' | 'warning' | 'info'

export type AppNotification = {
  id: string
  message: string
  severity: NotificationSeverity
  timestamp: string
  read: boolean
}

const NOTIFICATIONS_KEY = 'ceiba_notifications'

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
  if (!localStorage.getItem(NOTIFICATIONS_KEY)) {
    localStorage.setItem(NOTIFICATIONS_KEY, JSON.stringify(SEED_NOTIFICATIONS))
  }
}

export function getNotifications(): AppNotification[] {
  if (typeof window === 'undefined') return []
  seed()
  try {
    return JSON.parse(localStorage.getItem(NOTIFICATIONS_KEY) || '[]')
  } catch {
    return []
  }
}

export function getUnreadCount(): number {
  return getNotifications().filter((n) => !n.read).length
}

export function markAsRead(id: string): void {
  const notifications = getNotifications()
  const idx = notifications.findIndex((n) => n.id === id)
  if (idx >= 0) {
    notifications[idx].read = true
    localStorage.setItem(NOTIFICATIONS_KEY, JSON.stringify(notifications))
  }
}

export function markAllRead(): void {
  const notifications = getNotifications().map((n) => ({ ...n, read: true }))
  localStorage.setItem(NOTIFICATIONS_KEY, JSON.stringify(notifications))
}

export function clearAll(): void {
  localStorage.setItem(NOTIFICATIONS_KEY, JSON.stringify([]))
}

export function addNotification(notif: Omit<AppNotification, 'id' | 'timestamp' | 'read'>): void {
  const notifications = getNotifications()
  notifications.unshift({
    ...notif,
    id: `notif-${Date.now()}`,
    timestamp: new Date().toISOString(),
    read: false,
  })
  localStorage.setItem(NOTIFICATIONS_KEY, JSON.stringify(notifications))
}
