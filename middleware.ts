import { NextResponse, type NextRequest } from 'next/server'
import { SESSION_COOKIE_NAME, verifySessionEdge } from '@/lib/session'

/**
 * Local-session middleware (Clerk-free).
 *
 * - Public routes are always allowed.
 * - For /api/* protected routes: return 401 JSON when there is no valid session.
 * - For app pages: redirect unauthenticated users to /sign-in (with ?redirect).
 *
 * NOTE: This is a coarse authentication gate only. Per-route PERMISSION checks
 * (403) stay in the route handlers via requireAuthWithPermission — do NOT add
 * permission logic here.
 */

const PUBLIC_ROUTES = [
  '/sign-in',
  '/sign-up',
  '/privacy',
  '/api/auth/login',
  '/api/auth/logout',
  '/api/privacy/request',
]

function isPublic(pathname: string): boolean {
  return PUBLIC_ROUTES.some(
    (route) => pathname === route || pathname.startsWith(route + '/')
  )
}

export default async function middleware(req: NextRequest) {
  const { pathname } = req.nextUrl

  if (isPublic(pathname)) {
    return NextResponse.next()
  }

  const cookieValue = req.cookies.get(SESSION_COOKIE_NAME)?.value
  const session = await verifySessionEdge(cookieValue)

  if (session) {
    return NextResponse.next()
  }

  // No valid session.
  if (pathname.startsWith('/api/')) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const signInUrl = new URL('/sign-in', req.url)
  signInUrl.searchParams.set('redirect', pathname)
  return NextResponse.redirect(signInUrl)
}

export const config = {
  matcher: ['/((?!_next|[^?]*\\.(?:html?|css|js(?!on)|jpe?g|webp|png|gif|svg|ttf|woff2?|ico|csv|docx?|xlsx?|zip|webmanifest)).*)', '/(api|trpc)(.*)'],
}
