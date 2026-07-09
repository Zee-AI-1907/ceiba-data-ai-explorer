'use client'

import { useState, useEffect, useCallback } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { ChevronDown, Plus, Settings, Bell, X, CheckCheck, Trash2, Menu, HelpCircle, LogOut, Check, Building2 } from 'lucide-react'
import { clsx } from 'clsx'
import {
  AppNotification,
  getNotifications,
  getUnreadCount,
  markAsRead,
  markAllRead,
  clearAll,
} from '@/lib/notificationStore'

type ActivePage = 'dashboards' | 'charts' | 'datasets' | 'sql' | 'alerts' | 'reports' | 'audit'

interface DataNavProps {
  activePage: ActivePage
  /**
   * Show admin-only links (Audit Log). Optional — if omitted, DataNav derives
   * admin status from the current session via /api/auth/me.
   */
  isAdmin?: boolean
}

const navLinks: { key: ActivePage; label: string; href: string; hasDrop?: boolean; adminOnly?: boolean; icon?: React.ElementType }[] = [
  { key: 'dashboards', label: 'Dashboards', href: '/dashboards' },
  { key: 'charts',     label: 'Charts',     href: '/charts' },
  { key: 'datasets',   label: 'Datasets',   href: '/datasets' },
  { key: 'sql',        label: 'SQL',        href: '/data-explorer', hasDrop: true },
  { key: 'alerts',     label: 'Alerts',     href: '/alerts' },
  { key: 'reports',    label: 'Reports',    href: '/reports' },
  { key: 'audit',      label: 'Audit Log',  href: '/audit',    adminOnly: true },
]

function timeAgo(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime()
  const mins = Math.floor(diff / 60000)
  if (mins < 1) return 'just now'
  if (mins < 60) return `${mins}m ago`
  const hours = Math.floor(mins / 60)
  if (hours < 24) return `${hours}h ago`
  return `${Math.floor(hours / 24)}d ago`
}

const severityBorder: Record<string, string> = {
  critical: 'border-l-[#ff5c6c]',
  warning: 'border-l-[#f59e0b]',
  info: 'border-l-[#4c8dff]',
}

function getInitials(name: string): string {
  return name
    .split(' ')
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0])
    .join('')
    .toUpperCase()
}

const roleColor: Record<string, string> = {
  admin: '#7c68ff',
  clinician: '#4dcc88',
  analyst: '#4c8dff',
}

type MembershipView = {
  orgId: string
  role: string
  orgName: string
}

type SessionUser = {
  id: string
  email: string
  name: string
  memberships: MembershipView[]
  defaultOrgId: string
}

type MeResponse = {
  user: SessionUser
  activeOrgId: string
  activeRole: string
  orgName: string
}

/**
 * OrgSwitcher — active-org pill + dropdown. Rendered only when the user has >1
 * membership (single-org users see nothing new). Selecting another org POSTs to
 * /api/auth/switch-org, which re-issues the session cookie scoped to the new
 * active org; on success we refresh the router (server components re-render
 * under the new active org) and re-fetch /api/auth/me.
 */
