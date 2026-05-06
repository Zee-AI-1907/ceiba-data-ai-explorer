import { getToken } from 'next-auth/jwt'
import { NextRequest, NextResponse } from 'next/server'

const PUBLIC_PATHS = [
  '/login',
  '/mfa',
  '/api/auth',
  '/api/billing/webhook', // Stripe calls this — no user auth
  '/suspended',
  '/_next',
  '/favicon.ico',
  '/public',
]

export async function middleware(req: NextRequest) {
  const { pathname } = req.nextUrl

  // Allow public paths
  if (PUBLIC_PATHS.some((p) => pathname.startsWith(p))) {
    return NextResponse.next()
  }

  // ── 1. Auth check ────────────────────────────────────────────────────────
  const token = await getToken({ req, secret: process.env.NEXTAUTH_SECRET })

  if (!token) {
    // API routes return 401 JSON; page routes redirect to login
    if (pathname.startsWith('/api/')) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }
    const loginUrl = new URL('/login', req.url)
    loginUrl.searchParams.set('callbackUrl', pathname)
    return NextResponse.redirect(loginUrl)
  }

  // ── 2. License check ─────────────────────────────────────────────────────
  // For MVP: read licenses.json from the filesystem.
  // Edge runtime cannot use `fs`, so we call our own internal API instead.
  // To avoid circular calls we do a lightweight inline check via fetch only
  // when not already on an API route (prevents request loops).
  //
  // We catch all errors so a missing/malformed licenses.json never hard-blocks
  // access — fail open for resilience.
  if (!pathname.startsWith('/api/')) {
    try {
      const licenseCheckUrl = new URL('/api/billing/licenses/status', req.url)
      const res = await fetch(licenseCheckUrl.toString(), {
        headers: { 'x-internal-license-check': '1' },
      })
      if (res.ok) {
        const { hasActive, hasGrace } = await res.json() as {
          hasActive: boolean
          hasGrace: boolean
        }
        if (!hasActive && !hasGrace) {
          return NextResponse.redirect(new URL('/suspended', req.url))
        }
        if (!hasActive && hasGrace) {
          const response = NextResponse.next()
          response.headers.set('X-License-Warning', 'grace_period')
          return response
        }
      }
    } catch {
      // Fail open — don't block users if license check errors
    }
  }

  return NextResponse.next()
}

export const config = {
  matcher: [
    '/((?!_next/static|_next/image|favicon\\.ico|public).*)',
  ],
}
