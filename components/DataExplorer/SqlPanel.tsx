'use client'

import { useState, useRef } from 'react'
import {
  Play,
  Save,
  Link,
  ChevronDown,
  ChevronRight,
  MoreHorizontal,
  FileQuestion,
  History,
  Database,
  FileDown,
  Sheet,
} from 'lucide-react'
import * as XLSX from 'xlsx'
import { clsx } from 'clsx'
import { SqlHighlight } from './SqlHighlight'
import { NarrativePanel, NarrativeResult } from './NarrativePanel'

type ResultsTab = 'results' | 'history'

type Column = { key: string; label: string; type?: string }
type Row = Record<string, unknown>

type Props = {
  sql: string
  onSqlChange: (sql: string) => void
  onRun: () => void
  isRunning: boolean
  runTime?: string
  limit?: number
  onLimitChange?: (v: number) => void
  results?: { columns: Column[]; rows: Row[] } | null
  dbLabel?: string
  isStreaming?: boolean
  selectedDb?: 'telehealth' | 'eclinics'
  onDbChange?: (db: 'telehealth' | 'eclinics') => void
  narrative?: NarrativeResult | null
  isGeneratingNarrative?: boolean
  onNarrativeRequest?: (columns: Column[], rows: Row[], question: string) => void
  onNarrativeDismiss?: () => void
  /** When true, forces SQL editor open (used for mobile SQL tab) */
  forceSqlOpen?: boolean
}

const LIMIT_OPTIONS = [100, 500, 1000, 5000, 10000]

const DB_OPTIONS: { id: 'telehealth' | 'eclinics'; label: string; description: string }[] = [
  { id: 'telehealth', label: 'TeleHealth.DB', description: 'clinical operations' },
  { id: 'eclinics', label: 'Eclinics.DB', description: 'critical care & ICU' },
]