function OrgSwitcher({
  memberships,
  activeOrgId,
  activeOrgName,
  onSwitched,
}: {
  memberships: MembershipView[]
  activeOrgId: string
  activeOrgName: string
  onSwitched: () => void
}) {
  const [open, setOpen] = useState(false)
  const [switching, setSwitching] = useState(false)

  async function handleSelect(orgId: string) {
    setOpen(false)
    if (orgId === activeOrgId || switching) return
    setSwitching(true)
    try {
      // On 200 OR 403 we re-scope from /api/auth/me (memberships may have
      // changed); the parent's onSwitched handles router.refresh + re-fetch.
      await fetch('/api/auth/switch-org', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ orgId }),
      })
    } catch {
      // Network failure — still re-fetch identity below.
    } finally {
      setSwitching(false)
      onSwitched()
    }
  }

  return (
    <div className="relative hidden md:flex items-stretch">
      <button
        onClick={() => setOpen((v) => !v)}
        disabled={switching}
        title={`Active organization: ${activeOrgName}`}
        className="flex items-center gap-1.5 h-7 px-3 rounded-[8px] bg-[#16161a] border border-[#2a2a31] text-[11px] text-[#a0a0a7] hover:text-[#e8e8ea] hover:border-[#3a3a45] transition-all font-medium disabled:opacity-60"
      >
        <Building2 size={11} />
        <span className="max-w-[120px] truncate">{activeOrgName}</span>
        <ChevronDown size={11} className={clsx('transition-transform duration-200', open && 'rotate-180')} />
      </button>
      {open && (
        <div
          className="absolute top-full right-0 mt-1 bg-[#16161a] border border-[#2a2a31] rounded-[10px] shadow-xl z-50 min-w-[220px] overflow-hidden"
          onMouseLeave={() => setOpen(false)}
        >
          <div className="px-3 py-2 text-[10px] font-bold uppercase tracking-wide text-[#6c6c74] border-b border-[#1f1f25]">
            Switch organization
          </div>
          {memberships.map((membership) => {
            const isActive = membership.orgId === activeOrgId
            return (
              <button
                key={membership.orgId}
                onClick={() => handleSelect(membership.orgId)}
                className="w-full flex items-center justify-between gap-2 px-3 py-2.5 text-left hover:bg-[#1f1f25] transition-colors"
              >
                <span className="flex items-center gap-2 min-w-0">
                  <span className={clsx('text-[12px] truncate', isActive ? 'text-[#e8e8ea] font-medium' : 'text-[#a0a0a7]')}>
                    {membership.orgName}
                  </span>
                  <span
                    className="px-1.5 py-0.5 rounded-full text-[9px] font-bold uppercase tracking-wide flex-shrink-0"
                    style={{
                      color: roleColor[membership.role] ?? '#6c6c74',
                      backgroundColor: `${roleColor[membership.role] ?? '#6c6c74'}1a`,
                    }}
                  >
                    {membership.role}
                  </span>
                </span>
                {isActive && <Check size={13} className="text-[#7c68ff] flex-shrink-0" />}
              </button>
            )
          })}
        </div>
      )}
    </div>
  )
}

