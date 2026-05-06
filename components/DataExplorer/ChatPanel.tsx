'use client'

import { useState, useRef, useEffect, useCallback } from 'react'
import { Send, Sparkles, Mic, MicOff } from 'lucide-react'
import { clsx } from 'clsx'
import { QueryTemplates } from './QueryTemplates'
import { useVoiceInput } from '../../hooks/useVoiceInput'

export type Message = {
  id: string
  role: 'user' | 'assistant'
  content: string
  timestamp?: string
}

type Props = {
  messages: Message[]
  onSend: (text: string) => void
  isLoading?: boolean
  projectName?: string
  onTemplateSelect?: (query: string) => void
  prefillMessage?: string
}

// ─── Waveform Indicator ──────────────────────────────────────────────────────
function WaveformIndicator() {
  const delays = ['0s', '0.15s', '0.3s', '0.15s', '0s']
  const heights = ['12px', '18px', '24px', '18px', '12px']

  return (
    <div className="flex items-center gap-2 px-1 pb-1.5">
      <div className="flex items-end gap-[3px] h-6">
        {delays.map((delay, i) => (
          <div
            key={i}
            className="waveform-bar w-[3px] rounded-full bg-[#ff5c6c]"
            style={{
              height: heights[i],
              animationDelay: delay,
            }}
          />
        ))}
      </div>
      <span className="text-[11px] text-[#ff5c6c] font-medium">
        Listening… speak now
      </span>
    </div>
  )
}

// ─── Clinical Hint Pill ───────────────────────────────────────────────────────
function VoiceHintPill({ onDismiss }: { onDismiss: () => void }) {
  return (
    <div className="flex items-center justify-between gap-2 bg-[#1b1b20] border border-[#2a2a31] rounded-[8px] px-3 py-1.5 mt-1.5">
      <span className="text-[11px] text-[#6c6c74] leading-relaxed">
        Try:{' '}
        <span className="text-[#a0a0a7] italic">
          &quot;Show ICU patients admitted this week&quot;
        </span>{' '}
        or{' '}
        <span className="text-[#a0a0a7] italic">
          &quot;Compare LOS by department&quot;
        </span>
      </span>
      <button
        onClick={onDismiss}
        className="text-[#44444b] hover:text-[#6c6c74] text-[12px] flex-shrink-0 leading-none"
        aria-label="Dismiss hint"
      >
        ✕
      </button>
    </div>
  )
}

// ─── Error Toast ──────────────────────────────────────────────────────────────
function VoiceErrorToast({ message, onDismiss }: { message: string; onDismiss: () => void }) {
  return (
    <div className="flex items-center justify-between gap-2 bg-[#ff5c6c15] border border-[#ff5c6c40] rounded-[8px] px-3 py-2 mt-1.5">
      <span className="text-[11px] text-[#ff5c6c]">{message}</span>
      <button
        onClick={onDismiss}
        className="text-[#ff5c6c80] hover:text-[#ff5c6c] text-[12px] flex-shrink-0 leading-none"
        aria-label="Dismiss error"
      >
        ✕
      </button>
    </div>
  )
}

// ─── Mic Button ───────────────────────────────────────────────────────────────
function MicButton({
  isListening,
  isSupported,
  onClick,
}: {
  isListening: boolean
  isSupported: boolean
  onClick: () => void
}) {
  // QA fix: moved platform check to state+useEffect to avoid SSR hydration mismatch
  const [isMac, setIsMac] = useState(false)
  useEffect(() => {
    setIsMac(/Mac|iPod|iPhone|iPad/.test(navigator.platform))
  }, [])
  const shortcut = isMac ? '⌘⇧M' : 'Ctrl+Shift+M'
  const title = isListening
    ? `Stop recording (${shortcut})`
    : `Start voice input (${shortcut})`

  return (
    <div className="relative flex items-center justify-center flex-shrink-0 mb-0.5">
      {/* Pulsing ring when listening */}
      {isListening && (
        <span
          className="mic-pulse-ring absolute inset-0 rounded-[8px] bg-[#ff5c6c]"
          aria-hidden="true"
        />
      )}
      <button
        onClick={onClick}
        title={title}
        aria-label={title}
        className={clsx(
          'relative w-7 h-7 rounded-[8px] flex items-center justify-center transition-all',
          isListening
            ? 'text-[#ff5c6c]'
            : 'text-[#44444b] hover:text-[#a0a0a7]'
        )}
      >
        {isListening ? <MicOff size={13} /> : <Mic size={13} />}
      </button>
    </div>
  )
}

