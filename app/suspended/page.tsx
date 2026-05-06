'use client'

import { useSearchParams } from 'next/navigation'
import { Suspense } from 'react'
import { AlertTriangle, CreditCard, Mail } from 'lucide-react'

function SuspendedContent() {
  const params = useSearchParams()
  const amountParam = params.get('amount')
  const isGrace     = params.get('grace') === '1'
  const daysLeft    = params.get('days')

  const amountDollars = amountParam
    ? (parseInt(amountParam, 10) / 100).toLocaleString('en-US', {
        style: 'currency',
        currency: 'USD',
      })
    : null

  return (
    <div className="min-h-screen bg-[#0d0d10] flex items-center justify-center p-6">
      <div className="max-w-lg w-full">
        {/* Warning card */}
        <div className="bg-[#16161a] border border-[#2a2a31] rounded-2xl p-8 shadow-2xl text-center">

          {/* Icon */}
          <div className="flex items-center justify-center mb-6">
            <div className="w-16 h-16 rounded-2xl bg-[#ff5c6c15] border border-[#ff5c6c30] flex items-center justify-center">
              <AlertTriangle size={32} className="text-[#ff5c6c]" />
            </div>
          </div>

          {/* Heading */}
          <h1 className="text-2xl font-bold text-[#e8e8ea] mb-2">
            {isGrace ? 'Payment Past Due' : 'Account Suspended — Payment Required'}
          </h1>
          <p className="text-[#6c6c74] text-sm leading-relaxed mb-6">
            Your Ceiba Data AI Explorer subscription has been suspended due to a failed payment.
            Please update your payment method to restore access.
          </p>

          {/* Grace period notice */}
          {isGrace && daysLeft && (
            <div className="bg-[#f59e0b10] border border-[#f59e0b30] rounded-xl p-4 mb-6">
              <p className="text-[#f59e0b] text-sm font-medium">
                ⚠️ You have <strong>{daysLeft} day{parseInt(daysLeft) !== 1 ? 's' : ''}</strong> remaining
                in your grace period. Update your payment method before it expires to avoid suspension.
              </p>
            </div>
          )}

          {/* Amount due */}
          {amountDollars && (
            <div className="bg-[#ff5c6c08] border border-[#ff5c6c20] rounded-xl p-4 mb-6">
              <p className="text-[#a0a0a7] text-xs uppercase tracking-widest mb-1">Amount Due</p>
              <p className="text-3xl font-bold text-[#ff5c6c]">{amountDollars}</p>
            </div>
          )}

          {/* CTA buttons */}
          <div className="flex flex-col gap-3">
            <a
              href="https://billing.stripe.com/p/login/test_placeholder"
              target="_blank"
              rel="noopener noreferrer"
              className="flex items-center justify-center gap-2 w-full py-3 px-4 rounded-xl bg-[#7c68ff] hover:bg-[#6955e8] text-white font-semibold text-sm transition-colors"
            >
              <CreditCard size={16} />
              Update Payment Method
            </a>

            <a
              href="mailto:billing@ceiba-healthcare.com"
              className="flex items-center justify-center gap-2 w-full py-3 px-4 rounded-xl bg-[#16161a] border border-[#2a2a31] hover:border-[#3a3a45] text-[#a0a0a7] hover:text-[#e8e8ea] font-medium text-sm transition-all"
            >
              <Mail size={16} />
              Contact Support
            </a>
          </div>

          {/* Footer */}
          <p className="mt-6 text-[11px] text-[#44444b]">
            Questions? Email{' '}
            <a href="mailto:billing@ceiba-healthcare.com" className="text-[#7c68ff] hover:underline">
              billing@ceiba-healthcare.com
            </a>
          </p>
        </div>

        {/* Ceiba branding */}
        <div className="flex items-center justify-center gap-2 mt-6">
          <div className="w-4 h-4 rounded-[4px] bg-gradient-to-br from-[#7c68ff] to-[#4c8dff] flex items-center justify-center">
            <span className="text-[6px] font-black text-white">CH</span>
          </div>
          <span className="text-[11px] text-[#44444b]">Ceiba Data AI Explorer</span>
        </div>
      </div>
    </div>
  )
}

export default function SuspendedPage() {
  return (
    <Suspense>
      <SuspendedContent />
    </Suspense>
  )
}
