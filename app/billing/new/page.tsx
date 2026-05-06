'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import Link from 'next/link'
import { ArrowLeft, Building2, CreditCard, ExternalLink, CheckCircle2 } from 'lucide-react'
import DataNav from '@/components/DataNav'
import { PRICING_TIERS } from '@/lib/stripe'
import type { PricingTier } from '@/lib/stripe'

type BillingCycle = 'monthly' | 'annual'

const TIERS = Object.entries(PRICING_TIERS) as [PricingTier, (typeof PRICING_TIERS)[PricingTier]][]

function formatMoney(amount: number) {
  return amount.toLocaleString('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 })
}

export default function NewCustomerPage() {
  const router = useRouter()

  const [hospitalName, setHospitalName]   = useState('')
  const [contactEmail, setContactEmail]   = useState('')
  const [tier, setTier]                   = useState<PricingTier>('starter')
  const [billingCycle, setBillingCycle]   = useState<BillingCycle>('annual')
  const [notes, setNotes]                 = useState('')
  const [submitting, setSubmitting]       = useState(false)
  const [error, setError]                 = useState<string | null>(null)
  const [created, setCreated]             = useState(false)

  const selectedTier = PRICING_TIERS[tier]
  const isCustom = selectedTier.annualPrice === 0 && selectedTier.monthlyPrice === 0
  const monthlyDisplay  = isCustom ? 'Custom' : formatMoney(selectedTier.monthlyPrice) + '/mo'
  const annualDisplay   = isCustom ? 'Custom' : formatMoney(selectedTier.annualPrice) + '/yr'
  const annualSaving    = isCustom ? null : selectedTier.monthlyPrice * 12 - selectedTier.annualPrice
  const selectedPrice   = billingCycle === 'annual' ? annualDisplay : monthlyDisplay

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    setSubmitting(true)
    setError(null)
    try {
      const res = await fetch('/api/billing/licenses', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ hospitalName, contactEmail, tier, billingCycle, notes }),
      })
      if (!res.ok) {
        const body = await res.json()
        throw new Error(body.error ?? 'Failed to create license')
      }
      setCreated(true)
    } catch (e) {
      setError(String(e))
    } finally {
      setSubmitting(false)
    }
  }

  if (created) {
    return (
      <div className="flex flex-col min-h-screen bg-[#0d0d10]">
        <DataNav activePage="audit" isAdmin />
        <div className="flex-1 flex items-center justify-center p-6">
          <div className="max-w-md w-full bg-[#16161a] border border-[#2a2a31] rounded-2xl p-8 text-center">
            <div className="w-14 h-14 rounded-2xl bg-[#4dcc8815] border border-[#4dcc8830] flex items-center justify-center mx-auto mb-5">
              <CheckCircle2 size={28} className="text-[#4dcc88]" />
            </div>
            <h2 className="text-xl font-bold text-[#e8e8ea] mb-2">Customer Created</h2>
            <p className="text-[#6c6c74] text-sm mb-6">
              License record created for <strong className="text-[#a0a0a7]">{hospitalName}</strong>.
            </p>

            {/* Next steps */}
            <div className="bg-[#0d0d10] border border-[#2a2a31] rounded-xl p-4 text-left mb-6">
              <p className="text-[12px] font-semibold text-[#7c68ff] mb-3 uppercase tracking-wider">Next Steps</p>
              <ol className="text-[13px] text-[#a0a0a7] space-y-2 list-decimal list-inside">
                <li>Open Stripe Dashboard and create a customer for <strong className="text-[#e8e8ea]">{contactEmail}</strong></li>
                <li>Create a subscription for the <strong className="text-[#e8e8ea]">{PRICING_TIERS[tier].name}</strong> plan</li>
                <li>Send a payment link or invoice to the customer</li>
                <li>Update the license record with the Stripe customer ID via the API</li>
              </ol>
            </div>

            <div className="flex flex-col gap-2">
              <a
                href="https://dashboard.stripe.com/customers/create"
                target="_blank"
                rel="noopener noreferrer"
                className="flex items-center justify-center gap-2 w-full py-2.5 px-4 rounded-xl bg-[#7c68ff] hover:bg-[#6955e8] text-white text-sm font-semibold transition-colors"
              >
                <ExternalLink size={14} />
                Open Stripe Dashboard
              </a>
              <Link
                href="/billing"
                className="flex items-center justify-center gap-2 w-full py-2.5 px-4 rounded-xl bg-[#16161a] border border-[#2a2a31] hover:border-[#3a3a45] text-[#a0a0a7] hover:text-[#e8e8ea] text-sm transition-all"
              >
                ← Back to Billing Dashboard
              </Link>
            </div>
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className="flex flex-col min-h-screen bg-[#0d0d10]">
      <DataNav activePage="audit" isAdmin />

      <div className="flex-1 p-6 max-w-2xl mx-auto w-full">
        {/* Back link */}
        <Link href="/billing" className="inline-flex items-center gap-1.5 text-[12px] text-[#6c6c74] hover:text-[#a0a0a7] mb-5 transition-colors">
          <ArrowLeft size={12} />
          Back to Billing
        </Link>

        <div className="bg-[#16161a] border border-[#2a2a31] rounded-2xl p-7">
          {/* Header */}
          <div className="flex items-center gap-3 mb-6">
            <div className="w-9 h-9 rounded-xl bg-[#7c68ff15] border border-[#7c68ff30] flex items-center justify-center">
              <Building2 size={16} className="text-[#7c68ff]" />
            </div>
            <div>
              <h1 className="text-[16px] font-bold text-[#e8e8ea]">Add New Customer</h1>
              <p className="text-[12px] text-[#6c6c74]">Onboard a new paying hospital or health system</p>
            </div>
          </div>

          <form onSubmit={handleSubmit} className="space-y-5">

            {/* Hospital name */}
            <div>
              <label className="block text-[12px] font-medium text-[#a0a0a7] mb-1.5">
                Hospital / Health System Name <span className="text-[#ff5c6c]">*</span>
              </label>
              <input
                type="text"
                required
                value={hospitalName}
                onChange={(e) => setHospitalName(e.target.value)}
                placeholder="e.g. Mercy General Hospital"
                className="w-full bg-[#0d0d10] border border-[#2a2a31] rounded-xl px-4 py-2.5 text-[13px] text-[#e8e8ea] placeholder-[#44444b] focus:outline-none focus:border-[#7c68ff] transition-colors"
              />
            </div>

            {/* Contact email */}
            <div>
              <label className="block text-[12px] font-medium text-[#a0a0a7] mb-1.5">
                Contact Email <span className="text-[#ff5c6c]">*</span>
              </label>
              <input
                type="email"
                required
                value={contactEmail}
                onChange={(e) => setContactEmail(e.target.value)}
                placeholder="billing@hospital.com"
                className="w-full bg-[#0d0d10] border border-[#2a2a31] rounded-xl px-4 py-2.5 text-[13px] text-[#e8e8ea] placeholder-[#44444b] focus:outline-none focus:border-[#7c68ff] transition-colors"
              />
            </div>

            {/* Pricing tier */}
            <div>
              <label className="block text-[12px] font-medium text-[#a0a0a7] mb-1.5">
                Pricing Tier <span className="text-[#ff5c6c]">*</span>
              </label>
              <div className="grid grid-cols-2 gap-2">
                {TIERS.map(([key, t]) => {
                  const isCustomTier = t.annualPrice === 0 && t.monthlyPrice === 0
                  return (
                    <button
                      key={key}
                      type="button"
                      onClick={() => setTier(key)}
                      className={`p-3 rounded-xl border text-left transition-all ${
                        tier === key
                          ? 'border-[#7c68ff] bg-[#7c68ff10]'
                          : 'border-[#2a2a31] bg-[#0d0d10] hover:border-[#3a3a45]'
                      }`}
                    >
                      <p className={`text-[13px] font-semibold ${tier === key ? 'text-[#7c68ff]' : 'text-[#e8e8ea]'}`}>
                        {t.name}
                      </p>
                      <p className="text-[11px] text-[#6c6c74]">{t.beds} beds</p>
                      <p className="text-[11px] text-[#a0a0a7] mt-1">
                        {isCustomTier ? 'Custom pricing' : `${formatMoney(t.monthlyPrice)}/mo`}
                      </p>
                    </button>
                  )
                })}
              </div>
            </div>

            {/* Billing cycle */}
            <div>
              <label className="block text-[12px] font-medium text-[#a0a0a7] mb-1.5">
                Billing Cycle
              </label>
              <div className="grid grid-cols-2 gap-2">
                {(['monthly', 'annual'] as BillingCycle[]).map((cycle) => {
                  const isAnnual = cycle === 'annual'
                  const price = isAnnual ? annualDisplay : monthlyDisplay
                  return (
                    <button
                      key={cycle}
                      type="button"
                      onClick={() => setBillingCycle(cycle)}
                      className={`p-3 rounded-xl border text-left transition-all ${
                        billingCycle === cycle
                          ? 'border-[#7c68ff] bg-[#7c68ff10]'
                          : 'border-[#2a2a31] bg-[#0d0d10] hover:border-[#3a3a45]'
                      }`}
                    >
                      <p className={`text-[13px] font-semibold capitalize ${billingCycle === cycle ? 'text-[#7c68ff]' : 'text-[#e8e8ea]'}`}>
                        {cycle}
                      </p>
                      <p className="text-[12px] text-[#a0a0a7]">{price}</p>
                      {isAnnual && annualSaving && annualSaving > 0 && (
                        <p className="text-[10px] text-[#4dcc88] mt-0.5">
                          Save {formatMoney(annualSaving)} (2 months free)
                        </p>
                      )}
                    </button>
                  )
                })}
              </div>
              {!isCustom && (
                <p className="text-[11px] text-[#44444b] mt-2">
                  Selected: <span className="text-[#a0a0a7]">{selectedPrice}</span>
                </p>
              )}
            </div>

            {/* Notes */}
            <div>
              <label className="block text-[12px] font-medium text-[#a0a0a7] mb-1.5">
                Notes <span className="text-[#44444b]">(optional)</span>
              </label>
              <textarea
                rows={3}
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
                placeholder="Any internal notes about this customer..."
                className="w-full bg-[#0d0d10] border border-[#2a2a31] rounded-xl px-4 py-2.5 text-[13px] text-[#e8e8ea] placeholder-[#44444b] focus:outline-none focus:border-[#7c68ff] transition-colors resize-none"
              />
            </div>

            {/* Error */}
            {error && (
              <div className="bg-[#ff5c6c10] border border-[#ff5c6c30] rounded-xl p-3 text-[#ff5c6c] text-[13px]">
                {error}
              </div>
            )}

            {/* Submit */}
            <button
              type="submit"
              disabled={submitting}
              className="flex items-center justify-center gap-2 w-full py-3 rounded-xl bg-[#7c68ff] hover:bg-[#6955e8] disabled:opacity-50 text-white font-semibold text-[13px] transition-colors"
            >
              <CreditCard size={14} />
              {submitting ? 'Creating...' : 'Create Customer License'}
            </button>
          </form>
        </div>
      </div>
    </div>
  )
}
