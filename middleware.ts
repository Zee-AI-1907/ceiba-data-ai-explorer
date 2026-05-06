import { clerkMiddleware, createRouteMatcher } from '@clerk/nextjs/server'
import { NextResponse } from 'next/server'

const isPublicRoute = createRouteMatcher([
  '/sign-in(.*)',
  '/sign-up(.*)',
  '/suspended(.*)',
  '/privacy(.*)',
  '/api/billing/webhook(.*)',
  '/api/privacy/request(.*)',
])

export default clerkMiddleware(async (auth, req) => {
  if (!isPublicRoute(req)) {
    await auth.protect()
  }

  // ── License check ─────────────────────────────────────────────────────────
  // Only run for page routes (not API), after auth check.
  // We catch all errors so a missing/malformed licenses.json never hard-blocks
  // access — fail open for resilience.
  const { pathname } = req.nextUrl
  if (!isPublicRoute(req) && !pathname.startsWith('/api/')) {
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
})

export const config = {
  matcher: ['/((?!_next|[^?]*\\.(?:html?|css|js(?!on)|jpe?g|webp|png|gif|svg|ttf|woff2?|ico|csv|docx?|xlsx?|zip|webmanifest)).*)', '/(api|trpc)(.*)'],
}
