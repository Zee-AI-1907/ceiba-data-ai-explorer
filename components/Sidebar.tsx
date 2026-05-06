'use client'

import {
  BarChart2,
  LayoutDashboard,
  Table2,
  Code2,
  ChevronLeft,
  Plus,
  CheckCircle2,
  XCircle,
  Clock,
  Trash2,
  History,
} from 'lucide-react'
import { useState, useEffect } from 'react'
import { useRouter, usePathname } from 'next/navigation'
import { clsx } from 'clsx'

// ── Query persistence ────────────────────────────────────────────────────────
export type SavedQuery = {
  id: string
  label: string
  sql: string
  status: 'idle' | 'success' | 'error'
  createdAt: string
  lastRunAt?: string
}

const QUERIES_KEY = 'ceiba_queries'

export function getSavedQueries(): SavedQuery[] {
  if (typeof window === 'undefined') return []
  try { return JSON.parse(localStorage.getItem(QUERIES_KEY) || '[]') } catch { return [] }
}

export function upsertQuery(q: SavedQuery) {
  const all = getSavedQueries()
  const idx = all.findIndex(x => x.id === q.id)
  if (idx >= 0) all[idx] = q
  else all.unshift(q)
  localStorage.setItem(QUERIES_KEY, JSON.stringify(all.slice(0, 50)))
}

export function deleteQuery(id: string) {
  localStorage.setItem(QUERIES_KEY, JSON.stringify(getSavedQueries().filter(q => q.id !== id)))
}

// ── Nav items ────────────────────────────────────────────────────────────────
const NAV_ITEMS = [
  { label: 'Dashboards', icon: LayoutDashboard, href: '/dashboards' },
  { label: 'Charts',     icon: BarChart2,       href: '/charts' },
  { label: 'Datasets',   icon: Table2,          href: '/datasets' },
  { label: 'SQL Lab',    icon: Code2,           href: '/data-explorer' },
]

type SidebarProps = {
  activePage?: string
  activeQueryId?: string
  onQuerySelect?: (query: SavedQuery) => void
  onNewQuery?: () => void
}

