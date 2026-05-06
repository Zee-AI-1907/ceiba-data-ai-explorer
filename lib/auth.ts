import type { NextAuthOptions } from 'next-auth'
import CredentialsProvider from 'next-auth/providers/credentials'
import bcrypt from 'bcryptjs'

const USERS = [
  {
    id: '1',
    name: 'Dr. Afsin Alp',
    email: 'afsin@ceiba.com',
    role: 'admin',
    password: bcrypt.hashSync('ceiba2026', 10),
  },
  {
    id: '2',
    name: 'Ege Apak',
    email: 'ege@ceiba.com',
    role: 'analyst',
    password: bcrypt.hashSync('ceiba2026', 10),
  },
  {
    id: '3',
    name: 'Clinical Lead',
    email: 'clinical@ceiba.com',
    role: 'clinician',
    password: bcrypt.hashSync('ceiba2026', 10),
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
      async authorize(credentials) {
        if (!credentials?.email || !credentials?.password) return null

        const user = USERS.find((u) => u.email === credentials.email)
        if (!user) return null

        const valid = await bcrypt.compare(credentials.password, user.password)
        if (!valid) return null

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
        (session.user as { role?: string }).role = token.role as string
      }
      return session
    },
  },
  pages: {
    signIn: '/login',
  },
  secret: process.env.NEXTAUTH_SECRET,
}
