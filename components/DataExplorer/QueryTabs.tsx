'use client'

import { X, Plus } from 'lucide-react'
import { clsx } from 'clsx'

export type QueryTab = {
  id: string
  label: string
  status: 'idle' | 'running' | 'error' | 'modified' | 'success'
}

type Props = {
  tabs: QueryTab[]
  activeTabId: string
  onTabClick: (id: string) => void
  onTabClose: (id: string) => void
  onNewTab: () => void
}

const STATUS_DOT: Record<QueryTab['status'], string> = {
  idle: 'bg-[#44444b]',
  running: 'bg-[#4c8dff] animate-pulse',
  error: 'bg-[#ff5c6c]',
  modified: 'bg-[#f4a942]',
  success: 'bg-[#4dcc88]',
}

export function QueryTabs({ tabs, activeTabId, onTabClick, onTabClose, onNewTab }: Props) {
  return (
    <div className="flex items-stretch border-b border-[#2a2a31] bg-[#111114] flex-shrink-0">
      {/* Tabs row */}
      <div className="flex items-stretch overflow-x-auto tabs-scroll flex-1">
        {tabs.map((tab) => {
          const isActive = tab.id === activeTabId
          return (
            <div
              key={tab.id}
              className={clsx(
                'group flex items-center gap-1.5 px-3.5 py-2.5 border-r border-[#1f1f25] cursor-pointer select-none flex-shrink-0 transition-colors relative',
                isActive
                  ? 'bg-[#16161a] text-[#e8e8ea]'
                  : 'text-[#6c6c74] hover:bg-[#141418] hover:text-[#a0a0a7]'
              )}
              onClick={() => onTabClick(tab.id)}
            >
              {/* Active underline */}
              {isActive && (
                <div className="absolute bottom-0 left-0 right-0 h-[2px] bg-[#7c68ff] rounded-t" />
              )}
              {/* Status dot */}
              <div
                className={clsx(
                  'w-1.5 h-1.5 rounded-full flex-shrink-0',
                  STATUS_DOT[tab.status]
                )}
              />
              {/* Label */}
              <span className="text-[12px] font-medium whitespace-nowrap">{tab.label}</span>
              {/* Close */}
              <button
                className={clsx(
                  'w-4 h-4 rounded flex items-center justify-center transition-all opacity-0 group-hover:opacity-100 hover:bg-[#2a2a31] flex-shrink-0',
                  isActive && 'opacity-60 hover:opacity-100'
                )}
                onClick={(e) => {
                  e.stopPropagation()
                  onTabClose(tab.id)
                }}
              >
                <X size={10} />
              </button>
            </div>
          )
        })}
      </div>

      {/* New tab button */}
      <button
        className="px-3 flex items-center justify-center text-[#6c6c74] hover:text-[#a0a0a7] hover:bg-[#141418] border-l border-[#1f1f25] transition-colors flex-shrink-0"
        onClick={onNewTab}
      >
        <Plus size={14} />
      </button>
    </div>
  )
}