// ─── Message renderers ────────────────────────────────────────────────────────
function AssistantMessage({ msg }: { msg: Message }) {
  const lines = msg.content.split('\n')

  return (
    <div className="flex flex-col gap-1 max-w-[90%]">
      <div className="flex items-center gap-1.5 mb-1">
        <div className="w-5 h-5 rounded-full bg-gradient-to-br from-[#7c68ff] to-[#4c8dff] flex items-center justify-center flex-shrink-0">
          <Sparkles size={9} className="text-white" />
        </div>
        <span className="text-[11px] font-medium text-[#6c6c74]">Data Explorer</span>
      </div>
      {msg.content.startsWith('\u2695\ufe0f') && msg.content.endsWith('\u2026') ? (
        <div className="bg-[#16161a] border border-[#2a2a31] rounded-[12px] rounded-tl-[4px] px-4 py-3 text-[13px] text-[#a0a0a7] leading-relaxed flex items-center gap-2">
          <span className="thinking-pulse">{msg.content}</span>
        </div>
      ) : (
        <div className="bg-[#16161a] border border-[#2a2a31] rounded-[12px] rounded-tl-[4px] px-4 py-3 text-[13px] text-[#c9ccd3] leading-relaxed">
          {lines.map((line, i) => {
            if (line.startsWith('•') || line.startsWith('-')) {
              return (
                <div key={i} className="flex gap-2 py-0.5">
                  <span className="text-[#7c68ff] mt-1 flex-shrink-0">•</span>
                  <span>{line.replace(/^[•\-]\s*/, '')}</span>
                </div>
              )
            }
            if (line.trim() === '') return <div key={i} className="h-2" />
            return <p key={i}>{line}</p>
          })}
        </div>
      )}
      {msg.timestamp && (
        <span className="text-[10px] text-[#44444b] pl-1">{msg.timestamp}</span>
      )}
    </div>
  )
}

function UserMessage({ msg }: { msg: Message }) {
  return (
    <div className="flex flex-col items-end gap-1 max-w-[85%] self-end">
      <div className="bg-gradient-to-br from-[#7c68ff] to-[#6050e0] rounded-[12px] rounded-tr-[4px] px-4 py-2.5 text-[13px] text-white font-medium leading-relaxed shadow-[0_4px_20px_rgba(124,104,255,0.3)]">
        {msg.content}
      </div>
      {msg.timestamp && (
        <span className="text-[10px] text-[#44444b] pr-1">{msg.timestamp}</span>
      )}
    </div>
  )
}

function EmptyState({ projectName }: { projectName?: string }) {
  return (
    <div className="flex-1 flex flex-col items-center justify-center gap-3 p-8">
      <div className="w-12 h-12 rounded-2xl bg-gradient-to-br from-[#7c68ff20] to-[#4c8dff10] border border-[#2a2a31] flex items-center justify-center">
        <Sparkles size={20} className="text-[#7c68ff]" />
      </div>
      <div className="text-center">
        <p className="text-[16px] font-semibold text-[#e8e8ea] mb-1">
          {projectName || 'Data Explorer'}
        </p>
        <p className="text-[12px] text-[#6c6c74] max-w-[240px] leading-relaxed">
          Ask a question about your data or describe what you want to query
        </p>
      </div>
      <div className="flex flex-col gap-2 w-full max-w-[280px] mt-2">
        {[
          'Show me patients admitted this month',
          'Which departments have the most activity?',
          'Get top hospitals by acceptance count',
        ].map((suggestion) => (
          <button
            key={suggestion}
            className="text-left px-3.5 py-2.5 rounded-[10px] bg-[#16161a] border border-[#2a2a31] text-[12px] text-[#a0a0a7] hover:text-[#e8e8ea] hover:border-[#7c68ff40] hover:bg-[#1b1b20] transition-all"
          >
            {suggestion}
          </button>
        ))}
      </div>
    </div>
  )
}

const QUICK_ACTIONS = [
  { icon: '📊', label: 'Analyze patient data', query: 'Show me a summary of patient data by unit and department' },
  { icon: '📈', label: 'Create a chart', query: 'Create a bar chart of patient admissions by department this month' },
  { icon: '🔍', label: 'Explore a dataset', query: 'What tables and data are available to explore?' },
]

const HINT_STORAGE_KEY = 'voice-hint-dismissed'

