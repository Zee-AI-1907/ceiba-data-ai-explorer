'use client'

import { useState } from 'react'
import Link from 'next/link'
import { ChevronDown, Plus, Settings } from 'lucide-react'
import { clsx } from 'clsx'

type ActivePage = 'dashboards' | 'charts' | 'datasets' | 'sql'

interface DataNavProps {
  activePage: ActivePage
}

const navLinks: { key: ActivePage; label: string; href: string; hasDrop?: boolean }[] = [
  { key: 'dashboards', label: 'Dashboards', href: '/dashboards' },
  { key: 'charts',     label: 'Charts',     href: '/charts' },
  { key: 'datasets',   label: 'Datasets',   href: '/datasets' },
  { key: 'sql',        label: 'SQL',        href: '/data-explorer', hasDrop: true },
]

export default function DataNav({ activePage }: DataNavProps) {
  const [sqlOpen, setSqlOpen] = useState(false)

  return (
    <nav className="flex items-stretch h-11 bg-[#0d0d10] border-b border-[#1f1f25] px-4 relative z-50 flex-shrink-0">

      {/* Logo — clickable, goes to SQL Lab (main page) */}
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

      {/* Nav links */}
      <div className="flex items-stretch flex-1">
        {navLinks.map((link) => {
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

      {/* Right side */}
      <div className="flex items-center gap-2">
        <div className="flex items-center gap-1.5 mr-4">
          <div className="w-1.5 h-1.5 rounded-full bg-[#4dcc88]" />
          <span className="text-[11px] text-[#6c6c74]">All systems operational</span>
        </div>
        <button className="w-7 h-7 rounded-[8px] bg-[#16161a] border border-[#2a2a31] flex items-center justify-center text-[#6c6c74] hover:text-[#a0a0a7] hover:border-[#3a3a45] transition-all">
          <Plus size={13} />
        </button>
        <button className="flex items-center gap-1.5 h-7 px-3 rounded-[8px] bg-[#16161a] border border-[#2a2a31] text-[11px] text-[#a0a0a7] hover:text-[#e8e8ea] hover:border-[#3a3a45] transition-all font-medium">
          <Settings size={11} />
          Settings
        </button>
      </div>
    </nav>
  )
}
