'use client'

import { useState, useCallback, useEffect, useRef } from 'react'
import { Sidebar, type SavedQuery, upsertQuery, getSavedQueries } from '@/components/Sidebar'
import { ChatPanel, Message } from '@/components/DataExplorer/ChatPanel'
import { SqlPanel } from '@/components/DataExplorer/SqlPanel'
import { ChartPreview, ChartConfig } from '@/components/DataExplorer/ChartPreview'
import { SaveToDashboardModal } from '@/components/DataExplorer/SaveToDashboardModal'
import { saveChart, persistChart, type SavedChart } from '@/lib/store'
import { type NarrativeResult } from '@/components/DataExplorer/NarrativePanel'
import {
  Database,
  ChevronDown,
  Activity,
  BarChart2,
  Save,
  CheckCircle2,
  LayoutDashboard,
  X,
} from 'lucide-react'
import { clsx } from 'clsx'

// ──────────────────────────────────────────────
// Sample data
// ──────────────────────────────────────────────
const INITIAL_SQL = ``

const INITIAL_MESSAGES: Message[] = [
  {
    id: 'welcome',
    role: 'assistant',
    content: 'Hello! I\'m your clinical data assistant. Ask me anything about your patient data, or pick a template above to get started.',
    timestamp: '',
  },
]



// ──────────────────────────────────────────────
// Header component
// ──────────────────────────────────────────────
// TopBar removed — navigation lives in the sidebar

