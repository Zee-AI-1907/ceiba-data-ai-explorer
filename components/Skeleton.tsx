'use client'

/**
 * Skeleton loaders for pages that hydrate from localStorage.
 * Use while data is being loaded on the client to prevent layout shifts.
 *
 * Color: bg-[#1f1f25] with animate-pulse, consistent with Ceiba Data dark theme.
 */

// ── Base ─────────────────────────────────────────────────────────────────────

/** A single animated skeleton line. */
export function SkeletonLine({ width = '100%', height = 12 }: { width?: string | number; height?: number }) {
  return (
    <div
      className="bg-[#1f1f25] animate-pulse rounded"
      style={{ width, height }}
    />
  )
}

// ── Card ─────────────────────────────────────────────────────────────────────

/** A card-shaped skeleton block used for dashboard/chart card placeholders. */
export function SkeletonCard({ className = '' }: { className?: string }) {
  return (
    <div className={`bg-[#111114] border border-[#2a2a31] rounded-[14px] p-5 flex flex-col gap-3 ${className}`}>
      {/* Title line */}
      <SkeletonLine width="55%" height={14} />
      {/* Subtitle */}
      <SkeletonLine width="80%" height={10} />
      {/* Body block */}
      <div className="bg-[#1f1f25] animate-pulse rounded-[8px] h-[120px] w-full mt-1" />
      {/* Footer */}
      <div className="flex gap-2 mt-1">
        <SkeletonLine width="30%" height={10} />
        <SkeletonLine width="20%" height={10} />
      </div>
    </div>
  )
}

// ── Table ─────────────────────────────────────────────────────────────────────

/** A table skeleton with configurable row count. */
export function SkeletonTable({ rows = 5 }: { rows?: number }) {
  return (
    <div className="w-full">
      {/* Header */}
      <div className="flex gap-4 px-4 py-3 border-b border-[#2a2a31] bg-[#111114]">
        {[40, 25, 20, 15].map((w, i) => (
          <SkeletonLine key={i} width={`${w}%`} height={10} />
        ))}
      </div>
      {/* Rows */}
      {Array.from({ length: rows }).map((_, i) => (
        <div
          key={i}
          className={`flex gap-4 px-4 py-3 border-b border-[#1f1f25] ${i % 2 === 1 ? 'bg-[#0f0f12]' : ''}`}
        >
          {[40, 25, 20, 15].map((w, j) => (
            <SkeletonLine key={j} width={`${w}%`} height={12} />
          ))}
        </div>
      ))}
    </div>
  )
}
