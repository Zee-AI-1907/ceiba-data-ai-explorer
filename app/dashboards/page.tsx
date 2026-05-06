'use client'

import { useState, useEffect } from 'react'
import { useRouter } from 'next/navigation'
import DataNav from '@/components/DataNav'
import { getDashboards, fetchDashboards, type Dashboard as StoredDashboard } from '@/lib/store'
import { Star, ChevronDown, Plus, Download, Search, Pencil, Trash2, Share2, ArrowUpDown, ArrowDown, LayoutDashboard, MoreVertical } from 'lucide-react'
import { clsx } from 'clsx'

const DASHBOARDS = [
  { name: 'Direct Calls Overview',        status: 'Draft',     owners: ['HA'], modified: '4 days ago' },
  { name: 'Consultations Test',            status: 'Draft',     owners: ['SA'], modified: '2 months ago' },
  { name: 'COVID Vaccine Dashboard',       status: 'Published', owners: [],     modified: '3 months ago' },
  { name: 'Unicode Test',                  status: 'Published', owners: [],     modified: '3 months ago' },
  { name: 'Natalie Dashboard',             status: 'Draft',     owners: ['SA'], modified: '7 months ago' },
  { name: 'FCC New Coder Survey 2018',     status: 'Published', owners: [],     modified: '7 months ago' },
  { name: 'Sales Dashboard',               status: 'Published', owners: [],     modified: '7 months ago' },
  { name: 'Video Game Sales',              status: 'Published', owners: [],     modified: '7 months ago' },
  { name: 'Slack Dashboard',               status: 'Published', owners: [],     modified: '7 months ago' },
  { name: 'Featured Charts',               status: 'Published', owners: [],     modified: '7 months ago' },
  { name: 'deck.gl Demo',                  status: 'Published', owners: [],     modified: '7 months ago' },
  { name: 'Misc Charts',                   status: 'Draft',     owners: [],     modified: '7 months ago' },
  { name: 'USA Births Names',              status: 'Published', owners: [],     modified: '7 months ago' },
  { name: "World Bank's Data",             status: 'Published', owners: [],     modified: '7 months ago' },
  { name: 'COVID Vaccine Dashboard [copy]',status: 'Draft',     owners: ['SA'], modified: '7 months ago' },
]

const OWNER_COLORS: Record<string, string> = {
  HA: '#4ec9c9',
  SA: '#6c84d8',
  FC: '#a0b896',
}

function OwnerAvatar({ code }: { code: string }) {
  return (
    <span
      className="inline-flex items-center justify-center w-6 h-6 rounded-full text-[10px] font-bold text-[#0b0b0c]"
      style={{ backgroundColor: OWNER_COLORS[code] ?? '#6c6c74' }}
    >
      {code}
    </span>
  )
}

function StatusBadge({ status }: { status: string }) {
  return status === 'Published'
    ? <span className="text-[#4dcc88] text-[12px] font-medium">Published</span>
    : <span className="text-[#6c6c74] text-[12px] font-medium">Draft</span>
}

