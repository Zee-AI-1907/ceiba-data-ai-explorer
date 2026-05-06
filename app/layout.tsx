import type { Metadata } from 'next'
import { Inter } from 'next/font/google'
import '../styles/globals.css'
import { ClerkProvider } from '@clerk/nextjs'
import { ErrorBoundary } from '@/components/ErrorBoundary'
import MobileNav from '@/components/MobileNav'
import CookieConsent from '@/components/CookieConsent'
import RetentionEnforcer from '@/components/RetentionEnforcer'

// G-006: Self-hosted via next/font/google (downloaded at build time, served from
// same origin — no Google IP leakage at runtime).
const inter = Inter({
  subsets: ['latin'],
  weight: ['300', '400', '500', '600', '700'],
  display: 'swap',
})

export const metadata: Metadata = {
  title: 'Ceiba Data AI Explorer',
  description: 'Mission Control — Data AI Explorer',
}

export default function RootLayout({
  children,
}: {
  children: React.ReactNode
}) {
  return (
    <ClerkProvider>
      <html lang="en">
        <body className={`${inter.className} bg-[#0b0b0c] text-[#e8e8ea] antialiased`}>
          {/* G-003: enforce retention on every page load */}
          <RetentionEnforcer />
          <ErrorBoundary>
            {children}
          </ErrorBoundary>
          <MobileNav />
          <CookieConsent />
        </body>
      </html>
    </ClerkProvider>
  )
}
