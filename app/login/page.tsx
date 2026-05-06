'use client'

import { useState } from 'react'
import { signIn } from 'next-auth/react'
import { useRouter } from 'next/navigation'
import Link from 'next/link'
import { Eye, EyeOff, ShieldCheck, Loader2, ChevronDown, ChevronRight, Lock } from 'lucide-react'

export default function LoginPage() {
  const router = useRouter()
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [showPassword, setShowPassword] = useState(false)
  const [error, setError] = useState('')
  const [isRateLimited, setIsRateLimited] = useState(false)
  const [loading, setLoading] = useState(false)
  const [privacyExpanded, setPrivacyExpanded] = useState(false)
  const [privacyAcknowledged, setPrivacyAcknowledged] = useState(false)

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    setError('')
    setLoading(true)

    try {
      const result = await signIn('credentials', {
        email,
        password,
        redirect: false,
      })

      if (result?.error) {
        const msg = result.error
        if (msg?.toLowerCase().includes('too many login attempts')) {
          setIsRateLimited(true)
          setError(msg)
        } else {
          setIsRateLimited(false)
          setError('Invalid email or password. Please try again.')
        }
      } else {
        router.push('/mfa')
      }
    } catch {
      setError('An unexpected error occurred. Please try again.')
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
          <h1 className="text-[22px] font-bold text-[#e8e8ea] tracking-tight">Ceiba Data AI Explorer</h1>
          <p className="text-[13px] text-[#6c6c74] mt-1">Sign in to continue</p>
        </div>

        {/* Card */}
        <div className="bg-[#111114] border border-[#2a2a31] rounded-[16px] p-6 shadow-2xl">
          <form onSubmit={handleSubmit} className="flex flex-col gap-4">
            {/* Email */}
            <div className="flex flex-col gap-1.5">
              <label className="text-[12px] font-medium text-[#a0a0a7]" htmlFor="email">
                Email address
              </label>
              <input
                id="email"
                type="email"
                autoComplete="email"
                required
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="you@ceiba.com"
                className="w-full h-10 px-3.5 rounded-[10px] bg-[#16161a] border border-[#2a2a31] text-[13px] text-[#e8e8ea] placeholder-[#44444b] outline-none focus:border-[#7c68ff] focus:ring-1 focus:ring-[#7c68ff40] transition-all"
              />
            </div>

            {/* Password */}
            <div className="flex flex-col gap-1.5">
              <label className="text-[12px] font-medium text-[#a0a0a7]" htmlFor="password">
                Password
              </label>
              <div className="relative">
                <input
                  id="password"
                  type={showPassword ? 'text' : 'password'}
                  autoComplete="current-password"
                  required
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  placeholder="••••••••"
                  className="w-full h-10 pl-3.5 pr-10 rounded-[10px] bg-[#16161a] border border-[#2a2a31] text-[13px] text-[#e8e8ea] placeholder-[#44444b] outline-none focus:border-[#7c68ff] focus:ring-1 focus:ring-[#7c68ff40] transition-all"
                />
                <button
                  type="button"
                  onClick={() => setShowPassword((v) => !v)}
                  className="absolute right-3 top-1/2 -translate-y-1/2 text-[#44444b] hover:text-[#a0a0a7] transition-colors"
                  tabIndex={-1}
                >
                  {showPassword ? <EyeOff size={15} /> : <Eye size={15} />}
                </button>
              </div>
            </div>

            {/* Error message */}
            {error && (
              <div
                className={`px-3.5 py-2.5 rounded-[10px] text-[12px] ${
                  isRateLimited
                    ? 'bg-[#ffb30015] border border-[#ffb30040] text-[#ffb300]'
                    : 'bg-[#ff5c6c15] border border-[#ff5c6c40] text-[#ff5c6c]'
                }`}
              >
                {error}
              </div>
            )}

            {/* Privacy Notice */}
            <div className="rounded-[10px] bg-[#16161a] border border-[#2a2a31] p-3">
              <button
                type="button"
                onClick={() => setPrivacyExpanded((v) => !v)}
                className="flex items-center gap-1.5 text-[11px] text-[#6c6c74] hover:text-[#a0a0a7] transition-colors w-full text-left"
              >
                {privacyExpanded ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
                <Lock size={11} />
                <span className="font-medium">Privacy Notice (KVKK / GDPR)</span>
              </button>

              {privacyExpanded && (
                <div className="mt-2 max-h-32 overflow-y-auto text-[11px] text-[#6c6c74] leading-relaxed space-y-1.5 pr-1">
                  <p><span className="text-[#a0a0a7] font-medium">Data Controller:</span> Ceiba Healthcare — legal@ceiba-healthcare.com</p>
                  <p><span className="text-[#a0a0a7] font-medium">Purpose:</span> Clinical data analysis, system security monitoring, and healthcare operations.</p>
                  <p><span className="text-[#a0a0a7] font-medium">Legal Basis:</span> Legitimate interest and vital interests (clinical care); legal obligation (HIPAA compliance).</p>
                  <p><span className="text-[#a0a0a7] font-medium">Data Categories:</span> Authentication credentials, clinical query logs, usage audit logs, patient clinical data from connected databases.</p>
                  <p><span className="text-[#a0a0a7] font-medium">Data Transfers:</span> AI narrative generation uses OpenAI (US) — PHI is scrubbed prior to transfer.</p>
                  <p><span className="text-[#a0a0a7] font-medium">Retention:</span> Auth logs 7 years (HIPAA); query audit logs 7 years; session data cleared on logout.</p>
                  <p><span className="text-[#a0a0a7] font-medium">Your Rights (KVKK Art. 11):</span> Access, correction, deletion, restriction, portability, and objection. Contact: <span className="text-[#7c68ff]">legal@ceiba-healthcare.com</span></p>
                  <p className="mt-1">
                    <Link href="/privacy" className="text-[#7c68ff] hover:underline" target="_blank">View full Privacy Policy →</Link>
                  </p>
                </div>
              )}

              <label className="flex items-start gap-2 mt-2.5 cursor-pointer">
                <input
                  type="checkbox"
                  checked={privacyAcknowledged}
                  onChange={(e) => setPrivacyAcknowledged(e.target.checked)}
                  className="mt-0.5 accent-[#7c68ff] cursor-pointer"
                />
                <span className="text-[11px] text-[#6c6c74] leading-relaxed">
                  I acknowledge that I have read and understood the privacy notice and consent to the processing of my data as described.
                </span>
              </label>
            </div>

            {/* Submit */}
            <button
              type="submit"
              disabled={loading || !privacyAcknowledged}
              className="w-full min-h-[44px] rounded-[10px] bg-[#7c68ff] hover:bg-[#8f7dff] disabled:opacity-60 disabled:cursor-not-allowed text-white text-[13px] font-semibold transition-all flex items-center justify-center gap-2 shadow-md shadow-[#7c68ff30] mt-1"
            >
              {loading ? (
                <>
                  <Loader2 size={15} className="animate-spin" />
                  Signing in…
                </>
              ) : (
                'Sign In'
              )}
            </button>
          </form>
        </div>

        {/* MFA setup link */}
        <div className="mt-4 flex items-center justify-center">
          <Link
            href="/mfa/setup"
            className="text-[12px] text-[#44444b] hover:text-[#7c68ff] transition-colors"
          >
            First time? Set up your authenticator app →
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