export function Sidebar({ activePage = 'data-explorer', activeQueryId, onQuerySelect, onNewQuery }: SidebarProps) {
  const [collapsed, setCollapsed] = useState(false)
  const [queries, setQueries] = useState<SavedQuery[]>([])
  const [hoveredQuery, setHoveredQuery] = useState<string | null>(null)
  const router = useRouter()

  useEffect(() => {
    const load = () => setQueries(getSavedQueries())
    load()
    window.addEventListener('storage', load)
    window.addEventListener('ceiba_queries_updated', load)
    return () => {
      window.removeEventListener('storage', load)
      window.removeEventListener('ceiba_queries_updated', load)
    }
  }, [])

  const handleDeleteQuery = (e: React.MouseEvent, id: string) => {
    e.stopPropagation()
    deleteQuery(id)
    setQueries(getSavedQueries())
    window.dispatchEvent(new Event('ceiba_queries_updated'))
  }

  const handleQueryClick = (q: SavedQuery) => {
    if (onQuerySelect) onQuerySelect(q)
    else router.push(`/data-explorer?q=${q.id}`)
  }

  return (
    <aside className={clsx(
      'flex flex-col h-full bg-[#111114] border-r border-[#1f1f25] transition-all duration-200 flex-shrink-0',
      collapsed ? 'w-[56px]' : 'w-[240px]'
    )}>

      {/* ── Brand ── */}
      <div className="flex items-center justify-between px-4 py-3.5 border-b border-[#1f1f25] flex-shrink-0">
        {!collapsed && (
          <div className="flex items-center gap-2.5">
            <div className="w-6 h-6 rounded-md bg-[#7c68ff] flex items-center justify-center flex-shrink-0">
              <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
                <rect x="1" y="1" width="5" height="5" rx="1.2" fill="white" opacity="0.9"/>
                <rect x="8" y="1" width="5" height="5" rx="1.2" fill="white" opacity="0.6"/>
                <rect x="1" y="8" width="5" height="5" rx="1.2" fill="white" opacity="0.6"/>
                <rect x="8" y="8" width="5" height="5" rx="1.2" fill="white" opacity="0.9"/>
              </svg>
            </div>
            <span className="text-[13px] font-semibold text-[#e8e8ea] tracking-tight">Ceiba Data</span>
          </div>
        )}
        <button
          onClick={() => setCollapsed(!collapsed)}
          className="w-6 h-6 rounded flex items-center justify-center text-[#6c6c74] hover:text-[#a0a0a7] hover:bg-[#1b1b20] transition-colors flex-shrink-0"
        >
          <ChevronLeft size={14} className={clsx('transition-transform duration-200', collapsed && 'rotate-180')} />
        </button>
      </div>

      {/* ── Scrollable body ── */}
      <div className="flex-1 flex flex-col overflow-hidden">
        <div className="flex-1 overflow-y-auto px-2 pt-3 pb-2">

          {/* Section label: EXPLORE */}
          {!collapsed && (
            <p className="px-2 mb-2 text-[10px] font-semibold text-[#44444b] tracking-widest uppercase">
              Explore
            </p>
          )}

          {/* ── QUERIES (right below Explore, above Dashboards) ── */}
          {!collapsed && (
            <div className="mb-3">
              {/* Queries header — same style as nav items */}
              <div className="flex items-center justify-between px-2.5 py-2 rounded-[8px] hover:bg-[#16161a] transition-all group cursor-default mb-1">
                <div className="flex items-center gap-2.5">
                  <History size={15} className="flex-shrink-0 text-[#6c6c74] group-hover:text-[#a0a0a7] transition-colors" />
                  <span className="text-[13px] font-medium text-[#a0a0a7] group-hover:text-[#e8e8ea] transition-colors">Queries</span>
                </div>
                <button
                  onClick={onNewQuery}
                  title="New query"
                  className="w-5 h-5 rounded-[5px] flex items-center justify-center text-[#44444b] hover:text-[#a0a0a7] hover:bg-[#2a2a31] transition-colors"
                >
                  <Plus size={12} />
                </button>
              </div>

              {/* Query list */}
              {queries.length === 0 ? (
                <p className="text-[11px] text-[#3a3a45] px-2 py-1.5">No queries yet</p>
              ) : (
                <div className="space-y-0.5 max-h-[200px] overflow-y-auto">
                  {queries.map((q) => (
                    <div
                      key={q.id}
                      onClick={() => handleQueryClick(q)}
                      onMouseEnter={() => setHoveredQuery(q.id)}
                      onMouseLeave={() => setHoveredQuery(null)}
                      className={clsx(
                        'flex items-center gap-2 px-2.5 py-1.5 rounded-[8px] cursor-pointer transition-all',
                        q.id === activeQueryId
                          ? 'bg-[#1b1b24] text-[#e8e8ea] shadow-[0_0_0_1px_#7c68ff40]'
                          : 'text-[#a0a0a7] hover:bg-[#16161a] hover:text-[#e8e8ea]'
                      )}
                    >
                      <div className="flex-shrink-0">
                        {q.status === 'success' && <CheckCircle2 size={11} className="text-[#4dcc88]" />}
                        {q.status === 'error'   && <XCircle size={11} className="text-[#ff5c6c]" />}
                        {q.status === 'idle'    && <Clock size={11} className="text-[#44444b]" />}
                      </div>
                      <span className="text-[12px] font-medium truncate flex-1">{q.label}</span>
                      {hoveredQuery === q.id && (
                        <button
                          onClick={(e) => handleDeleteQuery(e, q.id)}
                          className="flex-shrink-0 text-[#44444b] hover:text-[#ff5c6c] transition-colors"
                        >
                          <Trash2 size={11} />
                        </button>
                      )}
                    </div>
                  ))}
                </div>
              )}

              {/* Divider */}
              <div className="mt-3 border-t border-[#1f1f25]" />
            </div>
          )}

          {/* Collapsed: show History icon like other nav items */}
          {collapsed && (
            <button
              onClick={onNewQuery}
              title="Queries"
              className="flex items-center justify-center w-full px-0 py-2 rounded-[8px] text-[#6c6c74] hover:bg-[#16161a] hover:text-[#a0a0a7] transition-colors mb-1"
            >
              <History size={15} />
            </button>
          )}

          {/* ── NAV items: Dashboards, Charts, Datasets, SQL Lab ── */}
          <div className="space-y-0.5">
            {NAV_ITEMS.map((item) => {
              const isActive = activePage === item.href.replace('/', '')
              return (
                <a
                  key={item.href}
                  href={item.href}
                  className={clsx(
                    'flex items-center gap-2.5 px-2.5 py-2 rounded-[8px] transition-all group',
                    isActive
                      ? 'bg-[#16161a] text-[#e8e8ea] shadow-[0_0_0_1px_#4c8dff40,inset_0_0_0_1px_#4c8dff20]'
                      : 'text-[#a0a0a7] hover:bg-[#16161a] hover:text-[#e8e8ea]',
                    collapsed && 'justify-center px-0'
                  )}
                >
                  <item.icon size={15} className={clsx('flex-shrink-0', isActive ? 'text-[#4c8dff]' : 'text-[#6c6c74] group-hover:text-[#a0a0a7]')} />
                  {!collapsed && <span className="text-[13px] font-medium truncate">{item.label}</span>}
                  {isActive && !collapsed && <div className="ml-auto w-1 h-1 rounded-full bg-[#4c8dff]" />}
                </a>
              )
            })}
          </div>

        </div>
      </div>

      {/* ── User ── */}
      <div className="border-t border-[#1f1f25] px-3 py-3 flex-shrink-0">
        <div className={clsx('flex items-center gap-2.5', collapsed && 'justify-center')}>
          <div className="w-7 h-7 rounded-full bg-gradient-to-br from-[#7c68ff] to-[#4c8dff] flex items-center justify-center flex-shrink-0">
            <span className="text-[10px] font-bold text-white">AF</span>
          </div>
          {!collapsed && (
            <div>
              <p className="text-[12px] font-semibold text-[#e8e8ea] leading-tight">Afsin Alp</p>
              <p className="text-[11px] text-[#6c6c74] leading-tight">Istanbul</p>
            </div>
          )}
        </div>
      </div>

    </aside>
  )
}
