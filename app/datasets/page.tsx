'use client'

import { useState } from 'react'
import DataNav from '@/components/DataNav'
import { ChevronDown, Plus, Download, Search, Pencil, Trash2, Share2, ArrowUpDown, ArrowDown, LayoutGrid } from 'lucide-react'
import { clsx } from 'clsx'

const DATASETS = [
  { name: 'Consultations Detail query',              type: 'Virtual', database: 'TeleHealth.DB', schema: 'public', owners: ['HA'], modified: '28 days ago' },
  { name: 'Call Sessions',                           type: 'Virtual', database: 'TeleHealth.DB', schema: 'public', owners: ['HA'], modified: '28 days ago' },
  { name: 'Direct Calls Query 01/25/2026 13:28:19',  type: 'Virtual', database: 'TeleHealth.DB', schema: '',       owners: ['HA'], modified: '28 days ago' },
  { name: 'Call Level Dataset',                      type: 'Virtual', database: 'TeleHealth.DB', schema: 'public', owners: ['HA'], modified: 'a month ago' },
  { name: 'Untitled Query 4',                        type: 'Virtual', database: 'TeleHealth.DB', schema: '',       owners: ['HA'], modified: 'a month ago' },
  { name: 'Untitled Query 1 02/25/2026 15:14:57',    type: 'Virtual', database: 'Eclinics.DB',   schema: '',       owners: ['HA'], modified: '2 months ago' },
  { name: 'Apache II 23.02',                         type: 'Virtual', database: 'Eclinics.DB',   schema: '',       owners: ['FC'], modified: '2 months ago' },
  { name: 'GKS',                                     type: 'Virtual', database: 'Eclinics.DB',   schema: '',       owners: ['FC'], modified: '2 months ago' },
  { name: 'Untitled Query 1',                        type: 'Virtual', database: 'Eclinics.DB',   schema: '',       owners: ['HA'], modified: '2 months ago' },
  { name: 'Untitled Query 1 02/23/2026 16:21:21',    type: 'Virtual', database: 'Eclinics.DB',   schema: '',       owners: ['HA'], modified: '2 months ago' },
  { name: 'Untitled Query 4 02/23/2026 16:04:09',    type: 'Virtual', database: 'Eclinics.DB',   schema: 'ICU',    owners: ['HA'], modified: '2 months ago' },
  { name: 'Critcal Patients 02/20/2026 11:21:37',    type: 'Virtual', database: 'Eclinics.DB',   schema: '',       owners: ['HA'], modified: '2 months ago' },
  { name: 'Critical Patients Last Week',             type: 'Virtual', database: 'Eclinics.DB',   schema: '',       owners: ['HA'], modified: '2 months ago' },
  { name: 'Call Users',                              type: 'Virtual', database: 'TeleHealth.DB', schema: 'public', owners: ['HA'], modified: '2 months ago' },
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

export default function DatasetsPage() {
  const [hoveredRow, setHoveredRow]   = useState<number | null>(null)
  const [currentPage, setCurrentPage] = useState(1)
  const totalPages = 3

  return (
    <div className="min-h-screen bg-[#0b0b0c] text-[#e8e8ea] flex flex-col pb-16 md:pb-0">
      <DataNav activePage="datasets" />

      {/* Header */}
      <div className="flex items-center justify-between px-4 md:px-6 py-4 border-b border-[#1f1f25]">
        <h1 className="text-[17px] font-semibold text-[#e8e8ea]">Datasets</h1>
        <div className="flex items-center gap-2">
          <button className="hidden md:block px-3 py-1.5 text-[12px] font-medium text-[#a0a0a7] border border-[#2a2a31] rounded-[8px] hover:bg-[#16161a] hover:text-[#e8e8ea] transition-colors">
            BULK SELECT
          </button>
          <button className="flex items-center gap-1.5 px-3 py-1.5 min-h-[44px] md:min-h-0 text-[12px] font-semibold text-white rounded-[8px] bg-[#7c68ff] hover:bg-[#9080ff] shadow-[0_2px_10px_rgba(124,104,255,0.3)] transition-all">
            <Plus size={13} /> DATASET
          </button>
          <button className="w-10 h-10 md:w-8 md:h-8 flex items-center justify-center border border-[#2a2a31] rounded-[8px] text-[#6c6c74] hover:bg-[#16161a] hover:text-[#a0a0a7] transition-colors">
            <Download size={14} />
          </button>
        </div>
      </div>

      {/* Filter bar */}
      <div className="flex items-end gap-3 px-6 py-3 border-b border-[#1f1f25] flex-wrap">
        <div className="flex flex-col gap-1">
          <span className="text-[10px] font-semibold text-[#44444b] uppercase tracking-wider">Name</span>
          <div className="flex items-center gap-1.5 border border-[#2a2a31] rounded-[8px] px-2.5 py-1.5 bg-[#16161a] min-w-[180px]">
            <Search size={12} className="text-[#6c6c74]" />
            <input className="text-[12px] text-[#a0a0a7] outline-none w-full bg-transparent placeholder-[#44444b]" placeholder="Search by name" />
          </div>
        </div>

        {['Type', 'Database', 'Schema', 'Owner', 'Certified', 'Modified By'].map((label) => (
          <div key={label} className="flex flex-col gap-1">
            <span className="text-[10px] font-semibold text-[#44444b] uppercase tracking-wider">{label}</span>
            <button className="flex items-center justify-between gap-2 border border-[#2a2a31] rounded-[8px] px-2.5 py-1.5 bg-[#16161a] text-[12px] text-[#44444b] min-w-[150px] hover:border-[#3a3a45] hover:text-[#6c6c74] transition-colors">
              <span>Select or type a value</span>
              <ChevronDown size={11} />
            </button>
          </div>
        ))}
      </div>

      {/* Table */}
      <div className="flex-1 overflow-x-auto">
        <table className="w-full">
          <thead>
            <tr className="border-b border-[#2a2a31] bg-[#111114]">
              <th className="w-10 px-4 py-3"><input type="checkbox" className="rounded border-[#3a3a45] bg-[#16161a] accent-[#7c68ff]" /></th>
              <th className="w-8 px-2 py-3 text-[#44444b]"><LayoutGrid size={13} /></th>
              <th className="px-4 py-3 text-left">
                <button className="flex items-center gap-1 text-[11px] font-semibold text-[#6c6c74] uppercase tracking-wider hover:text-[#a0a0a7]">Name <ArrowUpDown size={11} /></button>
              </th>
              <th className="px-4 py-3 text-left text-[11px] font-semibold text-[#6c6c74] uppercase tracking-wider">Type</th>
              <th className="px-4 py-3 text-left">
                <button className="flex items-center gap-1 text-[11px] font-semibold text-[#6c6c74] uppercase tracking-wider hover:text-[#a0a0a7]">Database <ArrowUpDown size={11} /></button>
              </th>
              <th className="px-4 py-3 text-left">
                <button className="flex items-center gap-1 text-[11px] font-semibold text-[#6c6c74] uppercase tracking-wider hover:text-[#a0a0a7]">Schema <ArrowUpDown size={11} /></button>
              </th>
              <th className="px-4 py-3 text-left text-[11px] font-semibold text-[#6c6c74] uppercase tracking-wider">Owners</th>
              <th className="px-4 py-3 text-left">
                <button className="flex items-center gap-1 text-[11px] font-semibold text-[#6c6c74] uppercase tracking-wider hover:text-[#a0a0a7]">Last Modified <ArrowDown size={11} /></button>
              </th>
              <th className="px-4 py-3 text-left text-[11px] font-semibold text-[#6c6c74] uppercase tracking-wider">Actions</th>
            </tr>
          </thead>
          <tbody>
            {DATASETS.map((row, i) => (
              <tr
                key={i}
                className={clsx('border-b border-[#1f1f25] transition-colors cursor-pointer', hoveredRow === i ? 'bg-[#16161a]' : i % 2 === 1 ? 'bg-[#0f0f12]' : '')}
                onMouseEnter={() => setHoveredRow(i)}
                onMouseLeave={() => setHoveredRow(null)}
              >
                <td className="px-4 py-2.5"><input type="checkbox" className="rounded border-[#3a3a45] bg-[#16161a] accent-[#7c68ff]" /></td>
                <td className="px-2 py-2.5"><LayoutGrid size={13} className="text-[#4ec9c9]" /></td>
                <td className="px-4 py-2.5 text-[13px] text-[#4c8dff] hover:underline">{row.name}</td>
                <td className="px-4 py-2.5 text-[12px] text-[#a0a0a7]">{row.type}</td>
                <td className="px-4 py-2.5 text-[12px] text-[#4c8dff] hover:underline">{row.database}</td>
                <td className="px-4 py-2.5 text-[12px] text-[#a0a0a7]">
                  {row.schema || <span className="text-[#3a3a45]">—</span>}
                </td>
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