// ─── Main component ───────────────────────────────────────────────────────────
export function ChatPanel({ messages, onSend, isLoading, projectName, onTemplateSelect, prefillMessage }: Props) {
  const [input, setInput] = useState('')
  const [inputGlow, setInputGlow] = useState(false)
  const [isInterim, setIsInterim] = useState(false)
  const [showHint, setShowHint] = useState(false)
  const messagesEndRef = useRef<HTMLDivElement>(null)
  const textareaRef = useRef<HTMLTextAreaElement>(null)

  const voice = useVoiceInput()

  // ── Sync voice transcript → textarea ────────────────────────────────────────
  useEffect(() => {
    if (voice.interimTranscript) {
      // Show live partial transcript (italic / dimmed via className)
      setInput(voice.interimTranscript)
      setIsInterim(true)
      autoResizeTextarea()
    } else if (voice.transcript && !voice.isListening) {
      // Final transcript confirmed
      setInput(voice.transcript)
      setIsInterim(false)
      autoResizeTextarea()
      textareaRef.current?.focus()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [voice.transcript, voice.interimTranscript, voice.isListening])

  // ── Show hint pill when voice starts (first time) ───────────────────────────
  useEffect(() => {
    if (voice.isListening) {
      const dismissed =
        typeof window !== 'undefined'
          ? sessionStorage.getItem(HINT_STORAGE_KEY) === '1'
          : false
      if (!dismissed) setShowHint(true)
    }
  }, [voice.isListening])

  // ── Keyboard shortcut Ctrl/Cmd+Shift+M ──────────────────────────────────────
  const handleGlobalKeyDown = useCallback(
    (e: KeyboardEvent) => {
      const meta = e.metaKey || e.ctrlKey
      if (meta && e.shiftKey && e.key.toLowerCase() === 'm') {
        e.preventDefault()
        if (voice.isSupported) voice.startListening()
      }
    },
    [voice]
  )

  useEffect(() => {
    if (typeof window === 'undefined') return
    window.addEventListener('keydown', handleGlobalKeyDown)
    return () => window.removeEventListener('keydown', handleGlobalKeyDown)
  }, [handleGlobalKeyDown])

  // ── Scroll to bottom on new messages ────────────────────────────────────────
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages])

  // ── Handle prefill from template selection ───────────────────────────────────
  useEffect(() => {
    if (prefillMessage) {
      setInput(prefillMessage)
      setIsInterim(false)
      setInputGlow(true)
      setTimeout(() => setInputGlow(false), 600)
      textareaRef.current?.focus()
      autoResizeTextarea()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [prefillMessage])

  // ── Auto-resize helper ───────────────────────────────────────────────────────
  const autoResizeTextarea = () => {
    if (textareaRef.current) {
      textareaRef.current.style.height = 'auto'
      textareaRef.current.style.height =
        Math.min(textareaRef.current.scrollHeight, 120) + 'px'
    }
  }

  const handleSend = () => {
    const text = input.trim()
    if (!text || isLoading) return
    // If voice was listening, stop it first
    if (voice.isListening) voice.stopListening()
    setIsInterim(false)
    onSend(text)
    setInput('')
    voice.resetTranscript()
    if (textareaRef.current) {
      textareaRef.current.style.height = 'auto'
    }
  }

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      handleSend()
    }
  }

  const handleTextareaChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    setInput(e.target.value)
    setIsInterim(false) // user started typing manually
    voice.resetTranscript()
    e.target.style.height = 'auto'
    e.target.style.height = Math.min(e.target.scrollHeight, 120) + 'px'
  }

  const handleDismissHint = () => {
    setShowHint(false)
    if (typeof window !== 'undefined') {
      sessionStorage.setItem(HINT_STORAGE_KEY, '1')
    }
  }

  const hasMessages = messages.length > 0
  // Only show mic if supported
  const showMic = voice.isSupported

  return (
    <div className="flex flex-col h-full bg-[#0d0d10] overflow-hidden">
      {/* Query templates */}
      {onTemplateSelect && (
        <QueryTemplates onSelect={(q) => {
          onTemplateSelect(q)
          setInput(q)
          setIsInterim(false)
          setInputGlow(true)
          setTimeout(() => setInputGlow(false), 600)
          textareaRef.current?.focus()
        }} />
      )}

      {/* Messages area */}
      <div className="flex-1 overflow-y-auto px-5 py-4">
        {!hasMessages ? (
          <>
            <EmptyState projectName={projectName} />
            {/* Quick actions */}
            <div className="px-2 pb-4">
              <p className="text-[10px] font-semibold text-[#44444b] uppercase tracking-wider mb-2 px-1">Quick actions</p>
              <div className="flex flex-col gap-2">
                {QUICK_ACTIONS.map((action) => (
                  <button
                    key={action.label}
                    onClick={() => {
                      setInput(action.query)
                      setIsInterim(false)
                      setInputGlow(true)
                      setTimeout(() => setInputGlow(false), 600)
                      textareaRef.current?.focus()
                    }}
                    className="flex items-center gap-2.5 bg-[#16161a] border border-[#2a2a31] rounded-[10px] p-3 cursor-pointer hover:border-[#7c68ff60] hover:bg-[#7c68ff08] transition-all text-left"
                  >
                    <span className="text-lg">{action.icon}</span>
                    <span className="text-[12px] text-[#a0a0a7] font-medium">{action.label}</span>
                  </button>
                ))}
              </div>
            </div>
          </>
        ) : (
          <div className="flex flex-col gap-4">
            {messages.map((msg) =>
              msg.role === 'user' ? (
                <UserMessage key={msg.id} msg={msg} />
              ) : (
                <AssistantMessage key={msg.id} msg={msg} />
              )
            )}
            {isLoading && (
              <div className="flex items-center gap-2 text-[12px] text-[#6c6c74]">
                <div className="flex gap-1">
                  {[0, 1, 2].map((i) => (
                    <div
                      key={i}
                      className="w-1.5 h-1.5 rounded-full bg-[#7c68ff] animate-bounce"
                      style={{ animationDelay: `${i * 0.15}s` }}
                    />
                  ))}
                </div>
                <span>Thinking…</span>
              </div>
            )}
            <div ref={messagesEndRef} />
          </div>
        )}
      </div>

      {/* Input bar */}
      <div className="px-4 py-3 border-t border-[#2a2a31]">
        {/* Waveform — visible only while listening */}
        {voice.isListening && <WaveformIndicator />}

        {/* Error toast */}
        {voice.error && (
          <VoiceErrorToast message={voice.error} onDismiss={() => voice.resetTranscript()} />
        )}

        {/*
          gemini-glow wrapper: the 2px padding becomes the visible border ring.
          is-streaming class kicks in when the AI is actively responding,
          giving the fastest/brightest rotation cycle.
          focus-within is handled purely in CSS (no JS state needed).
        */}
        <div className={clsx('gemini-glow', isLoading && 'is-streaming')}>
          {/*
            gemini-glow-inner sits at z-index:1 over the pseudo-element gradients.
            Its bg-[#16161a] "masks" the center so only the 2px border ring shows.
          */}
          <div className="gemini-glow-inner flex items-end gap-2 bg-[#16161a] px-3.5 py-2.5">
            <textarea
              ref={textareaRef}
              value={input}
              onChange={handleTextareaChange}
              onKeyDown={handleKeyDown}
              placeholder={voice.isListening ? 'Listening…' : 'Type a message…'}
              rows={1}
              className={clsx(
                'mc-input flex-1 min-h-[20px] max-h-[120px] overflow-y-auto transition-all',
                isInterim && 'opacity-60 italic'
              )}
            />
            {/* Mic button — left of Send */}
            {showMic && (
              <MicButton
                isListening={voice.isListening}
                isSupported={voice.isSupported}
                onClick={voice.startListening}
              />
            )}
            <button
              onClick={handleSend}
              disabled={!input.trim() || isLoading}
              className={clsx(
                'w-7 h-7 rounded-[8px] flex items-center justify-center transition-all flex-shrink-0 mb-0.5',
                input.trim() && !isLoading
                  ? 'bg-[#7c68ff] text-white hover:bg-[#6a58e8] shadow-[0_2px_8px_rgba(124,104,255,0.4)]'
                  : 'bg-[#1f1f25] text-[#44444b] cursor-not-allowed'
              )}
            >
              <Send size={13} />
            </button>
          </div>
        </div>

        {/* Hint pill */}
        {showHint && voice.isListening && (
          <VoiceHintPill onDismiss={handleDismissHint} />
        )}

        <p className="text-[10px] text-[#44444b] mt-1.5 pl-1">
          Enter to send · Shift+Enter for new line
          {showMic && ' · Ctrl+Shift+M for voice'}
        </p>
      </div>
    </div>
  )
}
