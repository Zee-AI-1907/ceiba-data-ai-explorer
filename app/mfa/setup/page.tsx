'use client'

import { useState, useEffect } from 'react'
import { useRouter } from 'next/navigation'
import { useSession } from 'next-auth/react'
import Link from 'next/link'
import { ShieldCheck, Loader2, QrCode, Copy, CheckCircle2 } from 'lucide-react'

const DEMO_SECRET = process.env.NEXT_PUBLIC_MFA_TOTP_SECRET ?? 'WHRTRD3ORPCZ7WO2YYZ6TPLAPLS3R3LL'

function formatSecret(secret: string): string {
  return secret.replace(/(.{4})/g, '$1 ').trim()
}

export default function MFASetupPage() {
  const router = useRouter()
  const { data: session } = useSession()
  const [qrDataUrl, setQrDataUrl] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [copied, setCopied] = useState(false)

  const email = session?.user?.email ?? 'user@ceiba.com'
  const secret = DEMO_SECRET
  const otpAuthUrl = `otpauth://totp/CeibaHealth:${encodeURIComponent(email)}?secret=${secret}&issuer=CeibaHealth`

  useEffect(() => {
    async function generateQR() {
      try {
        const QRCode = (await import('qrcode')).default
        const dataUrl = await QRCode.toDataURL(otpAuthUrl, {
          width: 220,
          margin: 2,
          color: { dark: '#e8e8ea', light: '#111114' },
        })
        setQrDataUrl(dataUrl)
      } catch (err) {
        console.error('QR generation failed', err)
      } finally {
        setLoading(false)
      }
    }
    generateQR()
  }, [otpAuthUrl])

  async function handleCopy() {
    try {
      await navigator.clipboard.writeText(secret)
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    } catch {
      // ignore
    }
  }

  return (
    <div className="min-h-screen bg-[#0d0d10] flex items-center justify-center px-4">
      <div className="w-full max-w-[420px]">
        {/* Logo + heading */}
        <div className="flex flex-col items-center mb-8">
          <div className="w-12 h-12 rounded-[12px] bg-gradient-to-br from-[#7c68ff] to-[#4c8dff] flex items-center justify-center mb-4 shadow-lg shadow-[#7c68ff30]">
            <span className="text-[16px] font-black text-white tracking-tighter">CH</span>
          </div>
          <h1 className="text-[22px] font-bold text-[#e8e8ea] tracking-tight">Set Up Two-Factor Auth</h1>
          <p className="text-[13px] text-[#6c6c74] mt-1">Link your authenticator app to your account</p>
        </div>

        {/* Card */}
        <div className="bg-[#111114] border border-[#2a2a31] rounded-[16px] p-6 shadow-2xl flex flex-col gap-5">
          {/* Step 1 */}
          <div>
            <p className="text-[12px] font-semibold text-[#7c68ff] uppercase tracking-widest mb-2">Step 1</p>
            <p className="text-[13px] text-[#a0a0a7] leading-relaxed">
              Install an authenticator app such as{' '}
              <span className="text-[#e8e8ea]">Google Authenticator</span> or{' '}
              <span className="text-[#e8e8ea]">Authy</span> on your phone.
            </p>
          </div>

          {/* Step 2 */}
          <div>
            <p className="text-[12px] font-semibold text-[#7c68ff] uppercase tracking-widest mb-2">Step 2</p>
            <p className="text-[13px] text-[#a0a0a7] mb-4">Scan the QR code with your authenticator app.</p>

            {/* QR Code */}
            <div className="flex items-center justify-center p-4 rounded-[12px] bg-[#111114] border border-[#2a2a31]">
              {loading ? (
                <div className="w-[220px] h-[220px] flex items-center justify-center">
                  <Loader2 size={32} className="animate-spin text-[#7c68ff]" />
                </div>
              ) : qrDataUrl ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={qrDataUrl} alt="TOTP QR Code" width={220} height={220} className="rounded-[8px]" />
              ) : (
                <div className="w-[220px] h-[220px] flex flex-col items-center justify-center gap-2 text-[#44444b]">
                  <QrCode size={40} />
                  <p className="text-[12px]">QR generation failed</p>
                </div>
              )}
            </div>
          </div>

          {/* Step 3 — manual entry */}
          <div>
            <p className="text-[12px] font-semibold text-[#7c68ff] uppercase tracking-widest mb-2">
              Can&apos;t scan? Enter manually
            </p>
            <div className="flex items-center gap-2 p-3 rounded-[10px] bg-[#16161a] border border-[#2a2a31]">
              <code className="flex-1 text-[13px] text-[#e8e8ea] font-mono tracking-widest select-all break-all">
                {formatSecret(secret)}
              </code>
              <button
                onClick={handleCopy}
                className="flex-shrink-0 p-1.5 rounded-[6px] hover:bg-[#2a2a31] transition-colors text-[#6c6c74] hover:text-[#a0a0a7]"
                title="Copy secret"
              >
                {copied ? <CheckCircle2 size={16} className="text-[#4dcc88]" /> : <Copy size={16} />}
              </button>
            </div>
            <p className="text-[11px] text-[#44444b] mt-1.5">Account: CeibaHealth — {email}</p>
          </div>

          {/* CTA */}
          <button
            onClick={() => router.push('/mfa')}
            className="w-full min-h-[44px] rounded-[10px] bg-[#7c68ff] hover:bg-[#8f7dff] text-white text-[13px] font-semibold transition-all flex items-center justify-center gap-2 shadow-md shadow-[#7c68ff30] mt-1"
          >
            I&apos;ve scanned the QR code →
          </button>
        </div>

        {/* Back link */}
        <div className="mt-4 flex items-center justify-center">
          <Link href="/login" className="text-[12px] text-[#44444b] hover:text-[#6c6c74] transition-colors">
            ← Back to login
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
