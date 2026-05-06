'use client'

import { useEffect, useRef, useState, useCallback } from 'react'
import { signOut } from 'next-auth/react'
import { Clock, RefreshCw } from 'lucide-react'

const TIMEOUT_MS = 15 * 60 * 1000       // 15 minutes
const WARNING_MS = 14 * 60 * 1000       // warn at 14 minutes (1 min before)
const ACTIVITY_EVENTS = ['mousemove', 'keydown', 'click', 'touchstart'] as const

export default function SessionTimeout() {
  const [showWarning, setShowWarning] = useState(false)
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const warnTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const clearTimers = useCallback(() => {
    if (timerRef.current) clearTimeout(timerRef.current)
    if (warnTimerRef.current) clearTimeout(warnTimerRef.current)
  }, [])

  const resetTimer = useCallback(() => {
    clearTimers()
    setShowWarning(false)

    warnTimerRef.current = setTimeout(() => {
      setShowWarning(true)
    }, WARNING_MS)

    timerRef.current = setTimeout(() => {
      signOut({ callbackUrl: '/login' })
    }, TIMEOUT_MS)
  }, [clearTimers])

  useEffect(() => {
    resetTimer()

    const handleActivity = () => resetTimer()

    ACTIVITY_EVENTS.forEach((evt) =>
      window.addEventListener(evt, handleActivity, { passive: true })
    )

    return () => {
      clearTimers()
      ACTIVITY_EVENTS.forEach((evt) =>
        window.removeEventListener(evt, handleActivity)
      )
    }
  }, [resetTimer, clearTimers])

  if (!showWarning) return null

  return (
    <div className="fixed inset-0 z-[9999] flex items-center justify-center bg-black/60 backdrop-blur-sm">
      <div className="w-full max-w-[380px] mx-4 bg-[#111114] border border-[#2a2a31] rounded-[16px] p-6 shadow-2xl">
        <div className="flex flex-col items-center text-center gap-4">
          <div className="w-12 h-12 rounded-full bg-[#f59e0b15] border border-[#f59e0b40] flex items-center justify-center">
            <Clock size={22} className="text-[#f59e0b]" />
          </div>

          <div>
            <h2 className="text-[16px] font-bold text-[#e8e8ea] mb-1">Session Expiring</h2>
            <p className="text-[13px] text-[#6c6c74] leading-relaxed">
              Your session will expire in <span className="text-[#f59e0b] font-semibold">1 minute</span> due
              to inactivity. You will be signed out automatically.
            </p>
          </div>

          <button
            onClick={resetTimer}
            className="w-full min-h-[44px] rounded-[10px] bg-[#7c68ff] hover:bg-[#8f7dff] text-white text-[13px] font-semibold transition-all flex items-center justify-center gap-2 shadow-md shadow-[#7c68ff30]"
          >
            <RefreshCw size={14} />
            Stay Signed In
          </button>

          <button
            onClick={() => signOut({ callbackUrl: '/login' })}
            className="text-[12px] text-[#44444b] hover:text-[#6c6c74] transition-colors"
          >
            Sign out now
          </button>
        </div>
      </div>
    </div>
  )
}
