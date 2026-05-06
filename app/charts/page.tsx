'use client'

import { useState } from 'react'
import DataNav from '@/components/DataNav'
import Link from 'next/link'
import { Star, ChevronDown, Plus, Download, Search, Pencil, Trash2, Share2, ArrowUpDown, ArrowDown, X, MoreVertical } from 'lucide-react'
import { clsx } from 'clsx'
import { CommentButton } from '@/components/Comments/CommentButton'
import { CommentThread } from '@/components/Comments/CommentThread'
import { slugify } from '@/lib/commentStore'

const CHARTS = [
  { name: 'Call Duration by User',                    type: 'Bar Chart',                dataset: 'Direct Calls Query 01/25/2026 13:28:19', dashboard: 'Direct Calls Overview', owners: ['HA'], modified: '28 days ago' },
  { name: 'Direct Calls by User',                     type: 'Bar Chart',                dataset: 'Direct Calls Query 01/25/2026 13:28:19', dashboard: 'Direct Calls Overview', owners: ['HA'], modified: '28 days ago' },
  { name: 'Direct Calls by Session',                  type: 'Pie Chart',                dataset: 'public.Call Sessions',                   dashboard: 'Direct Calls Overview', owners: ['HA'], modified: '28 days ago' },
  { name: 'Call Duration by Call Purposes',           type: 'Table',                    dataset: 'public.Call Level Dataset',              dashboard: 'Direct Calls Overview', owners: ['HA'], modified: 'a month ago' },
  { name: 'Average Call Duration',                    type: 'Big Number',               dataset: 'public.Call Level Dataset',              dashboard: 'Direct Calls Overview', owners: ['HA'], modified: 'a month ago' },
  { name: 'Total Call Duration',                      type: 'Big Number',               dataset: 'public.Call Level Dataset',              dashboard: 'Direct Calls Overview', owners: ['HA'], modified: 'a month ago' },
  { name: 'ICD KODLU HASTALARIN LİSTESİ',             type: 'Pivot Table',              dataset: 'Untitled Query 4',                       dashboard: '',                      owners: ['HA'], modified: 'a month ago' },
  { name: 'mekanik vent,ilatöre bağlı hasta listesi', type: 'Pie Chart',                dataset: 'Untitled Query 1',                       dashboard: '',                      owners: ['HA'], modified: '2 months ago' },
  { name: 'Monthly Direct Calls',                     type: 'Big Number with Trendline',dataset: 'Direct Calls Query 01/25/2026 13:28:19', dashboard: 'Direct Calls Overview', owners: ['HA'], modified: '2 months ago' },
  { name: 'Detail Table',                             type: 'Table',                    dataset: 'Direct Calls Query 01/25/2026 13:28:19', dashboard: 'Direct Calls Overview', owners: ['HA'], modified: '2 months ago' },
  { name: 'Interpreter Languages',                    type: 'Pie Chart',                dataset: 'Direct Calls Query 01/25/2026 13:28:19', dashboard: 'Direct Calls Overview', owners: ['HA'], modified: '2 months ago' },
  { name: 'Direct Call Purposes Chart',               type: 'Pie Chart',                dataset: 'Direct Calls Query 01/25/2026 13:28:19', dashboard: 'Direct Calls Overview', owners: ['HA'], modified: '2 months ago' },
  { name: 'Monthly Interpreter Calls',                type: 'Big Number with Trendline',dataset: 'Direct Calls Query 01/25/2026 13:28:19', dashboard: 'Direct Calls Overview', owners: ['HA'], modified: '2 months ago' },
  { name: 'Pump Alerts by DrugGUID',                  type: 'Pie Chart',                dataset: 'public.drug_alerts',                     dashboard: '',                      owners: ['HA'], modified: '3 months ago' },
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

export default function ChartsPage() {
  const [hoveredRow, setHoveredRow]     = useState<number | null>(null)
  const [currentPage, setCurrentPage]   = useState(1)
  const [activeComment, setActiveComment] = useState<string | null>(null) // resourceId
  const [activeLabel, setActiveLabel]   = useState<string>('')
  const totalPages = 3

  const openComments = (name: string) => {
    const rid = slugify(name)
    if (activeComment === rid) {
      setActiveComment(null)
    } else {
      setActiveComment(rid)
      setActiveLabel(name)
    }
  }

  return (
    <div className="min-h-screen bg-[#0b0b0c] text-[#e8e8ea] flex flex-col">
      <DataNav activePage="charts" />

      {/* Header */}
      <div className="flex items-center justify-between px-6 py-4 border-b border-[#1f1f25]">
        <h1 className="text-[17px] font-semibold text-[#e8e8ea]">Charts</h1>
        <div className="flex items-center gap-2">
          <button className="px-3 py-1.5 text-[12px] font-medium text-[#a0a0a7] border border-[#2a2a31] rounded-[8px] hover:bg-[#16161a] hover:text-[#e8e8ea] transition-colors">
            BULK SELECT
          </button>
          <Link
            href="/charts/new"
            className="flex items-center gap-1.5 px-3 py-1.5 text-[12px] font-semibold text-white rounded-[8px] bg-[#7c68ff] hover:bg-[#9080ff] shadow-[0_2px_10px_rgba(124,104,255,0.3)] transition-all"
          >
            <Plus size={13} /> CHART
          </Link>
          <button className="w-8 h-8 flex items-center justify-center border border-[#2a2a31] rounded-[8px] text-[#6c6c74] hover:bg-[#16161a] hover:text-[#a0a0a7] transition-colors">
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

        {['Type', 'Dataset', 'Owner', 'Dashboard', 'Favorite', 'Certified', 'Modified By'].map((label) => (
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
        {CHARTS.map((row, i) => (
          <div key={i} className="flex items-center justify-between px-4 py-3.5 border-b border-[#1f1f25] active:bg-[#16161a] cursor-pointer">
            <div className="flex-1 min-w-0 mr-3">
              <p className="text-[13px] font-medium text-[#4c8dff] truncate mb-1">{row.name}</p>
              <div className="flex items-center gap-2 flex-wrap">
                <span className="text-[10px] font-semibold px-1.5 py-0.5 rounded-[5px] bg-[#7c68ff20] text-[#7c68ff]">{row.type}</span>
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
              <th className="px-4 py-3 text-left text-[11px] font-semibold text-[#6c6c74] uppercase tracking-wider">Type</th>
              <th className="px-4 py-3 text-left text-[11px] font-semibold text-[#6c6c74] uppercase tracking-wider">Dataset</th>
              <th className="px-4 py-3 text-left text-[11px] font-semibold text-[#6c6c74] uppercase tracking-wider">On Dashboards</th>
              <th className="px-4 py-3 text-left text-[11px] font-semibold text-[#6c6c74] uppercase tracking-wider">Owners</th>
              <th className="px-4 py-3 text-left">
                <button className="flex items-center gap-1 text-[11px] font-semibold text-[#6c6c74] uppercase tracking-wider hover:text-[#a0a0a7]">Last Modified <ArrowDown size={11} /></button>
              </th>
              <th className="px-4 py-3 text-left text-[11px] font-semibold text-[#6c6c74] uppercase tracking-wider">Actions</th>
              <th className="w-12 px-2 py-3" />
            </tr>
          </thead>
          <tbody>
            {CHARTS.map((row, i) => (
              <tr
                key={i}
                className={clsx('border-b border-[#1f1f25] transition-colors cursor-pointer', hoveredRow === i ? 'bg-[#16161a]' : i % 2 === 1 ? 'bg-[#0f0f12]' : '')}
                onMouseEnter={() => setHoveredRow(i)}
                onMouseLeave={() => setHoveredRow(null)}
              >
                <td className="px-4 py-2.5"><input type="checkbox" className="rounded border-[#3a3a45] bg-[#16161a] accent-[#7c68ff]" /></td>
                <td className="px-2 py-2.5 text-[#44444b]"><Star size={13} /></td>
                <td className="px-4 py-2.5 text-[13px] text-[#4c8dff] hover:underline">{row.name}</td>
                <td className="px-4 py-2.5 text-[12px] text-[#a0a0a7]">{row.type}</td>
                <td className="px-4 py-2.5 text-[12px] text-[#4c8dff] hover:underline">{row.dataset}</td>
                <td className="px-4 py-2.5 text-[12px]">
                  {row.dashboard
                    ? <span className="text-[#4c8dff] hover:underline">{row.dashboard}</span>
                    : <span className="text-[#3a3a45]">—</span>}
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
                <td className="px-2 py-2.5">
                  <CommentButton
                    resourceType="chart"
                    resourceId={slugify(row.name)}
                    isOpen={activeComment === slugify(row.name)}
                    onClick={() => openComments(row.name)}
                  />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {/* End desktop table */}

      {/* Chart comment modal */}
      {activeComment && (
        <>
          <div
            className="fixed inset-0 z-40 bg-black/40"
            onClick={() => setActiveComment(null)}
          />
          <div className="fixed inset-0 z-50 flex items-center justify-center pointer-events-none">
            <div className="pointer-events-auto w-[400px] max-h-[600px] bg-[#0d0d10] border border-[#2a2a31] rounded-[14px] shadow-2xl flex flex-col overflow-hidden">
              <CommentThread
                resourceType="chart"
                resourceId={activeComment}
                resourceLabel={activeLabel}
                onClose={() => setActiveComment(null)}
                mode="inline"
              />
            </div>
          </div>
        </>
      )}

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
