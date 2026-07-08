'use client'

import { useState } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'

export default function SignInPage() {
  const router = useRouter()
  const searchParams = useSearchParams()
  const redirect = searchParams.get('redirect') || '/data-explorer'

  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    setError(null)
    setLoading(true)
    try {
      const res = await fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password }),
      })
      if (!res.ok) {
        const data = await res.json().catch(() => ({}))
        setError((data as { error?: string }).error || 'Sign in failed')
        setLoading(false)
        return
      }
      router.push(redirect)
      router.refresh()
    } catch {
      setError('Network error — please try again')
      setLoading(false)
    }
  }

  return (
    <div className="min-h-screen bg-[#0d0d10] flex items-center justify-center px-4">
      <div className="flex flex-col items-center gap-6 w-full max-w-[360px]">
        <div className="text-center">
          <h1 className="text-[28px] font-bold text-[#e8e8ea] mb-1">Ceiba Data AI Explorer</h1>
          <p className="text-[13px] text-[#6c6c74]">Clinical Data Intelligence Platform</p>
        </div>

        <form
          onSubmit={handleSubmit}
          className="w-full bg-[#16161a] border border-[#2a2a31] shadow-xl rounded-[10px] p-6 flex flex-col gap-4"
        >
          <div className="flex flex-col gap-1.5">
            <label htmlFor="email" className="text-[12px] font-medium text-[#a0a0a7]">Email</label>
            <input
              id="email"
              type="email"
              autoComplete="username"
              required
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              className="h-10 px-3 rounded-[8px] bg-[#1f1f25] border border-[#2a2a31] text-[13px] text-[#e8e8ea] outline-none focus:border-[#7c68ff] transition-colors"
              placeholder="you@example.com"
            />
          </div>

          <div className="flex flex-col gap-1.5">
            <label htmlFor="password" className="text-[12px] font-medium text-[#a0a0a7]">Password</label>
            <input
              id="password"
              type="password"
              autoComplete="current-password"
              required
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              className="h-10 px-3 rounded-[8px] bg-[#1f1f25] border border-[#2a2a31] text-[13px] text-[#e8e8ea] outline-none focus:border-[#7c68ff] transition-colors"
              placeholder="••••••••"
            />
          </div>

          {error && (
            <p className="text-[12px] text-[#ff5c6c] bg-[#ff5c6c10] border border-[#ff5c6c30] rounded-[8px] px-3 py-2">
              {error}
            </p>
          )}

          <button
            type="submit"
            disabled={loading}
            className="h-10 rounded-[8px] bg-[#7c68ff] hover:bg-[#6a58e8] disabled:opacity-60 disabled:cursor-not-allowed text-[13px] font-semibold text-white transition-colors"
          >
            {loading ? 'Signing in…' : 'Sign in'}
          </button>
        </form>

        <p className="text-[10px] text-[#44444b] max-w-[320px] text-center">
          This system contains Protected Health Information. Unauthorized access is prohibited and monitored.
        </p>
      </div>
    </div>
  )
}
