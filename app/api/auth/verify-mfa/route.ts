import { NextRequest, NextResponse } from 'next/server'
import { verify as totpVerify, generateSync } from '@otplib/totp'
import { crypto as nobleCrypto } from '@otplib/plugin-crypto-noble'
import { base32 as scureBase32 } from '@otplib/plugin-base32-scure'
import { USERS } from '@/lib/auth'

// Shared TOTP options — allow ±1 time step (30 s) to handle clock drift
const TOTP_OPTIONS = {
  crypto: nobleCrypto,
  base32: scureBase32,
  epochTolerance: 30, // ±1 step tolerance
} as const

/** Exported for use in tests / QR setup page */
export { generateSync, TOTP_OPTIONS }

export async function POST(req: NextRequest) {
  let body: { code?: string; email?: string }
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ success: false, error: 'Invalid JSON body' }, { status: 400 })
  }

  const { code, email } = body

  if (!code || !email) {
    return NextResponse.json({ success: false, error: 'Missing code or email' }, { status: 400 })
  }

  const user = USERS.find((u) => u.email === email)
  if (!user) {
    // Return generic error to avoid user enumeration
    return NextResponse.json({ success: false, error: 'Invalid code. Please try again.' }, { status: 401 })
  }

  const result = await totpVerify({ token: code, secret: user.totpSecret, ...TOTP_OPTIONS })
  const isValid = typeof result === 'object' ? result.valid : result

  if (!isValid) {
    return NextResponse.json({ success: false, error: 'Invalid code. Please try again.' }, { status: 401 })
  }

  return NextResponse.json({ success: true })
}
