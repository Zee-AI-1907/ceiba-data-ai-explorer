'use client'

import { useState, useEffect, useRef, useCallback } from 'react'
import { X, Send, Check, Trash2 } from 'lucide-react'
import { clsx } from 'clsx'
import {
  getComments,
  addComment,
  resolveComment,
  deleteComment,
  parseMentions,
  formatRelativeTime,
  avatarColor,
  type Comment,
} from '@/lib/commentStore'
import { addNotification } from '@/lib/notificationStore'

// ─── Team members for @mention autocomplete ───────────────────────────────────

const TEAM_MEMBERS = [
  { display: 'Dr. Afsin Alp',  username: 'afsin',   initials: 'AA' },
  { display: 'Ege Apak',       username: 'ege',     initials: 'EA' },
  { display: 'Hazar',          username: 'hazar',   initials: 'HZ' },
  { display: 'Clinical Lead',  username: 'clinical',initials: 'CL' },
]

// ─── Render comment text with @mention highlights ─────────────────────────────

function CommentText({ content }: { content: string }) {
  const parts = content.split(/(@[a-z0-9_]+)/gi)
  return (
    <span>
      {parts.map((part, i) =>
        /^@[a-z0-9_]+$/i.test(part) ? (
          <span key={i} className="text-[#7c68ff] font-medium">{part}</span>
        ) : (
          <span key={i}>{part}</span>
        )
      )}
    </span>
  )
}

// ─── Single comment card ──────────────────────────────────────────────────────

function CommentCard({
  comment,
  onResolve,
  onDelete,
}: {
  comment: Comment
  onResolve: (id: string) => void
  onDelete: (id: string) => void
}) {
  const color = avatarColor(comment.author)
  return (
    <div
      className={clsx(
        'flex gap-2.5 p-3 rounded-[10px] group',
        comment.resolved ? 'opacity-50' : 'hover:bg-[#16161a]',
      )}
    >
      {/* Avatar */}
      <div
        className="w-7 h-7 rounded-full flex items-center justify-center text-[10px] font-bold text-[#0b0b0c] flex-shrink-0 mt-0.5"
        style={{ backgroundColor: color }}
      >
        {comment.authorInitials}
      </div>

      {/* Content */}
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2 mb-0.5">
          <span className="text-[12px] font-semibold text-[#e8e8ea]">{comment.author}</span>
          <span className="text-[10px] text-[#44444b]">{formatRelativeTime(comment.createdAt)}</span>
        </div>
        <p
          className={clsx(
            'text-[12px] text-[#a0a0a7] leading-relaxed',
            comment.resolved && 'line-through',
          )}
        >
          <CommentText content={comment.content} />
        </p>
      </div>

      {/* Actions — shown on hover */}
      <div className="flex items-start gap-1 opacity-0 group-hover:opacity-100 transition-opacity flex-shrink-0">
        {!comment.resolved && (
          <button
            onClick={() => onResolve(comment.id)}
            className="w-6 h-6 flex items-center justify-center rounded-[5px] text-[#44444b] hover:text-[#4dcc88] hover:bg-[#4dcc8815] transition-colors"
            title="Mark resolved"
          >
            <Check size={12} />
          </button>
        )}
        <button
          onClick={() => onDelete(comment.id)}
          className="w-6 h-6 flex items-center justify-center rounded-[5px] text-[#44444b] hover:text-[#ff5c6c] hover:bg-[#ff5c6c15] transition-colors"
          title="Delete"
        >
          <Trash2 size={12} />
        </button>
      </div>
    </div>
  )
}

// ─── Props ─────────────────────────────────────────────────────────────────────

type Props = {
  resourceType: Comment['resourceType']
  resourceId: string
  resourceLabel?: string
  onClose?: () => void
  /** When true the panel is rendered as a slide-over; otherwise inline */
  mode?: 'slideover' | 'inline'
}

// ─── CommentThread ─────────────────────────────────────────────────────────────

