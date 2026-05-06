'use client'

import { Sparkles, RefreshCw, X, AlertTriangle } from 'lucide-react'
import { clsx } from 'clsx'

export interface NarrativeResult {
  narrative: string
  highlights: string[]
  anomalies: string[]
}

interface Props {
  narrative?: NarrativeResult | null
  isGenerating?: boolean
  onRegenerate?: () => void
  onDismiss?: () => void
}

export function NarrativePanel({ narrative, isGenerating, onRegenerate, onDismiss }: Props) {
  // Show nothing if there's no data and we're not loading
  if (!isGenerating && !narrative) return null

  return (
    <div
      className={clsx(
        'mx-3 mt-3 rounded-[12px] bg-[#16161a] border border-[#2a2a31] overflow-hidden',
        'transition-all duration-300 ease-out',
        'animate-narrative-in'
      )}
      style={{
        animation: 'narrativeSlideIn 0.25s ease-out both',
      }}
    >
      {/* Header bar */}
      <div className="flex items-center justify-between px-3.5 py-2.5 border-b border-[#2a2a31]">
        <div className="flex items-center gap-2">
          <Sparkles size={13} className="text-[#7c68ff]" />
          <span className="text-[11px] font-semibold text-[#7c68ff] uppercase tracking-wider">
            AI Insight
          </span>
        </div>
        <div className="flex items-center gap-1">
          {!isGenerating && onRegenerate && (
            <button
              onClick={onRegenerate}
              title="Regenerate"
              className="flex items-center gap-1 px-2 py-1 rounded-[6px] text-[11px] text-[#6c6c74] hover:text-[#a0a0a7] hover:bg-[#1f1f25] transition-all"
            >
              <RefreshCw size={11} />
              <span>Regenerate</span>
            </button>
          )}
          {onDismiss && (
            <button
              onClick={onDismiss}
              title="Dismiss"
              className="flex items-center justify-center w-6 h-6 rounded-[6px] text-[#6c6c74] hover:text-[#a0a0a7] hover:bg-[#1f1f25] transition-all"
            >
              <X size={12} />
            </button>
          )}
        </div>
      </div>

      {/* Content */}
      <div className="px-3.5 py-3 space-y-3">
        {/* Loading skeleton */}
        {isGenerating && (
          <div className="space-y-2">
            <div className="h-3 rounded-full bg-[#2a2a31] animate-pulse" style={{ width: '92%' }} />
            <div className="h-3 rounded-full bg-[#2a2a31] animate-pulse" style={{ width: '78%' }} />
            <div className="h-3 rounded-full bg-[#2a2a31] animate-pulse" style={{ width: '85%' }} />
          </div>
        )}

        {/* Narrative text */}
        {!isGenerating && narrative?.narrative && (
          <p className="text-[13px] text-[#c9ccd3] leading-relaxed">
            {narrative.narrative}
          </p>
        )}

        {/* Highlight chips */}
        {!isGenerating && narrative?.highlights && narrative.highlights.length > 0 && (
          <div className="flex flex-wrap gap-1.5">
            {narrative.highlights.map((h, i) => (
              <span
                key={i}
                className="bg-[#4dcc8820] text-[#4dcc88] border border-[#4dcc8840] rounded-full px-2.5 py-0.5 text-[11px]"
              >
                {h}
              </span>
            ))}
          </div>
        )}

        {/* Anomaly row */}
        {!isGenerating && narrative?.anomalies && narrative.anomalies.length > 0 && (
          <div className="space-y-1">
            <div className="flex items-center gap-1.5">
              <AlertTriangle size={11} className="text-[#ff5c6c]" />
              <span className="text-[11px] font-semibold text-[#ff5c6c]">
                Anomalies detected
              </span>
            </div>
            <div className="flex flex-wrap gap-1.5">
              {narrative.anomalies.map((a, i) => (
                <span
                  key={i}
                  className="bg-[#ff5c6c20] text-[#ff5c6c] border border-[#ff5c6c40] rounded-full px-2.5 py-0.5 text-[11px]"
                >
                  {a}
                </span>
              ))}
            </div>
          </div>
        )}
      </div>

      <style jsx>{`
        @keyframes narrativeSlideIn {
          from {
            opacity: 0;
            transform: translateY(-6px);
          }
          to {
            opacity: 1;
            transform: translateY(0);
          }
        }
      `}</style>
    </div>
  )
}