// ──────────────────────────────────────────────
// Main Page
// ──────────────────────────────────────────────
export default function DataExplorerPage() {
  // ── Active query (replaces tab state) ────────────────────────────────────
  const newQueryId = () => `q_${Date.now()}`
  const [activeQueryId, setActiveQueryId] = useState(() => newQueryId())
  const [activeQueryLabel, setActiveQueryLabel] = useState('New Query')

  const [messages, setMessages] = useState<Message[]>(INITIAL_MESSAGES)
  // QA fix: keep a ref to messages so handleRun can access the latest value
  // without adding messages to its useCallback deps (which would recreate it
  // on every chat turn).
  const messagesRef = useRef(messages)
  useEffect(() => { messagesRef.current = messages }, [messages])

  const [sql, setSql] = useState(INITIAL_SQL)
  const [prefillMessage, setPrefillMessage] = useState<string | undefined>(undefined)
  const [isRunning, setIsRunning] = useState(false)
  const [isLoading, setIsLoading] = useState(false)
  const [isSqlStreaming, setIsSqlStreaming] = useState(false)
  const [runTime, setRunTime] = useState('00:00:00.00')
  const [limit, setLimit] = useState(1000)
  const [results, setResults] = useState<null | { columns: { key: string; label: string; type?: string }[]; rows: Record<string, unknown>[] }>(null)
  const [selectedDb, setSelectedDb] = useState<'telehealth' | 'eclinics'>('telehealth')

  // ── Chart generation state ─────────────────────────────────────────────────
  const [chartConfig, setChartConfig] = useState<ChartConfig | null>(null)
  const [activeResultTab, setActiveResultTab] = useState<'results' | 'chart'>('results')
  const [isGeneratingChart, setIsGeneratingChart] = useState(false)
  const [chartSaved, setChartSaved] = useState(false)

  // ── Mobile state ──────────────────────────────────────────────────────────
  type MobileTab = 'chat' | 'sql' | 'results'
  const [mobileTab, setMobileTab] = useState<MobileTab>('chat')
  const [showWardRounds, setShowWardRounds] = useState(false)

  useEffect(() => {
    const dismissed = sessionStorage.getItem('wardRoundsDismissed') === 'true'
    if (!dismissed) setShowWardRounds(true)
  }, [])

  const dismissWardRounds = () => {
    sessionStorage.setItem('wardRoundsDismissed', 'true')
    setShowWardRounds(false)
  }

  // ── Narrative state ───────────────────────────────────────────────────────
  const [narrative, setNarrative] = useState<NarrativeResult | null>(null)
  const [isGeneratingNarrative, setIsGeneratingNarrative] = useState(false)
  const [savedChartObj, setSavedChartObj] = useState<SavedChart | null>(null)
  const [showDashboardModal, setShowDashboardModal] = useState(false)
  const [dashboardToast, setDashboardToast] = useState<string | null>(null)

  const handleNewQuery = () => {
    const id = newQueryId()
    setActiveQueryId(id)
    setActiveQueryLabel('New Query')
    setSql('')
    // QA fix: removed duplicate setMessages([]) and setResults(null) calls that overwrote INITIAL_MESSAGES
    setMessages(INITIAL_MESSAGES)
    setResults(null)
    setChartConfig(null)
    setChartSaved(false)
    setNarrative(null)
  }

  const handleQuerySelect = (q: SavedQuery) => {
    setActiveQueryId(q.id)
    setActiveQueryLabel(q.label)
    setSql(q.sql)
    setMessages(INITIAL_MESSAGES)
    setResults(null)
    setChartConfig(null)
    setChartSaved(false)
    setNarrative(null)
  }

  // Save query to sidebar history after run
  const saveQueryToHistory = (status: 'success' | 'error') => {
    if (!sql.trim()) return
    const label = sql.trim().slice(0, 40).replace(/\n/g, ' ') + (sql.trim().length > 40 ? '…' : '')
    const q: SavedQuery = {
      id: activeQueryId,
      label,
      sql,
      status,
      createdAt: new Date().toISOString(),
      lastRunAt: new Date().toISOString(),
    }
    upsertQuery(q)
    setActiveQueryLabel(label)
    window.dispatchEvent(new Event('ceiba_queries_updated'))
  }


  // ── Narrative generation ─────────────────────────────────────────────────
  const generateNarrative = async (
    columns: { key: string; label: string; type?: string }[],
    rows: Record<string, unknown>[],
    question: string
  ) => {
    setIsGeneratingNarrative(true)
    setNarrative(null)
    try {
      const res = await fetch('/api/narrative', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ columns, rows, question }),
      })
      if (!res.ok) return // fail silently
      const data = await res.json()
      if (data.narrative) {
        setNarrative({
          narrative: data.narrative,
          highlights: data.highlights ?? [],
          anomalies: data.anomalies ?? [],
        })
      }
    } catch {
      // fail silently — narrative is non-critical
    } finally {
      setIsGeneratingNarrative(false)
    }
  }

  const handleRun = useCallback(async () => {
    if (isRunning || !sql.trim()) return
    setIsRunning(true)
    setResults(null)
    setRunTime('00:00:00.00')
    setNarrative(null)

    const start = Date.now()
    const timer = setInterval(() => {
      const ms = Date.now() - start
      const secs = Math.floor(ms / 1000)
      const centis = Math.floor((ms % 1000) / 10)
      setRunTime(`00:00:${String(secs).padStart(2, '0')}.${String(centis).padStart(2, '0')}`)
    }, 100)

    try {
      const res = await fetch('/api/query', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sql, database: selectedDb, limit }),
      })
      const data = await res.json()

      if (data.error) {
        setResults({ columns: [{ key: 'error', label: 'Error' }], rows: [{ error: data.error }] })
        saveQueryToHistory('error')
      } else {
        setResults({ columns: data.columns, rows: data.rows })
        saveQueryToHistory('success')
        // Auto-generate narrative after successful query
        if (data.rows && data.rows.length > 0) {
          // QA fix: use messagesRef.current to get latest messages without
          // adding messages to handleRun's useCallback deps
          const lastUserMsg = messagesRef.current.filter((m) => m.role === 'user').slice(-1)[0]?.content ?? ''
          generateNarrative(data.columns, data.rows, lastUserMsg)
        }
      }
    } catch (e) {
      setResults({ columns: [{ key: 'error', label: 'Error' }], rows: [{ error: String(e) }] })
      saveQueryToHistory('error')
    } finally {
      clearInterval(timer)
      const ms = Date.now() - start
      const secs = Math.floor(ms / 1000)
      const centis = Math.floor((ms % 1000) / 10)
      setRunTime(`00:00:${String(secs).padStart(2, '0')}.${String(centis).padStart(2, '0')}`)
      setIsRunning(false)
    }
  }, [isRunning, sql, selectedDb, limit, activeQueryId])

  // Layer 1: client-side clinical scope guard (zero tokens, instant)
  const OFF_TOPIC_PATTERNS = [
    /\b(stock|crypto|bitcoin|forex|weather|recipe|cook|sport|footbal|basket|footbal|nfl|nba|politic|election|celebrity|movie|music|travel|hotel|flight|restaurant|shopping|fashion|game|gaming)\b/i,
    /\b(how to|tell me a joke|write a poem|translate|what is the capital|who is|history of|meaning of)\b/i,
  ]
  const isOffTopic = (text: string) => OFF_TOPIC_PATTERNS.some((p) => p.test(text))

  // Detect SQL generation intent (data fetch requests without chart keywords)
  const isSqlRequest = (text: string) =>
    /show me|give me|get me|fetch|query|how many|count|list|find|what are|select|which patients|top \d|breakdown|compare|average|total|sum of/i.test(text) &&
    !/chart|graph|plot|visuali|pie|bar|line/i.test(text)

  // Detect chart intent keywords
  const isChartRequest = (text: string) =>
    /chart|graph|plot|visuali|pie|bar|line|donut|scatter|viz|show me/i.test(text)

  const handleSaveChart = () => {
    if (!chartConfig || !results) return
    const chart: SavedChart = {
      id: String(Date.now()),
      title: chartConfig.title,
      description: chartConfig.description,
      config: chartConfig,
      data: results.rows,
      createdAt: new Date().toISOString(),
      queryName: activeQueryLabel,
    }
    persistChart(chart)
    setSavedChartObj(chart)
    setChartSaved(true)
  }

  const showToast = (msg: string) => {
    setDashboardToast(msg)
    setTimeout(() => setDashboardToast(null), 3000)
  }

  const handleSend = useCallback(
    async (text: string) => {
      const ts = new Date().toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: false })
      const userMsg: Message = { id: String(Date.now()), role: 'user', content: text, timestamp: ts }
      setMessages((prev) => [...prev, userMsg])

      // Layer 1: instant client-side scope block (no API call)
      if (isOffTopic(text)) {
        setMessages((prev) => [...prev, {
          id: String(Date.now() + 1),
          role: 'assistant',
          content: '⚕️ I\'m scoped to clinical and healthcare data analysis only. I can\'t help with that topic — but ask me anything about your patient data, hospital metrics, or clinical queries!',
          timestamp: ts,
        }])
        setIsLoading(false)
        return
      }

      setIsLoading(true)

      // SQL generation path — detect before chart intent
      if (isSqlRequest(text)) {
        const thinkingId = String(Date.now() + 1)
        setMessages((prev) => [...prev, {
          id: thinkingId,
          role: 'assistant',
          content: '⚕️ Generating clinical SQL query…',
          timestamp: ts,
        }])

        try {
          const response = await fetch('/api/sql-generate', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ userMessage: text }),
          })

          // Handle non-stream responses (scope errors, server errors, etc.)
          const contentType = response.headers.get('content-type') || ''
          if (!contentType.includes('text/event-stream')) {
            const json = await response.json()
            if (json.scopeError) {
              setMessages((prev) => prev.map((m) =>
                m.id === thinkingId
                  ? { ...m, content: '⚕️ I can only help with clinical and healthcare data. Try asking about patients, units, departments, or clinical metrics.' }
                  : m
              ))
            } else {
              throw new Error(json.error || 'Unexpected response')
            }
            setIsLoading(false)
            return
          }

          // Update thinking message to show streaming state
          setMessages((prev) => prev.map((m) =>
            m.id === thinkingId ? { ...m, content: '⚕️ Writing query…' } : m
          ))

          // Consume the SSE stream
          const reader = response.body!.getReader()
          const decoder = new TextDecoder()
          let accumulated = ''
          let streamBuffer = ''

          setIsSqlStreaming(true)

          while (true) {
            const { done, value } = await reader.read()
            if (done) break

            streamBuffer += decoder.decode(value, { stream: true })
            const lines = streamBuffer.split('\n')
            streamBuffer = lines.pop() || ''

            for (const line of lines) {
              if (line.startsWith('data: ')) {
                const data = line.slice(6)
                if (data === '[DONE]') break
                try {
                  const parsed = JSON.parse(data)
                  if (parsed.delta) {
                    accumulated += parsed.delta
                    // Live-update the SQL editor as tokens stream in
                    const sqlMatch = accumulated.match(/"sql"\s*:\s*"((?:[^"\\]|\\.)*)/)
                    if (sqlMatch) {
                      setSql(sqlMatch[1].replace(/\\n/g, '\n').replace(/\\"/, '"').replace(/\\\\/g, '\\'))
                    }
                  }
                } catch {
                  // Ignore malformed chunks
                }
              }
            }
          }

          setIsSqlStreaming(false)

          // Parse final accumulated JSON
          try {
            const result = JSON.parse(accumulated)
            if (result.scopeError) {
              setMessages((prev) => prev.map((m) =>
                m.id === thinkingId
                  ? { ...m, content: '⚕️ I can only help with clinical and healthcare data. Try asking about patients, units, departments, or clinical metrics.' }
                  : m
              ))
            } else if (result.sql) {
              setSql(result.sql)
              setMessages((prev) => prev.map((m) =>
                m.id === thinkingId
                  ? { ...m, content: `✓ Query ready! ${result.description || ''}\n\nHit **Run** to execute.` }
                  : m
              ))
            } else {
              throw new Error(result.error || 'No SQL returned')
            }
          } catch {
            // JSON parse failed — keep whatever SQL was set during streaming
            setMessages((prev) => prev.map((m) =>
              m.id === thinkingId
                ? { ...m, content: '✓ Query ready! Hit **Run** to execute.' }
                : m
            ))
          }
        } catch (e) {
          setIsSqlStreaming(false)
          setMessages((prev) => prev.map((m) =>
            m.id === thinkingId
              ? { ...m, content: `⚠️ SQL generation failed: ${String(e)}` }
              : m
          ))
        } finally {
          setIsLoading(false)
        }
        return
      }

      // Chart generation path
      if (isChartRequest(text) && results && results.rows.length > 0) {
        setIsGeneratingChart(true)
        setChartSaved(false)
        setSavedChartObj(null)
        const thinkingId = String(Date.now() + 1)
        const thinkingMsg: Message = {
          id: thinkingId,
          role: 'assistant',
          content: '⏳ Analyzing your data and selecting the best chart type…',
          timestamp: ts,
        }
        setMessages((prev) => [...prev, thinkingMsg])

        try {
          const res = await fetch('/api/chart-suggest', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ columns: results.columns, rows: results.rows, userMessage: text }),
          })
          const json = await res.json()

          // Layer 2: LLM flagged as out of clinical scope
          if (json.scopeError) {
            setMessages((prev) => prev.map((m) =>
              m.id === thinkingId
                ? { ...m, content: `⚕️ ${json.message || 'I can only help with clinical and healthcare data analysis.'}` }
                : m
            ))
            setIsGeneratingChart(false)
            setIsLoading(false)
            return
          }

          if (json.config) {
            setChartConfig(json.config)
            setActiveResultTab('chart')
            setMessages((prev) => prev.map((m) =>
              m.id === thinkingId
                ? { ...m, content: `✓ Generated a **${json.config.type} chart**: "${json.config.title}"\n\n${json.config.description || ''}\n\nSwitch to the **Chart** tab to view it. Hit **Save Chart** to add it to your Charts library.` }
                : m
            ))
          } else {
            throw new Error(json.error || 'No config returned')
          }
        } catch (e) {
          setMessages((prev) => prev.map((m) =>
            m.id === thinkingId
              ? { ...m, content: `⚠️ Chart generation failed: ${String(e)}` }
              : m
          ))
        } finally {
          setIsGeneratingChart(false)
          setIsLoading(false)
        }
        return
      }

      // Real clinical AI response
      try {
        // Build a brief context summary from current results (if any)
        const context = results
          ? `Columns: ${results.columns.map(c => c.label).join(', ')}. Row count: ${results.rows.length}.`
          : undefined

        const res = await fetch('/api/chat', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ message: text, context }),
        })
        const json = await res.json()
        const reply = json.reply || 'Sorry, I could not process that.'

        setMessages((prev) => [...prev, {
          id: String(Date.now() + 1),
          role: 'assistant',
          content: reply,
          timestamp: ts,
        }])
      } catch {
        setMessages((prev) => [...prev, {
          id: String(Date.now() + 1),
          role: 'assistant',
          content: 'Something went wrong. Please try again.',
          timestamp: ts,
        }])
      } finally {
        setIsLoading(false)
      }
    },
    [results]
  )

  return (
    <div className="flex h-[100dvh] overflow-hidden bg-[#0b0b0c]">
      {/* Sidebar - hidden on mobile */}
      <div className="hidden md:flex">
        <Sidebar
          activePage="data-explorer"
          activeQueryId={activeQueryId}
          onQuerySelect={handleQuerySelect}
          onNewQuery={handleNewQuery}
        />
      </div>

      {/* Main content */}
      <div className="flex-1 flex flex-col overflow-hidden">
        {/* Ward Rounds Mode banner - mobile only */}
        {showWardRounds && (
          <div className="md:hidden flex items-center justify-between px-4 py-2 bg-[#7c68ff12] border-b border-[#7c68ff25] flex-shrink-0">
            <span className="text-[12px] text-[#7c68ff] font-semibold">📋 Ward Rounds Mode</span>
            <button
              onClick={dismissWardRounds}
              className="w-6 h-6 flex items-center justify-center rounded-full text-[#7c68ff] hover:bg-[#7c68ff20] transition-colors"
            >
              <X size={13} />
            </button>
          </div>
        )}

        {/* Mobile tab switcher */}
        <div className="md:hidden flex items-stretch border-b border-[#2a2a31] bg-[#0d0d10] flex-shrink-0">
          {([
            { key: 'chat' as MobileTab, label: '💬 Chat' },
            { key: 'sql' as MobileTab, label: '🗄 SQL' },
            { key: 'results' as MobileTab, label: '📊 Results' },
          ]).map((tab) => (
            <button
              key={tab.key}
              onClick={() => setMobileTab(tab.key)}
              className={clsx(
                'flex-1 py-2.5 text-[12px] font-semibold transition-colors border-b-2',
                mobileTab === tab.key
                  ? 'text-[#7c68ff] border-[#7c68ff]'
                  : 'text-[#6c6c74] border-transparent hover:text-[#a0a0a7]'
              )}
            >
              {tab.label}
            </button>
          ))}
        </div>

        {/* Workspace: chat + SQL side by side (desktop), or tabs (mobile) */}
        <div className="flex-1 flex overflow-hidden">
          {/* Chat panel */}
          <div
            className={clsx(
              'flex flex-col overflow-hidden',
              // Mobile: only show when chat tab active, full width
              mobileTab !== 'chat' ? 'hidden md:flex' : 'flex w-full',
              // Desktop: fixed 38% width with border
              'md:w-[38%] md:min-w-[300px] md:flex-shrink-0 md:border-r md:border-[#2a2a31]'
            )}
          >
            <ChatPanel
              messages={messages}
              onSend={handleSend}
              isLoading={isLoading}
              projectName="Data Explorer"
              prefillMessage={prefillMessage}
              onTemplateSelect={(q) => setPrefillMessage(q)}
            />
          </div>

          {/* Pane divider hint - desktop only */}
          <div className="pane-divider w-px flex-shrink-0 hidden md:block" />

          {/* SQL panel + Chart tab wrapper */}
          <div
            className={clsx(
              'flex flex-col overflow-hidden min-w-0',
              // Mobile: hide when chat tab active
              mobileTab === 'chat' ? 'hidden md:flex' : 'flex flex-1',
              // Desktop: always flex-1
              'md:flex-1'
            )}
          >
            {/* Results/Chart tab switcher (only when chart exists) */}
            {chartConfig && (
              <div className="flex items-center justify-between px-4 py-1.5 bg-[#0d0d10] border-b border-[#2a2a31] flex-shrink-0">
                <div className="flex items-center gap-1">
                  {(['results', 'chart'] as const).map((tab) => (
                    <button
                      key={tab}
                      onClick={() => setActiveResultTab(tab)}
                      className={`flex items-center gap-1.5 px-3 py-1.5 rounded-[7px] text-[11px] font-semibold transition-all min-h-[44px] ${
                        activeResultTab === tab
                          ? 'bg-[#7c68ff20] text-[#7c68ff] border border-[#7c68ff40]'
                          : 'text-[#6c6c74] hover:text-[#a0a0a7]'
                      }`}
                    >
                      {tab === 'chart' && <BarChart2 size={11} />}
                      {tab === 'results' ? 'Results' : 'Chart'}
                    </button>
                  ))}
                </div>
                {activeResultTab === 'chart' && (
                  <div className="flex items-center gap-2">
                    {chartSaved && savedChartObj && (
                      <button
                        onClick={() => setShowDashboardModal(true)}
                        className="flex items-center gap-1.5 px-3 py-1.5 rounded-[7px] text-[11px] font-semibold bg-[#16161a] border border-[#2a2a31] text-[#a0a0a7] hover:text-[#e8e8ea] hover:border-[#3a3a45] transition-all"
                      >
                        <LayoutDashboard size={11} />
                        + Add to Dashboard
                      </button>
                    )}
                    <button
                      onClick={handleSaveChart}
                      className={`flex items-center gap-1.5 px-3 py-1.5 rounded-[7px] text-[11px] font-semibold transition-all ${
                        chartSaved
                          ? 'bg-[#4dcc8820] text-[#4dcc88] border border-[#4dcc8840]'
                          : 'bg-[#7c68ff] text-white hover:bg-[#9080ff] shadow-[0_2px_8px_rgba(124,104,255,0.3)]'
                      }`}
                    >
                      {chartSaved ? <CheckCircle2 size={11} /> : <Save size={11} />}
                      {chartSaved ? 'Saved to Charts!' : 'Save Chart'}
                    </button>
                  </div>
                )}
              </div>
            )}

            {/* Chart preview overlay */}
            {chartConfig && activeResultTab === 'chart' ? (
              <div className="flex-1 overflow-hidden bg-[#111114]">
                <ChartPreview
                  config={chartConfig}
                  data={results?.rows ?? []}
                />
              </div>
            ) : (
              <SqlPanel
                sql={sql}
                onSqlChange={setSql}
                onRun={handleRun}
                isRunning={isRunning}
                runTime={runTime}
                limit={limit}
                onLimitChange={setLimit}
                results={results}
                dbLabel="DATABASE & SCHEMA"
                isStreaming={isSqlStreaming}
                selectedDb={selectedDb}
                onDbChange={setSelectedDb}
                narrative={narrative}
                isGeneratingNarrative={isGeneratingNarrative}
                onNarrativeDismiss={() => setNarrative(null)}
                forceSqlOpen={mobileTab === 'sql'}
              />
            )}
          </div>
        </div>
      </div>

      {/* Save to Dashboard Modal */}
      {showDashboardModal && savedChartObj && (
        <SaveToDashboardModal
          chart={savedChartObj}
          onClose={() => setShowDashboardModal(false)}
          onAdded={(name) => showToast(`Added to "${name}"!`)}
        />
      )}

      {/* Toast notification */}
      {dashboardToast && (
        <div className="fixed bottom-6 left-1/2 -translate-x-1/2 z-50 flex items-center gap-2 px-4 py-2.5 rounded-[10px] bg-[#16161a] border border-[#4dcc8840] text-[#4dcc88] text-[13px] font-medium shadow-xl">
          <CheckCircle2 size={14} />
          {dashboardToast}
        </div>
      )}
    </div>
  )
}
