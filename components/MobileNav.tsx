'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { Home, MessageSquare, BarChart2, LayoutDashboard, Database } from 'lucide-react'
import { clsx } from 'clsx'

const TABS = [
  { key: 'home',       label: 'Home',       icon: Home,            href: '/' },
  { key: 'explorer',   label: 'Explorer',   icon: MessageSquare,   href: '/data-explorer' },
  { key: 'charts',     label: 'Charts',     icon: BarChart2,       href: '/charts' },
  { key: 'dashboards', label: 'Dashboards', icon: LayoutDashboard, href: '/dashboards' },
  { key: 'datasets',   label: 'Datasets',   icon: Database,        href: '/datasets' },
]

function getActiveTab(pathname: string) {
  if (pathname.startsWith('/charts')) return 'charts'
  if (pathname.startsWith('/dashboards')) return 'dashboards'
  if (pathname.startsWith('/datasets')) return 'datasets'
  if (pathname.startsWith('/data-explorer')) return 'explorer'
  if (pathname === '/') return 'home'
  return 'explorer'
}

export default function MobileNav() {
  const pathname = usePathname()
  const activeTab = getActiveTab(pathname)

  return (
    <nav
      className="md:hidden fixed bottom-0 left-0 right-0 z-50 bg-[#0d0d10] border-t border-[#2a2a31]"
      style={{ paddingBottom: 'env(safe-area-inset-bottom)' }}
    >
      <div className="flex items-stretch h-14">
        {TABS.map((tab) => {
          const isActive = activeTab === tab.key
          return (
            <Link
              key={tab.key}
              href={tab.href}
              className={clsx(
                'flex-1 flex flex-col items-center justify-center gap-0.5 transition-colors min-h-[44px] active:bg-[#1a1a20]',
                isActive ? 'text-[#7c68ff]' : 'text-[#6c6c74]'
              )}
            >
              <tab.icon size={19} strokeWidth={isActive ? 2.5 : 1.5} />
              <span className="text-[9px] font-semibold tracking-wide">{tab.label}</span>
            </Link>
          )
        })}
      </div>
    </nav>
  )
}