export function SqlPanel({
  sql,
  onSqlChange,
  onRun,
  isRunning,
  runTime = '00:00:00.00',
  limit = 1000,
  onLimitChange,
  results,
  dbLabel = 'DATABASE & SCHEMA',
  isStreaming = false,
  selectedDb = 'telehealth',
  onDbChange,
  narrative,
  isGeneratingNarrative,
  onNarrativeDismiss,
  forceSqlOpen = false,
}: Props) {
  const [resultsTab, setResultsTab] = useState<ResultsTab>('results')
  const [editing, setEditing] = useState(false)
  const [showLimitMenu, setShowLimitMenu] = useState(false)
  const [activeLine, setActiveLine] = useState<number | undefined>(3)
  const [dbPanelOpen, setDbPanelOpen] = useState(false)
  const [showDbDropdown, setShowDbDropdown] = useState(false)
  const [sqlEditorOpen, setSqlEditorOpen] = useState(false)
  const textareaRef = useRef<HTMLTextAreaElement>(null)

  const activeDb = DB_OPTIONS.find((d) => d.id === selectedDb) ?? DB_OPTIONS[0]

  const lineCount = sql.split('\n').length

  return (
    <div className="flex flex-col h-full bg-[#111114]">
      {/* DB label — with selector dropdown */}
      <div className="border-b border-[#2a2a31] bg-[#0d0d10] flex-shrink-0">
        <div className="flex items-center justify-between px-4 py-2">
          {/* Left: db selector (clickable) */}
          <div className="relative">
            <button
              onClick={() => setShowDbDropdown((o) => !o)}
              className="flex items-center gap-2 px-2 py-1 rounded-[6px] hover:bg-[#16161a] transition-all group"
            >
              <div className="w-1.5 h-1.5 rounded-full bg-[#4dcc88] flex-shrink-0" />
              <Database size={11} className="text-[#44444b]" />
              <span className="text-[11px] text-[#c9ccd3] font-medium">{activeDb.label}</span>
              <ChevronDown
                size={10}
                className={clsx('text-[#44444b] transition-transform duration-200', showDbDropdown && 'rotate-180')}
              />
            </button>

            {/* DB dropdown */}
            {showDbDropdown && (
              <div className="absolute top-full left-0 mt-1 bg-[#16161a] border border-[#2a2a31] rounded-[10px] shadow-card overflow-hidden z-50 min-w-[200px]">
                {DB_OPTIONS.map((opt) => (
                  <button
                    key={opt.id}
                    onClick={() => {
                      onDbChange?.(opt.id)
                      setShowDbDropdown(false)
                    }}
                    className={clsx(
                      'w-full text-left px-3.5 py-2.5 flex items-center gap-2.5 transition-colors',
                      opt.id === selectedDb
                        ? 'bg-[#7c68ff10]'
                        : 'hover:bg-[#1b1b20]'
                    )}
                  >
                    <div
                      className={clsx(
                        'w-1.5 h-1.5 rounded-full flex-shrink-0',
                        opt.id === selectedDb ? 'bg-[#4dcc88]' : 'bg-[#44444b]'
                      )}
                    />
                    <div className="flex flex-col">
                      <span
                        className={clsx(
                          'text-[12px] font-medium',
                          opt.id === selectedDb ? 'text-[#e8e8ea]' : 'text-[#a0a0a7]'
                        )}
                      >
                        {opt.label}
                      </span>
                      <span className="text-[10px] text-[#44444b]">{opt.description}</span>
                    </div>
                  </button>
                ))}
              </div>
            )}
          </div>

          {/* Right: small toggle button for details */}
          <button
            onClick={() => setDbPanelOpen((o) => !o)}
            title={dbPanelOpen ? 'Hide connection details' : 'Show connection details'}
            className="flex items-center gap-1 px-2 py-0.5 rounded-[5px] text-[#3a3a45] hover:text-[#6c6c74] hover:bg-[#16161a] transition-all"
          >
            <span className="text-[10px]">{dbPanelOpen ? 'hide' : 'details'}</span>
            <ChevronRight
              size={10}
              className={clsx('transition-transform duration-200', dbPanelOpen && 'rotate-90')}
            />
          </button>
        </div>

        {/* Expandable panel */}
        {dbPanelOpen && (
          <div className="px-4 pb-3 pt-1 border-t border-[#1f1f25] flex gap-4">
            <div className="flex flex-col gap-1">
              <span className="text-[10px] font-semibold text-[#44444b] uppercase tracking-wider">Database</span>
              <div className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-[7px] bg-[#16161a] border border-[#2a2a31]">
                <div className="w-1.5 h-1.5 rounded-full bg-[#4dcc88]" />
                <span className="text-[12px] text-[#c9ccd3] font-medium">{activeDb.label}</span>
              </div>
            </div>
            <div className="flex flex-col gap-1">
              <span className="text-[10px] font-semibold text-[#44444b] uppercase tracking-wider">Schema</span>
              <div className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-[7px] bg-[#16161a] border border-[#2a2a31]">
                <span className="text-[12px] text-[#c9ccd3] font-medium">public</span>
              </div>
            </div>
          </div>
        )}
      </div>

      {/* SQL Editor — hidden by default, toggle via toolbar button */}
      {(forceSqlOpen || sqlEditorOpen) && (
        <div className="flex-1 overflow-auto relative" style={{ minHeight: 0, maxHeight: '50%' }}>
          {editing ? (
            <textarea
              ref={textareaRef}
              value={sql}
              onChange={(e) => onSqlChange(e.target.value)}
              onBlur={() => setEditing(false)}
              autoFocus
              spellCheck={false}
              className="w-full h-full sql-editor bg-transparent text-[#c9ccd3] resize-none outline-none p-4 pl-12 leading-[1.65]"
            />
          ) : (
            <div
              className={clsx('p-4 cursor-text min-h-full bg-[#111114]', isStreaming && 'streaming-cursor')}
              onClick={() => !isStreaming && setEditing(true)}
            >
              <SqlHighlight sql={sql} activeLine={activeLine} />
            </div>
          )}
        </div>
      )}

      {/* Toolbar — QA fix: added overflow-x-auto so buttons don't get clipped
           on narrow panels (mobile SQL tab or small desktop viewports) */}
      <div className="flex items-center gap-2 px-3 py-2.5 border-t border-b border-[#2a2a31] bg-[#0d0d10] flex-shrink-0 overflow-x-auto">
        {/* Run button */}
        <button
          onClick={onRun}
          disabled={isRunning}
          className={clsx(
            'flex items-center gap-1.5 px-4 py-1.5 rounded-[8px] text-[12px] font-semibold transition-all flex-shrink-0',
            isRunning
              ? 'bg-[#4dcc8840] text-[#4dcc88] cursor-not-allowed'
              : 'bg-[#4dcc88] text-[#0b0b0c] hover:bg-[#5fdb97] shadow-[0_2px_10px_rgba(77,204,136,0.35)]'
          )}
        >
          <Play size={11} fill="currentColor" />
          {isRunning ? 'Running…' : 'Run'}
        </button>

        {/* Limit dropdown */}
        <div className="relative">
          <button
            className="flex items-center gap-1 px-2.5 py-1.5 rounded-[8px] bg-[#16161a] border border-[#2a2a31] text-[11px] text-[#a0a0a7] hover:text-[#e8e8ea] hover:border-[#3a3a45] transition-all"
            onClick={() => setShowLimitMenu(!showLimitMenu)}
          >
            <span className="text-[#6c6c74]">LIMIT:</span>
            <span className="font-semibold">{limit.toLocaleString()}</span>
            <ChevronDown size={9} />
          </button>
          {showLimitMenu && (
            <div className="absolute top-full left-0 mt-1 bg-[#16161a] border border-[#2a2a31] rounded-[10px] shadow-card overflow-hidden z-50 min-w-[100px]">
              {LIMIT_OPTIONS.map((opt) => (
                <button
                  key={opt}
                  onClick={() => {
                    onLimitChange?.(opt)
                    setShowLimitMenu(false)
                  }}
                  className={clsx(
                    'w-full text-left px-3.5 py-2 text-[12px] transition-colors',
                    opt === limit
                      ? 'text-[#7c68ff] bg-[#7c68ff10]'
                      : 'text-[#a0a0a7] hover:bg-[#1b1b20] hover:text-[#e8e8ea]'
                  )}
                >
                  {opt.toLocaleString()}
                </button>
              ))}
            </div>
          )}
        </div>

        {/* Timer */}
        <div className="flex items-center gap-1.5 px-2.5 py-1 rounded-[6px] bg-[#ff5c6c15] border border-[#ff5c6c25]">
          <div className={clsx('w-1.5 h-1.5 rounded-full', isRunning ? 'bg-[#ff5c6c] pulse-dot' : 'bg-[#ff5c6c40]')} />
          <span className="text-[11px] font-mono text-[#ff5c6c] font-semibold tracking-wider">
            {runTime}
          </span>
        </div>

        {/* SQL toggle */}
        <button
          onClick={() => !forceSqlOpen && setSqlEditorOpen((o) => !o)}
          title={(forceSqlOpen || sqlEditorOpen) ? 'Hide SQL' : 'Show SQL'}
          className={clsx(
            'flex items-center gap-1 px-2.5 py-1.5 rounded-[8px] border text-[11px] font-medium transition-all',
            (forceSqlOpen || sqlEditorOpen)
              ? 'bg-[#7c68ff20] border-[#7c68ff50] text-[#7c68ff] hover:bg-[#7c68ff30]'
              : 'bg-[#16161a] border-[#2a2a31] text-[#6c6c74] hover:text-[#a0a0a7] hover:border-[#3a3a45]'
          )}
        >
          <ChevronDown
            size={11}
            className={clsx('transition-transform duration-200', (forceSqlOpen || sqlEditorOpen) ? 'rotate-180' : '')}
          />
          {(forceSqlOpen || sqlEditorOpen) ? 'Hide SQL' : 'SQL'}
        </button>

        <div className="flex-1" />

        {/* Save */}
        <button className="flex items-center gap-1.5 px-3 py-1.5 rounded-[8px] bg-[#16161a] border border-[#2a2a31] text-[11px] text-[#a0a0a7] hover:text-[#e8e8ea] hover:border-[#3a3a45] transition-all font-medium">
          <Save size={11} />
          Save
        </button>

        {/* Split Save dropdown */}
        <button className="w-6 h-[30px] flex items-center justify-center rounded-[8px] bg-[#16161a] border border-[#2a2a31] text-[#6c6c74] hover:text-[#a0a0a7] hover:border-[#3a3a45] transition-all -ml-1.5">
          <ChevronDown size={10} />
        </button>

        {/* Copy Link */}
        <button className="flex items-center gap-1.5 px-3 py-1.5 rounded-[8px] bg-[#16161a] border border-[#2a2a31] text-[11px] text-[#a0a0a7] hover:text-[#e8e8ea] hover:border-[#3a3a45] transition-all font-medium">
          <Link size={11} />
          Copy Link
        </button>

        {/* More */}
        <button className="w-7 h-[30px] flex items-center justify-center rounded-[8px] bg-[#16161a] border border-[#2a2a31] text-[#6c6c74] hover:text-[#a0a0a7] hover:border-[#3a3a45] transition-all">
          <MoreHorizontal size={13} />
        </button>
      </div>

      {/* Results tabs + export buttons */}
      <div className="flex items-center border-b border-[#2a2a31] px-4 bg-[#0d0d10] flex-shrink-0">
        {/* Tabs */}
        <div className="flex flex-1">
          {(['results', 'history'] as ResultsTab[]).map((tab) => (
            <button
              key={tab}
              onClick={() => setResultsTab(tab)}
              className={clsx(
                'flex items-center gap-1.5 px-1 py-2.5 text-[11px] font-semibold tracking-wider uppercase mr-5 border-b-2 transition-colors',
                resultsTab === tab
                  ? 'text-[#e8e8ea] border-[#7c68ff]'
                  : 'text-[#6c6c74] border-transparent hover:text-[#a0a0a7]'
              )}
            >
              {tab === 'results' ? <FileQuestion size={11} /> : <History size={11} />}
              {tab === 'results' ? 'Results' : 'Query History'}
            </button>
          ))}
        </div>

        {/* Export buttons — only visible when results exist */}
        {results && results.rows.length > 0 && resultsTab === 'results' && (
          <div className="flex items-center gap-1.5 py-1.5">
            {/* CSV export */}
            <button
              onClick={() => exportCSV(results)}
              className="flex items-center gap-1.5 px-3 py-1 rounded-[7px] bg-[#16161a] border border-[#2a2a31] text-[11px] font-semibold text-[#4dcc88] hover:bg-[#4dcc8815] hover:border-[#4dcc8840] transition-all"
              title="Export as CSV"
            >
              <FileDown size={11} />
              CSV
            </button>
            {/* Excel export */}
            <button
              onClick={() => exportExcel(results)}
              className="flex items-center gap-1.5 px-3 py-1 rounded-[7px] bg-[#16161a] border border-[#2a2a31] text-[11px] font-semibold text-[#4c8dff] hover:bg-[#4c8dff15] hover:border-[#4c8dff40] transition-all"
              title="Export as Excel"
            >
              <Sheet size={11} />
              Excel
            </button>
          </div>
        )}
      </div>

      {/* AI Narrative Panel */}
      {(isGeneratingNarrative || narrative) && (
        <NarrativePanel
          narrative={narrative}
          isGenerating={isGeneratingNarrative}
          onRegenerate={undefined}
          onDismiss={onNarrativeDismiss}
        />
      )}

      {/* Results area */}
      <div className="flex-1 overflow-auto min-h-0 bg-[#0d0d10]">
        {resultsTab === 'results' && (
          <>
            {results && results.rows.length > 0 ? (
              <ResultsTable columns={results.columns} rows={results.rows} />
            ) : (
              <ResultsEmptyState isRunning={isRunning} />
            )}
          </>
        )}
        {resultsTab === 'history' && <HistoryEmptyState />}
      </div>
    </div>
  )
}

// ── Export helpers ─────────────────────────────────────────────────────────

function exportCSV(results: { columns: Column[]; rows: Row[] }) {
  // Build header row from column labels
  const header = results.columns.map((c) => `"${c.label}"`).join(',')
  // Build data rows, escaping quotes inside values
  const dataRows = results.rows.map((row) =>
    results.columns
      .map((c) => {
        const val = row[c.key] == null ? '' : String(row[c.key])
        return `"${val.replace(/"/g, '""')}"`
      })
      .join(',')
  )
  const csv = [header, ...dataRows].join('\n')
  triggerDownload(csv, 'ceiba-results.csv', 'text/csv;charset=utf-8;')
}

function exportExcel(results: { columns: Column[]; rows: Row[] }) {
  // Build worksheet data: first row = headers, then data rows
  const wsData = [
    results.columns.map((c) => c.label),
    ...results.rows.map((row) =>
      results.columns.map((c) => (row[c.key] == null ? '' : row[c.key]))
    ),
  ]
  const ws = XLSX.utils.aoa_to_sheet(wsData)
  const wb = XLSX.utils.book_new()
  XLSX.utils.book_append_sheet(wb, ws, 'Results')
  // Write and trigger download as .xlsx
  XLSX.writeFile(wb, 'ceiba-results.xlsx')
}

function triggerDownload(content: string, filename: string, mimeType: string) {
  const blob = new Blob([content], { type: mimeType })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  a.click()
  URL.revokeObjectURL(url)
}

function ResultsEmptyState({ isRunning }: { isRunning: boolean }) {
  return (
    <div className="flex flex-col items-center justify-center h-full gap-3 py-10">
      <div className="w-14 h-16 flex items-center justify-center opacity-20">
        <svg width="40" height="52" viewBox="0 0 40 52" fill="none">
          <rect x="0.5" y="0.5" width="39" height="51" rx="3.5" stroke="#a0a0a7" strokeWidth="1" fill="none" />
          <line x1="8" y1="14" x2="32" y2="14" stroke="#a0a0a7" strokeWidth="1.2" />
          <line x1="8" y1="22" x2="32" y2="22" stroke="#a0a0a7" strokeWidth="1.2" />
          <line x1="8" y1="30" x2="24" y2="30" stroke="#a0a0a7" strokeWidth="1.2" />
        </svg>
      </div>
      <p className="text-[12px] text-[#44444b]">
        {isRunning ? 'Running query…' : 'Run a query to display results'}
      </p>
    </div>
  )
}

function HistoryEmptyState() {
  return (
    <div className="flex flex-col items-center justify-center h-full gap-2 py-10">
      <History size={28} className="text-[#2a2a31]" />
      <p className="text-[12px] text-[#44444b]">No query history yet</p>
    </div>
  )
}

function ResultsTable({ columns, rows }: { columns: Column[]; rows: Row[] }) {
  return (
    <div className="overflow-auto h-full">
      <table className="w-full text-[12px] border-collapse">
        <thead className="sticky top-0 z-10">
          <tr className="bg-[#16161a] border-b border-[#2a2a31]">
            {columns.map((col) => (
              <th
                key={col.key}
                className="text-left px-4 py-2.5 text-[#6c6c74] font-semibold tracking-wider whitespace-nowrap border-r border-[#2a2a31] last:border-r-0"
              >
                {col.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, i) => (
            <tr
              key={i}
              className={clsx(
                'border-b border-[#1f1f25] hover:bg-[#16161a] transition-colors',
                i % 2 === 1 && 'bg-[#0f0f12]'
              )}
            >
              {columns.map((col) => (
                <td
                  key={col.key}
                  className="px-4 py-2 text-[#c9ccd3] whitespace-nowrap border-r border-[#1f1f25] last:border-r-0"
                >
                  {row[col.key] == null ? '' : String(row[col.key])}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}
