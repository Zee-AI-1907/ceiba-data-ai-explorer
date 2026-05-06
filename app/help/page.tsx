'use client'

import { useState, useEffect, useRef } from 'react'
import Link from 'next/link'
import Image from 'next/image'
import { BookOpen, ArrowLeft, Search } from 'lucide-react'
import { clsx } from 'clsx'

const sections = [
  { id: 'overview',      label: 'Overview' },
  { id: 'data-explorer', label: 'Data Explorer (AI Chat)' },
  { id: 'voice-input',   label: 'Voice Input' },
  { id: 'chart-builder', label: 'Chart Builder' },
  { id: 'dashboards',    label: 'Dashboard Canvas' },
  { id: 'alerts',        label: 'Alerts & Threshold Monitoring' },
  { id: 'reports',       label: 'Scheduled Reports' },
  { id: 'comments',      label: 'Comments & @Mentions' },
  { id: 'export',        label: 'Exporting Data' },
  { id: 'datasets',      label: 'Datasets' },
  { id: 'mobile',        label: 'Mobile / Ward Rounds Mode' },
  { id: 'shortcuts',     label: 'Keyboard Shortcuts' },
]

const shortcuts = [
  { keys: ['Enter'],              action: 'Send chat message' },
  { keys: ['Shift', 'Enter'],     action: 'New line in chat' },
  { keys: ['Cmd/Ctrl', 'Shift', 'M'], action: 'Toggle voice input' },
  { keys: ['Cmd/Ctrl', 'Enter'], action: 'Submit comment' },
  { keys: ['Cmd/Ctrl', 'K'],     action: '(future) Quick search' },
]

function Kbd({ children }: { children: React.ReactNode }) {
  return (
    <kbd className="bg-[#1f1f25] border border-[#3a3a45] rounded-[5px] px-1.5 py-0.5 text-[11px] font-mono text-[#a0a0a7]">
      {children}
    </kbd>
  )
}

function SectionDivider() {
  return <div className="border-t border-[#2a2a31] pt-10 mt-10" />
}

function Screenshot({ src, alt }: { src: string; alt: string }) {
  return (
    <div className="my-6">
      <Image
        src={src}
        alt={alt}
        width={1280}
        height={720}
        className="rounded-[12px] border border-[#2a2a31] shadow-[0_4px_32px_rgba(0,0,0,0.5)] w-full h-auto"
      />
    </div>
  )
}

function BulletList({ items }: { items: string[] }) {
  return (
    <ul className="mt-3 space-y-1.5 list-disc list-inside">
      {items.map((item, i) => (
        <li key={i} className="text-[13px] text-[#c9ccd3] leading-relaxed">
          {item}
        </li>
      ))}
    </ul>
  )
}

