'use client'

import { useState, useEffect } from 'react'
import { X } from 'lucide-react'

const DISMISS_KEY = 'ceiba_phi_warning_dismissed'

export default function PHIWarning() {
  const [visible, setVisible] = useState(false)

  useEffect(() => {
    // Show only if not dismissed this session
    const dismissed = sessionStorage.getItem(DISMISS_KEY) === 'true'
    if (!dismissed) setVisible(true)
  }, [])

  function dismiss() {
    sessionStorage.setItem(DISMISS_KEY, 'true')
    setVisible(false)
  }

  if (!visible) return null

  return (
    <div className="flex items-start justify-between gap-3 px-4 py-2.5 bg-[#f59e0b15] border-b border-[#f59e0b40] text-[#f59e0b] flex-shrink-0">
      <p className="text-[11px] leading-relaxed font-medium">
        ⚠️ This system contains Protected Health Information (PHI). All access is logged. Unauthorized access is prohibited under HIPAA.
      </p>
      <button
        onClick={dismiss}
        aria-label="Dismiss PHI warning"
        className="flex-shrink-0 w-5 h-5 flex items-center justify-center rounded-full hover:bg-[#f59e0b20] transition-colors mt-0.5"
      >
        <X size={11} />
      </button>
    </div>
  )
}
