'use client'

import { useState, useRef, useEffect } from 'react'
import { Send, Sparkles } from 'lucide-react'
import { clsx } from 'clsx'
import { QueryTemplates } from './QueryTemplates'

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
      {/* Pulsing thinking indicator for in-progress messages */}
      {msg.content.startsWith('\u2695\ufe0f') && msg.content.endsWith('\u2026') ? (
        <div className="bg-[#16161a] border border-[#2a2a31] rounded-[12px] rounded-tl-[4px] px-4 py-3 text-[13px] text-[#a0a0a7] leading-relaxed flex items-center gap-2">
          <span className="thinking-pulse">{msg.content}</span>
        </div>
      ) : (
        <div className="bg-[#16161a] border border-[#2a2a31] rounded-[12px] rounded-tl-[4px] px-4 py-3 text-[13px] text-[#c9ccd3] leading-relaxed">
          {lines.map((line, i) => {
            // Bullet items
            if (line.startsWith('•') || line.startsWith('-')) {
              return (
                <div key={i} className="flex gap-2 py-0.5">
                  <span className="text-[#7c68ff] mt-1 flex-shrink-0">•</span>
                  <span>{line.replace(/^[•\-]\s*/, '')}</span>
                </div>
              )
            }
            // Empty line
            if (line.trim() === '') return <div key={i} className="h-2" />
            // Regular line
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

export function ChatPanel({ messages, onSend, isLoading, projectName, onTemplateSelect, prefillMessage }: Props) {
  const [input, setInput] = useState('')
  const [inputGlow, setInputGlow] = useState(false)
  const messagesEndRef = useRef<HTMLDivElement>(null)
  const textareaRef = useRef<HTMLTextAreaElement>(null)

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages])

  // Handle prefill from template selection
  useEffect(() => {
    if (prefillMessage) {
      setInput(prefillMessage)
      setInputGlow(true)
      setTimeout(() => setInputGlow(false), 600)
      textareaRef.current?.focus()
      if (textareaRef.current) {
        textareaRef.current.style.height = 'auto'
        textareaRef.current.style.height = Math.min(textareaRef.current.scrollHeight, 120) + 'px'
      }
    }
  }, [prefillMessage])

  const handleSend = () => {
    const text = input.trim()
    if (!text || isLoading) return
    onSend(text)
    setInput('')
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
    e.target.style.height = 'auto'
    e.target.style.height = Math.min(e.target.scrollHeight, 120) + 'px'
  }

  const hasMessages = messages.length > 0

  return (
    <div className="flex flex-col h-full bg-[#0d0d10] overflow-hidden">
      {/* Query templates */}
      {onTemplateSelect && (
        <QueryTemplates onSelect={(q) => {
          onTemplateSelect(q)
          setInput(q)
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
              placeholder="Type a message…"
              rows={1}
              className="mc-input flex-1 min-h-[20px] max-h-[120px] overflow-y-auto"
            />
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
        <p className="text-[10px] text-[#44444b] mt-1.5 pl-1">
          Enter to send · Shift+Enter for new line
        </p>
      </div>
    </div>
  )
}
