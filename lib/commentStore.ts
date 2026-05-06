// Comment Store — obfuscated-localStorage-backed

export type Comment = {
  id: string
  resourceType: 'dashboard' | 'chart' | 'widget'
  resourceId: string
  author: string
  authorInitials: string
  content: string
  mentions: string[] // usernames mentioned
  createdAt: string // ISO string
  resolved: boolean
}

import { secureGetSync, secureSetSync } from '@/lib/secureStorage'

const COMMENTS_KEY = 'comments'

// Seed comments — only written once on first load
const SEED_COMMENTS: Comment[] = [
  {
    id: 'comment-seed-1',
    resourceType: 'dashboard',
    resourceId: 'icu-dashboard',
    author: 'Dr. Afsin Alp',
    authorInitials: 'AA',
    content: 'ICU census looks high this week — @ege can you verify the data source?',
    mentions: ['ege'],
    createdAt: new Date(Date.now() - 1000 * 60 * 60 * 5).toISOString(),
    resolved: false,
  },
  {
    id: 'comment-seed-2',
    resourceType: 'dashboard',
    resourceId: 'icu-dashboard',
    author: 'Ege Apak',
    authorInitials: 'EA',
    content: 'Confirmed, pulling from Eclinics.DB Unit 4 table. — @afsin',
    mentions: ['afsin'],
    createdAt: new Date(Date.now() - 1000 * 60 * 60 * 3).toISOString(),
    resolved: false,
  },
  {
    id: 'comment-seed-3',
    resourceType: 'dashboard',
    resourceId: 'icu-dashboard',
    author: 'Clinical Lead',
    authorInitials: 'CL',
    content: '⚠ This readmission rate seems off. Flagging for review. — @clinical',
    mentions: ['clinical'],
    createdAt: new Date(Date.now() - 1000 * 60 * 60 * 1).toISOString(),
    resolved: false,
  },
  {
    id: 'comment-seed-4',
    resourceType: 'widget',
    resourceId: 'call-duration-by-user',
    author: 'Hazar',
    authorInitials: 'HZ',
    content: 'Numbers look good this quarter. @afsin approved the dataset.',
    mentions: ['afsin'],
    createdAt: new Date(Date.now() - 1000 * 60 * 30).toISOString(),
    resolved: false,
  },
]

function seed(): void {
  if (typeof window === 'undefined') return
  if (secureGetSync<Comment[]>(COMMENTS_KEY) === null) {
    secureSetSync(COMMENTS_KEY, SEED_COMMENTS)
  }
}

export function getComments(resourceType: Comment['resourceType'], resourceId: string): Comment[] {
  if (typeof window === 'undefined') return []
  seed()
  const all = secureGetSync<Comment[]>(COMMENTS_KEY) ?? []
  return all.filter((c) => c.resourceType === resourceType && c.resourceId === resourceId)
}

export function getAllComments(): Comment[] {
  if (typeof window === 'undefined') return []
  seed()
  return secureGetSync<Comment[]>(COMMENTS_KEY) ?? []
}

export function addComment(
  comment: Omit<Comment, 'id' | 'createdAt'>
): Comment {
  const all = getAllComments()
  const newComment: Comment = {
    ...comment,
    id: `comment-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
    createdAt: new Date().toISOString(),
  }
  all.push(newComment)
  secureSetSync(COMMENTS_KEY, all)
  return newComment
}

export function resolveComment(id: string): void {
  const all = getAllComments()
  const idx = all.findIndex((c) => c.id === id)
  if (idx >= 0) {
    all[idx].resolved = true
    secureSetSync(COMMENTS_KEY, all)
  }
}

export function deleteComment(id: string): void {
  const all = getAllComments().filter((c) => c.id !== id)
  secureSetSync(COMMENTS_KEY, all)
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

export function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
}

export function parseMentions(content: string): string[] {
  const matches = content.match(/@([a-z0-9_]+)/gi) ?? []
  return matches.map((m) => m.slice(1).toLowerCase())
}

export function formatRelativeTime(isoString: string): string {
  const diff = Date.now() - new Date(isoString).getTime()
  const minutes = Math.floor(diff / 60000)
  if (minutes < 1) return 'just now'
  if (minutes < 60) return `${minutes} minute${minutes !== 1 ? 's' : ''} ago`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours} hour${hours !== 1 ? 's' : ''} ago`
  const days = Math.floor(hours / 24)
  return `${days} day${days !== 1 ? 's' : ''} ago`
}

// Avatar color derived from name
const AVATAR_PALETTE = [
  '#7c68ff', '#4c8dff', '#4dcc88', '#f4a942', '#ff6b9d', '#4ec9c9', '#a78bfa', '#fb923c',
]

export function avatarColor(name: string): string {
  let hash = 0
  for (let i = 0; i < name.length; i++) hash = name.charCodeAt(i) + ((hash << 5) - hash)
  return AVATAR_PALETTE[Math.abs(hash) % AVATAR_PALETTE.length]
}
