/**
 * session.ts — Signed, httpOnly cookie sessions (interim local auth).
 *
 * SERVER-ONLY.
 *
 * A session is a JSON payload `{ userId, orgId, role, iat, exp }` encoded as
 * base64url and signed with an HMAC-SHA256 MAC using SESSION_SECRET:
 *
 *     cookie value  =  base64url(payloadJson) + "." + base64url(hmac)
 *
 * The MAC is verified with a constant-time comparison on every read, and the
 * `exp` timestamp is enforced. There is no server-side session table — the
 * signed cookie IS the session (stateless). Sessions are still "validated
 * server-side" in the sense that verification (signature + expiry) happens on
 * the server via SESSION_SECRET, which the client never sees.
 *
 * Zero new dependencies: uses node:crypto only.
 */

import crypto from 'crypto'
import type { Role } from './permissions'

export const SESSION_COOKIE_NAME = 'ceiba_session'

/** Session lifetime: 8 hours (a clinical work shift). */
const SESSION_TTL_SECONDS = 8 * 60 * 60

export type SessionPayload = {
  userId: string
  orgId: string
  role: Role
}

type SignedPayload = SessionPayload & {
  /** issued-at (unix seconds) */
  iat: number
  /** expiry (unix seconds) */
  exp: number
}

function getSecret(): string {
  const secret = process.env.SESSION_SECRET
  if (!secret || secret.length < 16) {
    throw new Error(
      'SESSION_SECRET is not set (or too short). Set a strong random value ' +
        '(min 16 chars) in your environment — see .env.example.'
    )
  }
  return secret
}

function base64url(input: Buffer | string): string {
  return Buffer.from(input).toString('base64url')
}

function hmac(data: string): string {
  return crypto.createHmac('sha256', getSecret()).update(data).digest('base64url')
}

/**
 * Serialise + sign a session payload into a cookie string.
 * The returned string is the cookie VALUE (not a Set-Cookie header).
 */
export function signSession(payload: SessionPayload): string {
  const now = Math.floor(Date.now() / 1000)
  const full: SignedPayload = {
    ...payload,
    iat: now,
    exp: now + SESSION_TTL_SECONDS,
  }
  const body = base64url(JSON.stringify(full))
  const mac = hmac(body)
  return `${body}.${mac}`
}

/**
 * Verify a cookie value's signature and expiry.
 * Returns the SessionPayload on success, or null on any failure
 * (malformed, bad signature, expired).
 */
export function verifySession(cookieValue: string | undefined | null): SessionPayload | null {
  if (!cookieValue) return null
  const dot = cookieValue.lastIndexOf('.')
  if (dot <= 0) return null

  const body = cookieValue.slice(0, dot)
  const providedMac = cookieValue.slice(dot + 1)
  const expectedMac = hmac(body)

  // Constant-time comparison. Length-guard first: timingSafeEqual throws on
  // mismatched lengths.
  const provided = Buffer.from(providedMac)
  const expected = Buffer.from(expectedMac)
  if (provided.length !== expected.length) return null
  if (!crypto.timingSafeEqual(provided, expected)) return null

  let parsed: SignedPayload
  try {
    parsed = JSON.parse(Buffer.from(body, 'base64url').toString('utf-8')) as SignedPayload
  } catch {
    return null
  }

  const now = Math.floor(Date.now() / 1000)
  if (typeof parsed.exp !== 'number' || parsed.exp < now) return null
  if (!parsed.userId || !parsed.orgId || !parsed.role) return null

  return { userId: parsed.userId, orgId: parsed.orgId, role: parsed.role }
}

/**
 * verifySessionEdge — Edge/Web-Crypto-safe variant of verifySession, for use
 * in middleware (which runs on the Edge runtime where node:crypto's createHmac
 * is unavailable). Uses SubtleCrypto HMAC-SHA256. Same signing scheme as
 * signSession, so cookies signed on the Node side verify here and vice-versa.
 */
export async function verifySessionEdge(
  cookieValue: string | undefined | null
): Promise<SessionPayload | null> {
  if (!cookieValue) return null
  const dot = cookieValue.lastIndexOf('.')
  if (dot <= 0) return null

  const body = cookieValue.slice(0, dot)
  const providedMac = cookieValue.slice(dot + 1)

  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(getSecret()),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  )
  const sigBuf = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(body))
  const expectedMac = Buffer.from(new Uint8Array(sigBuf)).toString('base64url')

  if (providedMac.length !== expectedMac.length) return null
  // Constant-time-ish compare in the Edge runtime.
  let diff = 0
  for (let i = 0; i < expectedMac.length; i++) {
    diff |= providedMac.charCodeAt(i) ^ expectedMac.charCodeAt(i)
  }
  if (diff !== 0) return null

  let parsed: SignedPayload
  try {
    parsed = JSON.parse(Buffer.from(body, 'base64url').toString('utf-8')) as SignedPayload
  } catch {
    return null
  }

  const now = Math.floor(Date.now() / 1000)
  if (typeof parsed.exp !== 'number' || parsed.exp < now) return null
  if (!parsed.userId || !parsed.orgId || !parsed.role) return null

  return { userId: parsed.userId, orgId: parsed.orgId, role: parsed.role }
}

/**
 * Cookie serialisation options shared by login (set) and logout (clear).
 * httpOnly so JS can never read it; SameSite=Lax; Secure in production.
 */
export function sessionCookieOptions(): {
  httpOnly: true
  sameSite: 'lax'
  secure: boolean
  path: string
  maxAge: number
} {
  return {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    path: '/',
    maxAge: SESSION_TTL_SECONDS,
  }
}
