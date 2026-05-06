import type { NextAuthOptions } from 'next-auth'
import CredentialsProvider from 'next-auth/providers/credentials'
import bcrypt from 'bcryptjs'
import { checkRateLimit, recordFailure, resetLimit } from '@/lib/rateLimiter'

// Demo TOTP secret shared by all users for MVP simplicity.
// In production, each user would have a unique secret stored in the database.
const DEMO_TOTP_SECRET = process.env.MFA_TOTP_SECRET ?? 'WHRTRD3ORPCZ7WO2YYZ6TPLAPLS3R3LL'

export const USERS = [
  {
    id: '1',
    name: 'Dr. Afsin Alp',
    email: 'afsin@ceiba.com',
    role: 'admin',
    password: bcrypt.hashSync('ceiba2026', 10),
    totpSecret: DEMO_TOTP_SECRET,
  },
  {
    id: '2',
    name: 'Ege Apak',
    email: 'ege@ceiba.com',
    role: 'analyst',
    password: bcrypt.hashSync('ceiba2026', 10),
    totpSecret: DEMO_TOTP_SECRET,
  },
  {
    id: '3',
    name: 'Clinical Lead',
    email: 'clinical@ceiba.com',
    role: 'clinician',
    password: bcrypt.hashSync('ceiba2026', 10),
    totpSecret: DEMO_TOTP_SECRET,
  },
]

export const authOptions: NextAuthOptions = {
  providers: [
    CredentialsProvider({
      name: 'Credentials',
      credentials: {
        email: { label: 'Email', type: 'email' },
        password: { label: 'Password', type: 'password' },
      },
      async authorize(credentials, req) {
        if (!credentials?.email || !credentials?.password) return null

        // Extract client IP for rate-limit key
        const forwardedFor = req?.headers?.['x-forwarded-for']
        const ip = Array.isArray(forwardedFor)
          ? forwardedFor[0]?.split(',')[0]?.trim()
          : typeof forwardedFor === 'string'
          ? forwardedFor.split(',')[0]?.trim()
          : (req?.headers?.['x-real-ip'] as string | undefined) ?? 'unknown'

        const rateLimitKey = `login:${ip}:${credentials.email}`

        // Check rate limit before touching credentials
        const rl = checkRateLimit(rateLimitKey)
        if (!rl.allowed) {
          const minutes = Math.ceil((rl.retryAfter ?? 900) / 60)
          throw new Error(`Too many login attempts. Try again in ${minutes} minute${minutes !== 1 ? 's' : ''}.`)
        }

        const user = USERS.find((u) => u.email === credentials.email)
        if (!user) {
          recordFailure(rateLimitKey)
          return null
        }

        const valid = await bcrypt.compare(credentials.password, user.password)
        if (!valid) {
          recordFailure(rateLimitKey)
          return null
        }

        // Successful auth — clear failure counter
        resetLimit(rateLimitKey)
        return { id: user.id, name: user.name, email: user.email, role: user.role }
      },
    }),
  ],
  session: {
    strategy: 'jwt',
    maxAge: 8 * 60 * 60, // 8 hours
  },
  callbacks: {
    async jwt({ token, user }) {
      if (user) {
        token.role = (user as { role?: string }).role ?? ''
      }
      return token
    },
    async session({ session, token }) {
      if (session.user) {
        session.user.role = token.role as string
        // Expose user ID (from JWT sub) so API routes can capture it in audit logs
        session.user.id = token.sub ?? (token.id as string | undefined)
      }
      return session
    },
  },
  pages: {
    signIn: '/login',
  },
  secret: process.env.NEXTAUTH_SECRET,
}