export default function DataNav({ activePage, isAdmin }: DataNavProps) {
  const router = useRouter()
  const [sqlOpen, setSqlOpen] = useState(false)
  const [notifOpen, setNotifOpen] = useState(false)
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false)
  const [notifications, setNotifications] = useState<AppNotification[]>([])
  const [unread, setUnread] = useState(0)
  const [sessionUser, setSessionUser] = useState<SessionUser | null>(null)
  const [activeOrgId, setActiveOrgId] = useState<string>('')
  const [activeRole, setActiveRole] = useState<string>('')
  const [activeOrgName, setActiveOrgName] = useState<string>('')

  const userName = sessionUser?.name ?? ''
  // The avatar/role reflect the ACTIVE org's role (flips as the user switches).
  const userRole = activeRole || 'analyst'
  const avatarColor = roleColor[userRole] ?? '#6c6c74'
  // If isAdmin is passed explicitly, honour it; otherwise derive from the
  // ACTIVE role so the Audit Log nav item toggles as the user switches orgs.
  const showAdmin = isAdmin ?? (activeRole === 'admin')
  const memberships = sessionUser?.memberships ?? []

  const refreshNotifications = useCallback(() => {
    setNotifications(getNotifications())
    setUnread(getUnreadCount())
  }, [])

  useEffect(() => {
    refreshNotifications()
  }, [refreshNotifications])

  const loadMe = useCallback(() => {
    return fetch('/api/auth/me')
      .then((res) => (res.ok ? res.json() : null))
      .then((data: MeResponse | null) => {
        if (data?.user) {
          setSessionUser(data.user)
          setActiveOrgId(data.activeOrgId)
          setActiveRole(data.activeRole)
          setActiveOrgName(data.orgName)
        }
      })
      .catch(() => {})
  }, [])

  useEffect(() => {
    let cancelled = false
    fetch('/api/auth/me')
      .then((res) => (res.ok ? res.json() : null))
      .then((data: MeResponse | null) => {
        if (!cancelled && data?.user) {
          setSessionUser(data.user)
          setActiveOrgId(data.activeOrgId)
          setActiveRole(data.activeRole)
          setActiveOrgName(data.orgName)
        }
      })
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [])

  // Called after an org switch: re-render server components under the new
  // active org, then re-fetch identity so the switcher + admin nav re-scope.
  const handleSwitched = useCallback(() => {
    router.refresh()
    void loadMe()
  }, [router, loadMe])

  async function handleSignOut() {
    try {
      await fetch('/api/auth/logout', { method: 'POST' })
    } catch {
      // ignore — clear client state regardless
    }
    router.push('/sign-in')
    router.refresh()
  }

  function handleMarkRead(id: string) {
    markAsRead(id)
    refreshNotifications()
  }

  function handleMarkAllRead() {
    markAllRead()
    refreshNotifications()
  }

  function handleClearAll() {
    clearAll()
    refreshNotifications()
  }

  return (
    <>
      <nav className="flex items-stretch h-11 bg-[#0d0d10] border-b border-[#1f1f25] px-4 relative z-50 flex-shrink-0 overflow-visible">

        {/* Logo */}
        <Link
          href="/data-explorer"
          className="flex items-center gap-2 mr-8 group"
        >
          <div className="w-5 h-5 rounded-[5px] bg-gradient-to-br from-[#7c68ff] to-[#4c8dff] flex items-center justify-center flex-shrink-0">
            <span className="text-[8px] font-black text-white tracking-tighter">CH</span>
          </div>
          <span className="text-[13px] font-bold text-[#e8e8ea] tracking-tight uppercase group-hover:text-white transition-colors">
            Ceiba Data
          </span>
        </Link>

        {/* Nav links - hidden on mobile */}
        <div className="hidden md:flex items-stretch flex-1">
          {navLinks.filter((link) => !link.adminOnly || showAdmin).map((link) => {
            const isActive = activePage === link.key

            if (link.hasDrop) {
              return (
                <div key={link.key} className="relative flex items-stretch">
                  <button
                    onClick={() => setSqlOpen((v) => !v)}
                    className={clsx(
                      'flex items-center gap-1 px-3 h-full text-[12px] font-medium border-b-2 transition-colors',
                      isActive
                        ? 'text-[#7c68ff] border-[#7c68ff]'
                        : 'text-[#6c6c74] border-transparent hover:text-[#e8e8ea]'
                    )}
                  >
                    {link.label}
                    <ChevronDown size={11} className={clsx('transition-transform duration-200', sqlOpen && 'rotate-180')} />
                  </button>
                  {sqlOpen && (
                    <div
                      className="absolute top-full left-0 mt-0 bg-[#16161a] border border-[#2a2a31] rounded-[10px] shadow-xl z-50 min-w-[160px] overflow-hidden"
                      onMouseLeave={() => setSqlOpen(false)}
                    >
                      {[
                        { label: 'SQL Lab',       href: '/data-explorer' },
                        { label: 'Saved Queries', href: '#' },
                        { label: 'Query History', href: '#' },
                      ].map((item) => (
                        <Link
                          key={item.label}
                          href={item.href}
                          className="block px-4 py-2.5 text-[12px] text-[#a0a0a7] hover:bg-[#1f1f25] hover:text-[#e8e8ea] transition-colors"
                          onClick={() => setSqlOpen(false)}
                        >
                          {item.label}
                        </Link>
                      ))}
                    </div>
                  )}
                </div>
              )
            }

            return (
              <Link
                key={link.key}
                href={link.href}
                className={clsx(
                  'flex items-center px-3 h-full text-[12px] font-medium border-b-2 transition-colors',
                  isActive
                    ? 'text-[#7c68ff] border-[#7c68ff]'
                    : 'text-[#6c6c74] border-transparent hover:text-[#e8e8ea]'
                )}
              >
                {link.label}
              </Link>
            )
          })}
        </div>

        {/* Mobile hamburger - visible only on mobile */}
        <button
          className="md:hidden ml-auto flex items-center justify-center w-8 h-8 text-[#6c6c74] hover:text-[#a0a0a7] transition-colors"
          onClick={() => setMobileMenuOpen(v => !v)}
          aria-label="Toggle menu"
        >
          {mobileMenuOpen ? <X size={18} /> : <Menu size={18} />}
        </button>

        {/* Right side */}
        <div className="flex items-center gap-2">
          <div className="hidden md:flex items-center gap-1.5 mr-4">
            <div className="w-1.5 h-1.5 rounded-full bg-[#4dcc88]" />
            <span className="text-[11px] text-[#6c6c74]">All systems operational</span>
          </div>

          {/* Help Center */}
          <Link
            href="/help"
            title="Help Center"
            className="w-8 h-8 rounded-[8px] bg-[#16161a] border border-[#2a2a31] flex items-center justify-center text-[#6c6c74] hover:text-[#a0a0a7] hover:border-[#3a3a45] transition-all"
          >
            <HelpCircle size={14} />
          </Link>

          {/* Bell / Notification Center */}
          <button
            onClick={() => setNotifOpen((v) => !v)}
            className="relative w-7 h-7 rounded-[8px] bg-[#16161a] border border-[#2a2a31] flex items-center justify-center text-[#6c6c74] hover:text-[#a0a0a7] hover:border-[#3a3a45] transition-all"
            title="Notifications"
          >
            <Bell size={13} />
            {unread > 0 && (
              <span className="absolute -top-1 -right-1 w-4 h-4 rounded-full bg-[#ff5c6c] border border-[#0d0d10] flex items-center justify-center text-[8px] font-bold text-white leading-none">
                {unread > 9 ? '9+' : unread}
              </span>
            )}
          </button>

          <button className="w-7 h-7 rounded-[8px] bg-[#16161a] border border-[#2a2a31] flex items-center justify-center text-[#6c6c74] hover:text-[#a0a0a7] hover:border-[#3a3a45] transition-all">
            <Plus size={13} />
          </button>
          <button className="hidden md:flex items-center gap-1.5 h-7 px-3 rounded-[8px] bg-[#16161a] border border-[#2a2a31] text-[11px] text-[#a0a0a7] hover:text-[#e8e8ea] hover:border-[#3a3a45] transition-all font-medium">
            <Settings size={11} />
            Settings
          </button>

          {/* Org switcher — only for multi-org users */}
          {memberships.length > 1 && activeOrgId && (
            <OrgSwitcher
              memberships={memberships}
              activeOrgId={activeOrgId}
              activeOrgName={activeOrgName}
              onSwitched={handleSwitched}
            />
          )}

          {/* User avatar + sign out */}
          {userName && (
            <div className="hidden md:flex items-center gap-2 ml-1 pl-2 border-l border-[#2a2a31]">
              <div
                className="w-6 h-6 rounded-full flex items-center justify-center text-[10px] font-bold text-white flex-shrink-0"
                style={{ backgroundColor: avatarColor }}
                title={`${userName} (${userRole})${activeOrgName ? ` — ${activeOrgName}` : ''}`}
              >
                {getInitials(userName)}
              </div>
              <span className="text-[12px] text-[#a0a0a7] max-w-[100px] truncate">{userName}</span>
              <button
                onClick={handleSignOut}
                title="Sign out"
                className="w-6 h-6 rounded-[6px] flex items-center justify-center text-[#44444b] hover:text-[#ff5c6c] hover:bg-[#ff5c6c10] transition-all"
              >
                <LogOut size={12} />
              </button>
            </div>
          )}
        </div>
      </nav>

      {/* Mobile nav drawer */}
      {/* QA fix: changed absolute -> fixed so the drawer is always anchored to
           the viewport top regardless of the page's positioned ancestors. */}
      {mobileMenuOpen && (
        <div className="md:hidden fixed top-11 left-0 right-0 bg-[#111114] border-b border-[#2a2a31] shadow-xl z-50">
          {navLinks.filter((link) => !link.adminOnly || showAdmin).map((link) => (
            <Link
              key={link.key}
              href={link.href}
              onClick={() => setMobileMenuOpen(false)}
              className={clsx(
                'block px-5 py-3.5 text-[14px] font-medium border-b border-[#1f1f25] transition-colors',
                activePage === link.key
                  ? 'text-[#7c68ff] bg-[#7c68ff08]'
                  : 'text-[#a0a0a7] hover:bg-[#16161a] hover:text-[#e8e8ea]'
              )}
            >
              {link.label}
            </Link>
          ))}
        </div>
      )}

      {/* Notification slide-over panel */}
      {notifOpen && (
        <>
          {/* Backdrop */}
          <div
            className="fixed inset-0 z-40 bg-black/30 backdrop-blur-[1px]"
            onClick={() => setNotifOpen(false)}
          />

          {/* QA fix: use w-full on mobile + cap at 380px so the panel
               doesn't overflow on phones narrower than 380 px (e.g. iPhone SE) */}
          <div className="fixed top-0 right-0 h-full w-full sm:w-[380px] z-50 bg-[#111114] border-l border-[#2a2a31] flex flex-col shadow-2xl">
            {/* Panel header */}
            <div className="flex items-center justify-between px-5 py-4 border-b border-[#2a2a31] flex-shrink-0">
              <div className="flex items-center gap-2.5">
                <Bell size={15} className="text-[#7c68ff]" />
                <span className="text-[14px] font-bold text-[#e8e8ea]">Notifications</span>
                {unread > 0 && (
                  <span className="px-2 py-0.5 rounded-full bg-[#ff5c6c20] border border-[#ff5c6c40] text-[10px] font-bold text-[#ff5c6c]">
                    {unread} unread
                  </span>
                )}
              </div>
              <div className="flex items-center gap-1">
                {unread > 0 && (
                  <button
                    onClick={handleMarkAllRead}
                    title="Mark all as read"
                    className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-[7px] text-[11px] text-[#6c6c74] hover:text-[#a0a0a7] hover:bg-[#16161a] transition-all"
                  >
                    <CheckCheck size={12} />
                    All read
                  </button>
                )}
                {notifications.length > 0 && (
                  <button
                    onClick={handleClearAll}
                    title="Clear all"
                    className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-[7px] text-[11px] text-[#44444b] hover:text-[#ff5c6c] hover:bg-[#ff5c6c10] transition-all"
                  >
                    <Trash2 size={12} />
                    Clear
                  </button>
                )}
                <button
                  onClick={() => setNotifOpen(false)}
                  className="w-7 h-7 flex items-center justify-center rounded-[7px] bg-[#16161a] border border-[#2a2a31] text-[#6c6c74] hover:text-[#e8e8ea] hover:border-[#3a3a45] transition-all ml-1"
                >
                  <X size={13} />
                </button>
              </div>
            </div>

            {/* Notification list */}
            <div className="flex-1 overflow-y-auto">
              {notifications.length === 0 && (
                <div className="flex flex-col items-center justify-center h-full gap-3">
                  <Bell size={32} className="text-[#2a2a31]" />
                  <p className="text-[13px] text-[#44444b]">No notifications</p>
                </div>
              )}
              {notifications.map((notif) => (
                <button
                  key={notif.id}
                  onClick={() => handleMarkRead(notif.id)}
                  className={clsx(
                    'w-full text-left px-5 py-4 border-b border-[#1f1f25] border-l-2 transition-all hover:bg-[#16161a]',
                    severityBorder[notif.severity] ?? 'border-l-transparent',
                    !notif.read && 'bg-[#16161a30]'
                  )}
                >
                  <div className="flex items-start justify-between gap-3">
                    <p className={clsx('text-[13px] leading-relaxed flex-1', notif.read ? 'text-[#6c6c74]' : 'text-[#c9ccd3]')}>
                      {notif.message}
                    </p>
                    {!notif.read && (
                      <div className="w-2 h-2 rounded-full bg-[#7c68ff] flex-shrink-0 mt-1" />
                    )}
                  </div>
                  <p className="text-[10px] text-[#44444b] mt-1.5">{timeAgo(notif.timestamp)}</p>
                </button>
              ))}
            </div>
          </div>
        </>
      )}
    </>
  )
}
