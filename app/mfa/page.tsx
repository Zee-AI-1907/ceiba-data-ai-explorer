'use client'

import { useState, useRef } from 'react'
import { useRouter } from 'next/navigation'
import { useSession } from 'next-auth/react'
import Link from 'next/link'
import { ShieldCheck, Loader2, Smartphone } from 'lucide-react'

const CODE_LENGTH = 6

export default function MFAPage() {
  const router = useRouter()
  const [digits, setDigits] = useState<string[]>(Array(CODE_LENGTH).fill(''))
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)
  const inputRefs = useRef<(HTMLInputElement | null)[]>([])

  function handleDigitChange(index: number, value: string) {
    const cleaned = value.replace(/\D/g, '').slice(-1)
    const next = [...digits]
    next[index] = cleaned
    setDigits(next)

    if (cleaned && index < CODE_LENGTH - 1) {
      inputRefs.current[index + 1]?.focus()
    }
  }

  function handleKeyDown(index: number, e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === 'Backspace' && !digits[index] && index > 0) {
      inputRefs.current[index - 1]?.focus()
    }
  }

  function handlePaste(e: React.ClipboardEvent) {
    const paste = e.clipboardData.getData('text').replace(/\D/g, '').slice(0, CODE_LENGTH)
    if (!paste) return
    e.preventDefault()
    const next = Array(CODE_LENGTH).fill('')
    paste.split('').forEach((ch, i) => { next[i] = ch })
    setDigits(next)
    const nextFocus = Math.min(paste.length, CODE_LENGTH - 1)
    inputRefs.current[nextFocus]?.focus()
  }

  const { data: session } = useSession()

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    const code = digits.join('')
    if (code.length < CODE_LENGTH) {
      setError('Please enter the full 6-digit code.')
      return
    }

    setError('')
    setLoading(true)

    try {
      const email = session?.user?.email ?? new URLSearchParams(window.location.search).get('email') ?? ''
      const res = await fetch('/api/auth/verify-mfa', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code, email }),
      })
      const data = await res.json()

      if (data.success) {
        router.push('/data-explorer')
      } else {
        setError(data.error ?? 'Invalid code. Please try again.')
        setDigits(Array(CODE_LENGTH).fill(''))
        inputRefs.current[0]?.focus()
      }
    } catch {
      setError('Verification failed. Please try again.')
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="min-h-screen bg-[#0d0d10] flex items-center justify-center px-4">
      <div className="w-full max-w-[400px]">
        {/* Logo + heading */}
        <div className="flex flex-col items-center mb-8">
          <div className="w-12 h-12 rounded-[12px] bg-gradient-to-br from-[#7c68ff] to-[#4c8dff] flex items-center justify-center mb-4 shadow-lg shadow-[#7c68ff30]">
            <span className="text-[16px] font-black text-white tracking-tighter">CH</span>
          </div>
          <h1 className="text-[22px] font-bold text-[#e8e8ea] tracking-tight">Two-Factor Authentication</h1>
          <p className="text-[13px] text-[#6c6c74] mt-1">Enter the 6-digit code from your authenticator app</p>
        </div>

        {/* Card */}
        <div className="bg-[#111114] border border-[#2a2a31] rounded-[16px] p-6 shadow-2xl">
          {/* Instruction */}
          <div className="flex items-center gap-2.5 mb-5 p-3 rounded-[10px] bg-[#7c68ff10] border border-[#7c68ff25]">
            <Smartphone size={14} className="text-[#7c68ff] flex-shrink-0" />
            <p className="text-[12px] text-[#a0a0a7]">
              Using an authenticator app (Google Authenticator, Authy, etc.)
            </p>
          </div>

          <form onSubmit={handleSubmit} className="flex flex-col gap-5">
            {/* OTP inputs */}
            <div className="flex gap-2 justify-center" onPaste={handlePaste}>
              {digits.map((digit, i) => (
                <input
                  key={i}
                  ref={(el) => { inputRefs.current[i] = el }}
                  type="text"
                  inputMode="numeric"
                  maxLength={1}
                  value={digit}
                  onChange={(e) => handleDigitChange(i, e.target.value)}
                  onKeyDown={(e) => handleKeyDown(i, e)}
                  className="w-12 h-14 rounded-[10px] bg-[#16161a] border border-[#2a2a31] text-center text-[22px] font-bold text-[#e8e8ea] outline-none focus:border-[#7c68ff] focus:ring-1 focus:ring-[#7c68ff40] transition-all caret-[#7c68ff]"
                  autoFocus={i === 0}
                />
              ))}
            </div>

            {/* Error */}
            {error && (
              <div className="px-3.5 py-2.5 rounded-[10px] bg-[#ff5c6c15] border border-[#ff5c6c40] text-[12px] text-[#ff5c6c] text-center">
                {error}
              </div>
            )}

            {/* Submit */}
            <button
              type="submit"
              disabled={loading || digits.join('').length < CODE_LENGTH}
              className="w-full min-h-[44px] rounded-[10px] bg-[#7c68ff] hover:bg-[#8f7dff] disabled:opacity-60 disabled:cursor-not-allowed text-white text-[13px] font-semibold transition-all flex items-center justify-center gap-2 shadow-md shadow-[#7c68ff30]"
            >
              {loading ? (
                <>
                  <Loader2 size={15} className="animate-spin" />
                  Verifying…
                </>
              ) : (
                'Verify Code'
              )}
            </button>
          </form>
        </div>

        {/* Back link */}
        <div className="mt-4 flex items-center justify-center gap-2">
          <Link
            href="/login"
            className="text-[12px] text-[#44444b] hover:text-[#6c6c74] transition-colors"
          >
            ← Back to login
          </Link>
        </div>

        {/* HIPAA notice */}
        <div className="mt-4 flex items-start gap-2.5 px-1">
          <ShieldCheck size={14} className="text-[#4dcc88] flex-shrink-0 mt-0.5" />
          <p className="text-[11px] text-[#44444b] leading-relaxed">
            This system contains <span className="text-[#6c6c74]">Protected Health Information</span>.
            Unauthorized access is prohibited and monitored.
          </p>
        </div>
      </div>
    </div>
  )
}
