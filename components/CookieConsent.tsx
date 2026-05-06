'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'
import { Cookie } from 'lucide-react'

const CONSENT_KEY = 'ceiba_cookie_consent'

export default function CookieConsent() {
  const [visible, setVisible] = useState(false)

  useEffect(() => {
    try {
      const accepted = localStorage.getItem(CONSENT_KEY)
      if (!accepted) {
        setVisible(true)
      }
    } catch {
      // localStorage unavailable (SSR or restricted context)
    }
  }, [])

  function handleAccept() {
    try {
      localStorage.setItem(CONSENT_KEY, 'true')
    } catch {
      // ignore
    }
    setVisible(false)
  }

  if (!visible) return null

  return (
    <div className="fixed bottom-0 left-0 right-0 z-50 bg-[#16161a] border-t border-[#2a2a31] px-4 py-3 shadow-2xl">
      <div className="max-w-4xl mx-auto flex flex-col sm:flex-row items-start sm:items-center gap-3">
        <div className="flex items-start gap-2.5 flex-1 min-w-0">
          <Cookie size={16} className="text-[#7c68ff] flex-shrink-0 mt-0.5" />
          <p className="text-[12px] text-[#6c6c74] leading-relaxed">
            We use <span className="text-[#a0a0a7] font-medium">essential cookies</span> for
            authentication and session management. No tracking or advertising cookies are used.
          </p>
        </div>

        <div className="flex items-center gap-3 flex-shrink-0">
          <Link
            href="/privacy"
            className="text-[12px] text-[#44444b] hover:text-[#7c68ff] transition-colors whitespace-nowrap"
          >
            Learn More
          </Link>
          <button
            onClick={handleAccept}
            className="px-4 py-1.5 rounded-[8px] bg-[#7c68ff] hover:bg-[#8f7dff] text-white text-[12px] font-semibold transition-all shadow-md shadow-[#7c68ff30] whitespace-nowrap"
          >
            Accept
          </button>
        </div>
      </div>
    </div>
  )
}
