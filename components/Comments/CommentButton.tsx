'use client'

import { useState, useEffect } from 'react'
import { MessageCircle } from 'lucide-react'
import { clsx } from 'clsx'
import { getComments, type Comment } from '@/lib/commentStore'

type Props = {
  resourceType: Comment['resourceType']
  resourceId: string
  isOpen?: boolean
  onClick?: () => void
  className?: string
}

export function CommentButton({
  resourceType,
  resourceId,
  isOpen = false,
  onClick,
  className,
}: Props) {
  const [count, setCount] = useState(0)
  const [hasMention, setHasMention] = useState(false)

  useEffect(() => {
    const comments = getComments(resourceType, resourceId)
    setCount(comments.length)
    // Check if any comments mention "afsin" (the current user)
    const mentioned = comments.some(
      (c) => !c.resolved && c.mentions.includes('afsin'),
    )
    setHasMention(mentioned)
  }, [resourceType, resourceId, isOpen]) // re-check when panel closes (new comment may have been added)

  return (
    <button
      onClick={onClick}
      title={`${count} comment${count !== 1 ? 's' : ''}`}
      className={clsx(
        'relative flex items-center gap-1 px-2 py-1 rounded-[6px] text-[11px] font-medium transition-colors',
        isOpen
          ? 'bg-[#7c68ff20] text-[#7c68ff]'
          : 'text-[#6c6c74] hover:text-[#a0a0a7] hover:bg-[#1f1f25]',
        className,
      )}
    >
      <MessageCircle size={13} />
      {count > 0 && <span>{count}</span>}

      {/* Red dot for unread mentions */}
      {hasMention && (
        <span className="absolute -top-0.5 -right-0.5 w-2 h-2 rounded-full bg-[#ff5c6c] border border-[#0d0d10]" />
      )}
    </button>
  )
}