export default function HelpPage() {
  const [search, setSearch] = useState('')
  const [activeId, setActiveId] = useState('overview')
  const observerRef = useRef<IntersectionObserver | null>(null)

  const filtered = sections.filter((s) =>
    s.label.toLowerCase().includes(search.toLowerCase())
  )

  useEffect(() => {
    const callback: IntersectionObserverCallback = (entries) => {
      for (const entry of entries) {
        if (entry.isIntersecting) {
          setActiveId(entry.target.id)
          break
        }
      }
    }
    observerRef.current = new IntersectionObserver(callback, {
      rootMargin: '-20% 0px -70% 0px',
      threshold: 0,
    })
    sections.forEach(({ id }) => {
      const el = document.getElementById(id)
      if (el) observerRef.current?.observe(el)
    })
    return () => observerRef.current?.disconnect()
  }, [])

  function scrollTo(id: string) {
    const el = document.getElementById(id)
    if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' })
  }

  return (
    <div className="flex flex-col min-h-screen bg-[#0d0d10] text-[#e8e8ea]">
      {/* Header */}
      <header className="h-11 flex items-center px-5 border-b border-[#1f1f25] flex-shrink-0 gap-4">
        <Link
          href="/data-explorer"
          className="flex items-center gap-1.5 text-[12px] text-[#6c6c74] hover:text-[#a0a0a7] transition-colors"
        >
          <ArrowLeft size={13} />
          Back to app
        </Link>
        <div className="w-px h-4 bg-[#2a2a31]" />
        <div className="flex items-center gap-2">
          <BookOpen size={14} className="text-[#7c68ff]" />
          <span className="text-[13px] font-semibold text-[#e8e8ea]">Help Center</span>
        </div>
      </header>

      <div className="flex flex-1 overflow-hidden">
        {/* Sidebar */}
        <aside className="w-[240px] flex-shrink-0 border-r border-[#2a2a31] flex flex-col overflow-hidden">
          {/* Search */}
          <div className="p-3 border-b border-[#2a2a31]">
            <div className="relative">
              <Search size={12} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-[#44444b]" />
              <input
                type="text"
                placeholder="Search…"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                className="w-full bg-[#16161a] border border-[#2a2a31] rounded-[8px] pl-7 pr-3 py-1.5 text-[12px] text-[#c9ccd3] placeholder-[#44444b] focus:outline-none focus:border-[#7c68ff] transition-colors"
              />
            </div>
          </div>

          {/* Links */}
          <nav className="flex-1 overflow-y-auto py-2">
            {filtered.length === 0 ? (
              <p className="px-4 py-3 text-[12px] text-[#44444b]">
                No results for &ldquo;{search}&rdquo;
              </p>
            ) : (
              filtered.map((s) => (
                <button
                  key={s.id}
                  onClick={() => scrollTo(s.id)}
                  className={clsx(
                    'w-full text-left px-4 py-2 text-[12px] transition-colors rounded-none',
                    activeId === s.id
                      ? 'text-[#7c68ff] bg-[#7c68ff10]'
                      : 'text-[#6c6c74] hover:text-[#c9ccd3] hover:bg-[#16161a]'
                  )}
                >
                  {s.label}
                </button>
              ))
            )}
          </nav>
        </aside>

        {/* Content */}
        <main className="flex-1 overflow-y-auto px-8 py-10">
          <div className="max-w-[720px] mx-auto">

            {/* Overview */}
            <section id="overview">
              <h2 className="text-[22px] font-bold text-[#e8e8ea]">What is Ceiba Data AI Explorer?</h2>
              <p className="mt-3 text-[14px] text-[#a0a0a7] leading-relaxed">
                Ceiba Data AI Explorer is an intelligent analytics platform that lets you explore your data using natural language. Ask questions in plain English, build charts, create dashboards, and set up automated alerts — without writing a single line of SQL.
              </p>
              <p className="mt-3 text-[14px] text-[#a0a0a7] leading-relaxed">
                Designed for clinical and operational teams, it bridges the gap between raw data and actionable insight, letting anyone from a ward nurse to a data engineer get answers fast.
              </p>
              <BulletList items={[
                'Natural language queries powered by AI',
                'Interactive chart and dashboard builder',
                'Threshold-based alerts with real-time monitoring',
                'Scheduled reports delivered to your inbox',
                'Mobile-first ward rounds mode',
              ]} />
            </section>

            <SectionDivider />

            {/* Data Explorer */}
            <section id="data-explorer">
              <h2 className="text-[22px] font-bold text-[#e8e8ea]">Data Explorer (AI Chat)</h2>
              <p className="mt-3 text-[14px] text-[#a0a0a7] leading-relaxed">
                The Data Explorer is the heart of Ceiba Data. Type a question in plain English and the AI translates it into a SQL query, runs it against your connected datasets, and returns results as a table or chart in seconds.
              </p>
              <Screenshot src="/manual/explorer.png" alt="Data Explorer interface" />
              <BulletList items={[
                'Ask questions like "Show me patient admissions last week by ward"',
                'AI automatically selects the right dataset and joins',
                'Results appear inline with a chart preview',
                'Click "View SQL" to inspect or edit the generated query',
                'Pin any result directly to a dashboard',
                'Full query history saved under SQL → Query History',
              ]} />
              <p className="mt-4 text-[13px] text-[#c9ccd3] leading-relaxed">
                Press <Kbd>Enter</Kbd> to send a message, or <Kbd>Shift</Kbd>+<Kbd>Enter</Kbd> for a new line.
              </p>
            </section>

            <SectionDivider />

            {/* Voice Input */}
            <section id="voice-input">
              <h2 className="text-[22px] font-bold text-[#e8e8ea]">Voice Input</h2>
              <p className="mt-3 text-[14px] text-[#a0a0a7] leading-relaxed">
                Hands full on the ward? Use voice input to dictate your question. The microphone button in the chat input activates speech-to-text transcription directly in the browser.
              </p>
              <p className="mt-3 text-[14px] text-[#a0a0a7] leading-relaxed">
                Voice input works best in quiet environments and supports natural phrasing — you don&apos;t need to use exact column names.
              </p>
              <BulletList items={[
                'Click the microphone icon or press Cmd/Ctrl+Shift+M to toggle',
                'Speak your query naturally — the AI handles interpretation',
                'Transcript appears in the chat box for review before sending',
                'Works on desktop Chrome, Edge, and Safari 17+',
                'No audio is stored — transcription happens locally in your browser',
              ]} />
              <p className="mt-4 text-[13px] text-[#c9ccd3] leading-relaxed">
                Shortcut: <Kbd>Cmd/Ctrl</Kbd>+<Kbd>Shift</Kbd>+<Kbd>M</Kbd>
              </p>
            </section>

            <SectionDivider />

            {/* Chart Builder */}
            <section id="chart-builder">
              <h2 className="text-[22px] font-bold text-[#e8e8ea]">Chart Builder</h2>
              <p className="mt-3 text-[14px] text-[#a0a0a7] leading-relaxed">
                The Chart Builder lets you create and configure visualisations from any dataset. Choose your chart type, map your axes, apply filters, and customise colours — all without code.
              </p>
              <Screenshot src="/manual/chart-builder.png" alt="Chart Builder interface" />
              <Screenshot src="/manual/charts.png" alt="Charts list" />
              <BulletList items={[
                'Supports bar, line, area, pie, scatter, and table chart types',
                'Drag-and-drop column mapping for X, Y, and group-by axes',
                'Real-time preview updates as you configure',
                'Apply date range filters and dimension filters',
                'Save charts to your library for reuse in dashboards',
                'Export any chart as PNG or copy embed code',
              ]} />
            </section>

            <SectionDivider />

            {/* Dashboards */}
            <section id="dashboards">
              <h2 className="text-[22px] font-bold text-[#e8e8ea]">Dashboard Canvas</h2>
              <p className="mt-3 text-[14px] text-[#a0a0a7] leading-relaxed">
                Dashboards let you arrange multiple charts onto a single canvas for at-a-glance monitoring. Build layouts with drag-and-drop, resize panels, and share with your team.
              </p>
              <Screenshot src="/manual/dashboard-builder.png" alt="Dashboard builder" />
              <Screenshot src="/manual/dashboards.png" alt="Dashboards list" />
              <BulletList items={[
                'Drag panels from the sidebar onto the canvas grid',
                'Resize and reorder panels freely',
                'Add text, divider, and metric summary widgets',
                'Global date range filter applies to all charts simultaneously',
                'Share a live link or export as PDF',
                'Set a dashboard as your homepage for quick access',
              ]} />
            </section>

            <SectionDivider />

            {/* Alerts */}
            <section id="alerts">
              <h2 className="text-[22px] font-bold text-[#e8e8ea]">Alerts &amp; Threshold Monitoring</h2>
              <p className="mt-3 text-[14px] text-[#a0a0a7] leading-relaxed">
                Set threshold-based alerts on any metric. When a value crosses your defined threshold, Ceiba Data notifies you instantly via in-app notification, email, or webhook.
              </p>
              <Screenshot src="/manual/alerts.png" alt="Alerts configuration" />
              <BulletList items={[
                'Create alerts from any chart or query result',
                'Conditions: greater than, less than, equals, percentage change',
                'Set severity: critical, warning, or info',
                'Notification channels: in-app bell, email, Slack webhook',
                'Mute alerts temporarily with a snooze duration',
                'Alert history shows every trigger with timestamps',
              ]} />
            </section>

            <SectionDivider />

            {/* Reports */}
            <section id="reports">
              <h2 className="text-[22px] font-bold text-[#e8e8ea]">Scheduled Reports</h2>
              <p className="mt-3 text-[14px] text-[#a0a0a7] leading-relaxed">
                Schedule any dashboard or chart to be emailed as a PDF or CSV on a recurring basis. Reports can be sent daily, weekly, or monthly to any recipient list.
              </p>
              <Screenshot src="/manual/reports.png" alt="Scheduled reports" />
              <BulletList items={[
                'Schedule from any dashboard or saved chart',
                'Frequency options: daily, weekly, monthly, custom cron',
                'Deliver as PDF snapshot, CSV data, or both',
                'Add multiple email recipients (comma-separated)',
                'Preview the report before scheduling',
                'Edit or pause schedules at any time from the Reports page',
              ]} />
            </section>

            <SectionDivider />

            {/* Comments */}
            <section id="comments">
              <h2 className="text-[22px] font-bold text-[#e8e8ea]">Comments &amp; @Mentions</h2>
              <p className="mt-3 text-[14px] text-[#a0a0a7] leading-relaxed">
                Add comments to any chart or dashboard panel to share context with your team. Use @mentions to notify specific colleagues and keep conversations attached to the data.
              </p>
              <BulletList items={[
                'Click the comment icon on any chart panel to open the thread',
                'Type @name to mention a teammate — they receive an in-app notification',
                'Threads are attached to the specific chart version',
                'Resolve threads to keep conversations tidy',
                'Comment history is retained even if the chart is updated',
              ]} />
              <p className="mt-4 text-[13px] text-[#c9ccd3] leading-relaxed">
                Submit a comment: <Kbd>Cmd/Ctrl</Kbd>+<Kbd>Enter</Kbd>
              </p>
            </section>

            <SectionDivider />

            {/* Export */}
            <section id="export">
              <h2 className="text-[22px] font-bold text-[#e8e8ea]">Exporting Data (CSV &amp; Excel)</h2>
              <p className="mt-3 text-[14px] text-[#a0a0a7] leading-relaxed">
                Any query result or chart dataset can be exported in seconds. Downloads are scoped to the currently active filters, so what you see is what you get.
              </p>
              <BulletList items={[
                'Export as CSV for quick spreadsheet use',
                'Export as Excel (.xlsx) with formatted headers',
                'Chart exports include the underlying data table',
                'Dashboard exports produce a multi-sheet Excel workbook',
                'Large exports are queued and emailed when ready',
                'All exports are logged in the audit trail',
              ]} />
            </section>

            <SectionDivider />

            {/* Datasets */}
            <section id="datasets">
              <h2 className="text-[22px] font-bold text-[#e8e8ea]">Datasets</h2>
              <p className="mt-3 text-[14px] text-[#a0a0a7] leading-relaxed">
                Datasets are the data sources the AI queries against. Admins can connect databases, upload CSVs, or define virtual datasets from existing tables.
              </p>
              <Screenshot src="/manual/datasets.png" alt="Datasets management" />
              <BulletList items={[
                'Browse available datasets from the Datasets page',
                'Each dataset shows schema, row count, and last refresh time',
                'Virtual datasets let you define a saved SQL query as a reusable source',
                'Admins can manage permissions per dataset',
                'Upload CSV to create a temporary dataset for ad-hoc analysis',
                'Datasets auto-refresh on a configurable schedule',
              ]} />
            </section>

            <SectionDivider />

            {/* Mobile */}
            <section id="mobile">
              <h2 className="text-[22px] font-bold text-[#e8e8ea]">Mobile / Ward Rounds Mode</h2>
              <p className="mt-3 text-[14px] text-[#a0a0a7] leading-relaxed">
                Ward Rounds Mode is a mobile-optimised view designed for clinicians checking key metrics at the bedside. It strips away the builder UI and focuses on your pinned dashboards and most recent alerts.
              </p>
              <BulletList items={[
                'Automatically activates on screen widths below 768px',
                'Pinned dashboards appear as large tap targets',
                'Swipe between panels on a single dashboard',
                'Voice input is foregrounded for quick hands-free queries',
                'Alert badge count visible at all times in the header',
                'Offline cache shows last-known data when connectivity drops',
              ]} />
            </section>

            <SectionDivider />

            {/* Shortcuts */}
            <section id="shortcuts">
              <h2 className="text-[22px] font-bold text-[#e8e8ea]">Keyboard Shortcuts</h2>
              <p className="mt-3 text-[14px] text-[#a0a0a7] leading-relaxed">
                Speed up your workflow with these keyboard shortcuts. They work anywhere inside the Ceiba Data interface.
              </p>
              <div className="mt-5 border border-[#2a2a31] rounded-[10px] overflow-hidden">
                <table className="w-full text-[13px]">
                  <thead>
                    <tr className="bg-[#16161a] border-b border-[#2a2a31]">
                      <th className="text-left px-4 py-2.5 text-[11px] font-semibold text-[#6c6c74] uppercase tracking-wider">Shortcut</th>
                      <th className="text-left px-4 py-2.5 text-[11px] font-semibold text-[#6c6c74] uppercase tracking-wider">Action</th>
                    </tr>
                  </thead>
                  <tbody>
                    {shortcuts.map((row, i) => (
                      <tr key={i} className={clsx('border-b border-[#1f1f25]', i === shortcuts.length - 1 && 'border-b-0')}>
                        <td className="px-4 py-3">
                          <div className="flex items-center gap-1 flex-wrap">
                            {row.keys.map((k, ki) => (
                              <span key={ki} className="flex items-center gap-1">
                                <Kbd>{k}</Kbd>
                                {ki < row.keys.length - 1 && (
                                  <span className="text-[10px] text-[#44444b]">+</span>
                                )}
                              </span>
                            ))}
                          </div>
                        </td>
                        <td className="px-4 py-3 text-[#c9ccd3]">{row.action}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>

          </div>
        </main>
      </div>
    </div>
  )
}