export function CommentThread({
  resourceType,
  resourceId,
  resourceLabel = '',
  onClose,
  mode = 'inline',
}: Props) {
  const [comments, setComments] = useState<Comment[]>([])
  const [text, setText] = useState('')
  const [mentionQuery, setMentionQuery] = useState<string | null>(null)
  const [mentionAnchor, setMentionAnchor] = useState(0) // cursor position of @
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const listRef = useRef<HTMLDivElement>(null)

  const refresh = useCallback(() => {
    setComments(getComments(resourceType, resourceId))
  }, [resourceType, resourceId])

  useEffect(() => {
    refresh()
  }, [refresh])

  // Scroll to bottom when new comments arrive
  useEffect(() => {
    if (listRef.current) {
      listRef.current.scrollTop = listRef.current.scrollHeight
    }
  }, [comments.length])

  // ── Textarea input handler ──
  const handleInput = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    const val = e.target.value
    setText(val)

    // Detect @mention trigger
    const cursor = e.target.selectionStart ?? val.length
    const before = val.slice(0, cursor)
    const match = before.match(/@([a-z0-9_]*)$/i)
    if (match) {
      setMentionQuery(match[1].toLowerCase())
      setMentionAnchor(cursor - match[0].length)
    } else {
      setMentionQuery(null)
    }
  }

  // ── Select a mention from dropdown ──
  const selectMention = (username: string) => {
    const before = text.slice(0, mentionAnchor)
    const after = text.slice(mentionAnchor).replace(/^@[a-z0-9_]*/i, '')
    const newText = `${before}@${username} ${after}`
    setText(newText)
    setMentionQuery(null)
    textareaRef.current?.focus()
  }

  // ── Submit ──
  const handleSubmit = () => {
    const trimmed = text.trim()
    if (!trimmed) return

    const mentions = parseMentions(trimmed)

    addComment({
      resourceType,
      resourceId,
      author: 'Dr. Afsin Alp',
      authorInitials: 'AA',
      content: trimmed,
      mentions,
      resolved: false,
    })

    // Add mention notifications
    mentions.forEach((username) => {
      const member = TEAM_MEMBERS.find((m) => m.username === username)
      if (member) {
        addNotification({
          message: `💬 @${username} mentioned you in a comment on '${resourceLabel || resourceId}'`,
          severity: 'info',
        })
      }
    })

    setText('')
    setMentionQuery(null)
    refresh()
  }

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
      e.preventDefault()
      handleSubmit()
    }
    if (e.key === 'Escape') {
      setMentionQuery(null)
    }
  }

  const handleResolve = (id: string) => {
    resolveComment(id)
    refresh()
  }

  const handleDelete = (id: string) => {
    deleteComment(id)
    refresh()
  }

  const filteredMembers =
    mentionQuery !== null
      ? TEAM_MEMBERS.filter(
          (m) =>
            m.username.includes(mentionQuery) ||
            m.display.toLowerCase().includes(mentionQuery),
        )
      : []

  // ── Mention dropdown ──
  const MentionDropdown = filteredMembers.length > 0 && (
    <div className="absolute bottom-full left-0 mb-1 w-[220px] bg-[#16161a] border border-[#2a2a31] rounded-[10px] shadow-xl overflow-hidden z-50">
      {filteredMembers.map((m) => (
        <button
          key={m.username}
          onMouseDown={(e) => {
            e.preventDefault() // prevent textarea blur
            selectMention(m.username)
          }}
          className="flex items-center gap-2.5 w-full px-3 py-2 hover:bg-[#1f1f25] transition-colors text-left"
        >
          <div
            className="w-6 h-6 rounded-full flex items-center justify-center text-[9px] font-bold text-[#0b0b0c] flex-shrink-0"
            style={{ backgroundColor: avatarColor(m.display) }}
          >
            {m.initials}
          </div>
          <div>
            <p className="text-[12px] text-[#e8e8ea] font-medium">{m.display}</p>
            <p className="text-[10px] text-[#44444b]">@{m.username}</p>
          </div>
        </button>
      ))}
    </div>
  )

  // ── Panel content ──
  const content = (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-3 border-b border-[#2a2a31] flex-shrink-0">
        <span className="text-[13px] font-semibold text-[#e8e8ea]">
          Comments{' '}
          <span className="text-[#44444b] font-normal">({comments.length})</span>
        </span>
        {onClose && (
          <button
            onClick={onClose}
            className="w-6 h-6 flex items-center justify-center rounded-[5px] text-[#44444b] hover:text-[#a0a0a7] hover:bg-[#1f1f25] transition-colors"
          >
            <X size={13} />
          </button>
        )}
      </div>

      {/* Comment list */}
      <div ref={listRef} className="flex-1 overflow-y-auto px-2 py-2 space-y-0.5 min-h-0">
        {comments.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-full gap-2 py-10 text-center">
            <span className="text-[28px]">💬</span>
            <p className="text-[12px] text-[#6c6c74]">No comments yet.</p>
            <p className="text-[11px] text-[#44444b]">Start the conversation.</p>
          </div>
        ) : (
          comments.map((c) => (
            <CommentCard
              key={c.id}
              comment={c}
              onResolve={handleResolve}
              onDelete={handleDelete}
            />
          ))
        )}
      </div>

      {/* Input area */}
      <div className="flex-shrink-0 px-3 pb-3 pt-2 border-t border-[#2a2a31]">
        <div className="relative">
          {MentionDropdown}
          <textarea
            ref={textareaRef}
            value={text}
            onChange={handleInput}
            onKeyDown={handleKeyDown}
            rows={3}
            placeholder="Add a comment... use @ to mention"
            className="w-full resize-none bg-[#111114] border border-[#2a2a31] rounded-[8px] px-3 py-2 text-[12px] text-[#e8e8ea] placeholder-[#44444b] outline-none focus:border-[#7c68ff] transition-colors"
          />
        </div>
        <div className="flex items-center justify-between mt-1.5">
          <span className="text-[10px] text-[#44444b]">⌘↵ to send</span>
          <button
            onClick={handleSubmit}
            disabled={!text.trim()}
            className={clsx(
              'flex items-center gap-1.5 px-3 py-1.5 rounded-[7px] text-[12px] font-semibold transition-all',
              text.trim()
                ? 'bg-[#7c68ff] text-white hover:bg-[#9080ff] shadow-[0_2px_8px_rgba(124,104,255,0.3)]'
                : 'bg-[#1f1f25] text-[#44444b] cursor-not-allowed',
            )}
          >
            <Send size={11} />
            Send
          </button>
        </div>
      </div>
    </div>
  )

  if (mode === 'slideover') {
    return content
  }

  // Inline mode — rendered directly
  return (
    <div className="bg-[#0d0d10] border border-[#2a2a31] rounded-[12px] flex flex-col overflow-hidden" style={{ height: 380 }}>
      {content}
    </div>
  )
}