export default function DashboardsPage() {
  const [hoveredRow, setHoveredRow]   = useState<number | null>(null)
  const [currentPage, setCurrentPage] = useState(1)
  const [storedDashboards, setStoredDashboards] = useState<StoredDashboard[]>([])
  const router = useRouter()
  const totalPages = 3

  useEffect(() => {
    // Seed from localStorage immediately for instant render
    const local = getDashboards()
    setStoredDashboards(local)
    // Then hydrate from API (may have dashboards from other sessions)
    fetchDashboards().then((remote) => {
      if (remote.length > 0) {
        // Merge: local takes priority, then add any remote-only ones
        const localIds = new Set(local.map((d) => d.id))
        const remoteOnly = remote.filter((d: StoredDashboard) => !localIds.has(d.id))
        setStoredDashboards([...local, ...remoteOnly])
      }
    }).catch(() => {})
  }, [])

  // Merge: localStorage dashboards first, then static ones
  const allDashboards = [
    ...storedDashboards.map((d) => ({
      id: d.id,
      name: d.name,
      status: d.status,
      owners: ['You'],
      modified: 'Just now',
    })),
    ...DASHBOARDS.map((d) => ({ ...d, id: undefined })),
  ]

  const handleRowClick = (id: string | undefined) => {
    if (id) router.push(`/dashboards/${id}`)
  }

  return (
    <div className="min-h-screen bg-[#0b0b0c] text-[#e8e8ea] flex flex-col">
      <DataNav activePage="dashboards" />

      {/* Header */}
      <div className="flex items-center justify-between px-6 py-4 border-b border-[#1f1f25]">
        <h1 className="text-[17px] font-semibold text-[#e8e8ea]">Dashboards</h1>
        <div className="flex items-center gap-2">
          <button className="px-3 py-1.5 text-[12px] font-medium text-[#a0a0a7] border border-[#2a2a31] rounded-[8px] hover:bg-[#16161a] hover:text-[#e8e8ea] transition-colors">
            BULK SELECT
          </button>
          <button
            onClick={() => router.push('/dashboards/new')}
            className="flex items-center gap-1.5 px-3 py-1.5 text-[12px] font-semibold text-white rounded-[8px] bg-[#7c68ff] hover:bg-[#9080ff] shadow-[0_2px_10px_rgba(124,104,255,0.3)] transition-all"
          >
            <Plus size={13} /> DASHBOARD
          </button>
          <button className="w-8 h-8 flex items-center justify-center border border-[#2a2a31] rounded-[8px] text-[#6c6c74] hover:bg-[#16161a] hover:text-[#a0a0a7] transition-colors">
            <Download size={14} />
          </button>
        </div>
      </div>

      {/* Filter bar */}
      <div className="flex items-end gap-3 px-6 py-3 border-b border-[#1f1f25] flex-wrap">
        {/* QA fix: replaced JSX fragments in array (no keys) with explicit keyed buttons */}
        <div className="flex items-center gap-1.5 self-end mb-0.5">
          <button className="w-7 h-7 flex items-center justify-center border border-[#2a2a31] rounded-[7px] text-[#6c6c74] hover:bg-[#16161a] hover:text-[#a0a0a7] transition-colors">
            <svg width="13" height="13" viewBox="0 0 14 14" fill="none">
              <rect x="1" y="1" width="5" height="5" rx="0.5" fill="currentColor"/>
              <rect x="8" y="1" width="5" height="5" rx="0.5" fill="currentColor"/>
              <rect x="1" y="8" width="5" height="5" rx="0.5" fill="currentColor"/>
              <rect x="8" y="8" width="5" height="5" rx="0.5" fill="currentColor"/>
            </svg>
          </button>
          <button className="w-7 h-7 flex items-center justify-center border border-[#2a2a31] rounded-[7px] text-[#6c6c74] hover:bg-[#16161a] hover:text-[#a0a0a7] transition-colors">
            <svg width="13" height="13" viewBox="0 0 14 14" fill="none">
              <rect x="1" y="2" width="12" height="1.5" rx="0.5" fill="currentColor"/>
              <rect x="1" y="6.25" width="12" height="1.5" rx="0.5" fill="currentColor"/>
              <rect x="1" y="10.5" width="12" height="1.5" rx="0.5" fill="currentColor"/>
            </svg>
          </button>
        </div>

        <div className="flex flex-col gap-1">
          <span className="text-[10px] font-semibold text-[#44444b] uppercase tracking-wider">Name</span>
          <div className="flex items-center gap-1.5 border border-[#2a2a31] rounded-[8px] px-2.5 py-1.5 bg-[#16161a] min-w-[180px]">
            <Search size={12} className="text-[#6c6c74]" />
            <input className="text-[12px] text-[#a0a0a7] outline-none w-full bg-transparent placeholder-[#44444b]" placeholder="Search by name" />
          </div>
        </div>

        {['Status', 'Owner', 'Favorite', 'Certified', 'Modified By'].map((label) => (
          <div key={label} className="flex flex-col gap-1">
            <span className="text-[10px] font-semibold text-[#44444b] uppercase tracking-wider">{label}</span>
            <button className="flex items-center justify-between gap-2 border border-[#2a2a31] rounded-[8px] px-2.5 py-1.5 bg-[#16161a] text-[12px] text-[#44444b] min-w-[150px] hover:border-[#3a3a45] hover:text-[#6c6c74] transition-colors">
              <span>Select or type a value</span>
              <ChevronDown size={11} />
            </button>
          </div>
        ))}
      </div>

      {/* Mobile card list */}
      <div className="md:hidden flex-1 overflow-y-auto pb-16">
        {allDashboards.map((row, i) => (
          <div
            key={i}
            className="flex items-center justify-between px-4 py-3.5 border-b border-[#1f1f25] active:bg-[#16161a] cursor-pointer"
            onClick={() => handleRowClick((row as { id?: string }).id)}
          >
            <div className="flex-1 min-w-0 mr-3">
              <p className="text-[13px] font-medium text-[#4c8dff] truncate mb-1">{row.name}</p>
              <div className="flex items-center gap-2">
                <span className={clsx(
                  'text-[10px] font-semibold px-1.5 py-0.5 rounded-[5px]',
                  row.status === 'Published'
                    ? 'bg-[#4dcc8820] text-[#4dcc88]'
                    : 'bg-[#6c6c7420] text-[#6c6c74]'
                )}>{row.status}</span>
                <span className="text-[11px] text-[#6c6c74]">{row.modified}</span>
              </div>
            </div>
            <button className="w-11 h-11 flex items-center justify-center text-[#44444b] hover:text-[#a0a0a7] flex-shrink-0">
              <MoreVertical size={16} />
            </button>
          </div>
        ))}
      </div>

      {/* Table - desktop only */}
      <div className="hidden md:block flex-1 overflow-x-auto">
        <table className="w-full">
          <thead>
            <tr className="border-b border-[#2a2a31] bg-[#111114]">
              <th className="w-10 px-4 py-3"><input type="checkbox" className="rounded border-[#3a3a45] bg-[#16161a] accent-[#7c68ff]" /></th>
              <th className="w-8 px-2 py-3 text-[#44444b]"><Star size={13} /></th>
              <th className="px-4 py-3 text-left">
                <button className="flex items-center gap-1 text-[11px] font-semibold text-[#6c6c74] uppercase tracking-wider hover:text-[#a0a0a7]">Name <ArrowUpDown size={11} /></button>
              </th>
              <th className="px-4 py-3 text-left">
                <button className="flex items-center gap-1 text-[11px] font-semibold text-[#6c6c74] uppercase tracking-wider hover:text-[#a0a0a7]">Status <ArrowUpDown size={11} /></button>
              </th>
              <th className="px-4 py-3 text-left text-[11px] font-semibold text-[#6c6c74] uppercase tracking-wider">Owners</th>
              <th className="px-4 py-3 text-left">
                <button className="flex items-center gap-1 text-[11px] font-semibold text-[#6c6c74] uppercase tracking-wider hover:text-[#a0a0a7]">Last Modified <ArrowDown size={11} /></button>
              </th>
              <th className="px-4 py-3 text-left text-[11px] font-semibold text-[#6c6c74] uppercase tracking-wider">Actions</th>
            </tr>
          </thead>
          <tbody>
            {allDashboards.map((row, i) => (
              <tr
                key={i}
                className={clsx('border-b border-[#1f1f25] transition-colors cursor-pointer', hoveredRow === i ? 'bg-[#16161a]' : i % 2 === 1 ? 'bg-[#0f0f12]' : '')}
                onMouseEnter={() => setHoveredRow(i)}
                onMouseLeave={() => setHoveredRow(null)}
                onClick={() => handleRowClick((row as { id?: string }).id)}
              >
                <td className="px-4 py-2.5"><input type="checkbox" className="rounded border-[#3a3a45] bg-[#16161a] accent-[#7c68ff]" /></td>
                <td className="px-2 py-2.5 text-[#44444b] hover:text-[#f4a942]"><Star size={13} /></td>
                <td className="px-4 py-2.5 text-[13px] text-[#4c8dff] hover:underline">{row.name}</td>
                <td className="px-4 py-2.5"><StatusBadge status={row.status} /></td>
                <td className="px-4 py-2.5">
                  <div className="flex items-center gap-1">{row.owners.map((o) => <OwnerAvatar key={o} code={o} />)}</div>
                </td>
                <td className="px-4 py-2.5 text-[12px] text-[#6c6c74]">{row.modified}</td>
                <td className="px-4 py-2.5">
                  {hoveredRow === i && (
                    <div className="flex items-center gap-3 text-[#6c6c74]">
                      <button className="hover:text-[#a0a0a7] transition-colors"><Pencil size={13} /></button>
                      <button className="hover:text-[#a0a0a7] transition-colors"><Share2 size={13} /></button>
                      <button className="hover:text-[#ff5c6c] transition-colors"><Trash2 size={13} /></button>
                    </div>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* Pagination */}
      <div className="flex items-center justify-center gap-1 py-4 border-t border-[#1f1f25]">
        {Array.from({ length: totalPages }, (_, i) => i + 1).map((page) => (
          <button
            key={page}
            onClick={() => setCurrentPage(page)}
            className={clsx(
              'w-8 h-8 text-[12px] font-medium rounded-[7px] transition-colors',
              currentPage === page
                ? 'bg-[#7c68ff] text-white shadow-[0_2px_8px_rgba(124,104,255,0.4)]'
                : 'text-[#6c6c74] hover:bg-[#16161a] hover:text-[#a0a0a7]'
            )}
          >
            {page}
          </button>
        ))}
      </div>
    </div>
  )
}
