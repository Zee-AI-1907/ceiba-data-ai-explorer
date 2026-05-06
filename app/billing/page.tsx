'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'
import { ExternalLink, Plus, RefreshCw, CreditCard, Building2, TrendingUp, AlertCircle } from 'lucide-react'
import { clsx } from 'clsx'
import DataNav from '@/components/DataNav'
import type { CustomerLicense } from '@/lib/licenseStore'
import { PRICING_TIERS } from '@/lib/stripe'
import type { PricingTier } from '@/lib/stripe'

// ─── Helpers ─────────────────────────────────────────────────────────────────

const STATUS_STYLES: Record<string, { label: string; classes: string }> = {
  active:       { label: 'Active',       classes: 'bg-[#4dcc8820] text-[#4dcc88] border-[#4dcc8840]' },
  trial:        { label: 'Trial',        classes: 'bg-[#7c68ff20] text-[#7c68ff] border-[#7c68ff40]' },
  grace_period: { label: 'Grace Period', classes: 'bg-[#f59e0b20] text-[#f59e0b] border-[#f59e0b40]' },
  suspended:    { label: 'Suspended',    classes: 'bg-[#ff5c6c20] text-[#ff5c6c] border-[#ff5c6c40]' },
  cancelled:    { label: 'Cancelled',    classes: 'bg-[#44444b20] text-[#6c6c74] border-[#44444b40]' },
}

const TIER_STYLES: Record<string, string> = {
  starter:    'bg-[#4c8dff20] text-[#4c8dff] border-[#4c8dff40]',
  growth:     'bg-[#7c68ff20] text-[#7c68ff] border-[#7c68ff40]',
  enterprise: 'bg-[#4dcc8820] text-[#4dcc88] border-[#4dcc8840]',
  system:     'bg-[#f59e0b20] text-[#f59e0b] border-[#f59e0b40]',
}

function formatMoney(cents: number) {
  return (cents / 100).toLocaleString('en-US', { style: 'currency', currency: 'USD' })
}

function monthlyRevenue(licenses: CustomerLicense[]) {
  return licenses
    .filter((l) => l.status === 'active' || l.status === 'grace_period')
    .reduce((sum, l) => {
      const tier = PRICING_TIERS[l.tier as PricingTier]
      return sum + (l.billingCycle === 'monthly' ? tier.monthlyPrice : tier.annualPrice / 12)
    }, 0)
}

function annualContractValue(licenses: CustomerLicense[]) {
  return licenses
    .filter((l) => l.status === 'active' || l.status === 'grace_period')
    .reduce((sum, l) => {
      const tier = PRICING_TIERS[l.tier as PricingTier]
      return sum + (l.billingCycle === 'annual' ? tier.annualPrice : tier.monthlyPrice * 12)
    }, 0)
}

// ─── Page ─────────────────────────────────────────────────────────────────────

export default function BillingDashboard() {
  const [licenses, setLicenses] = useState<CustomerLicense[]>([])
  const [loading, setLoading]   = useState(true)
  const [error, setError]       = useState<string | null>(null)

  async function load() {
    setLoading(true)
    setError(null)
    try {
      const res = await fetch('/api/billing/licenses')
      if (!res.ok) throw new Error(await res.text())
      setLicenses(await res.json())
    } catch (e) {
      setError(String(e))
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { load() }, [])

  const active    = licenses.filter((l) => l.status === 'active').length
  const suspended = licenses.filter((l) => l.status === 'suspended').length
  const mrr       = monthlyRevenue(licenses)
  const acv       = annualContractValue(licenses)

  return (
    <div className="flex flex-col min-h-screen bg-[#0d0d10]">
      <DataNav activePage="audit" isAdmin />

      <div className="flex-1 p-6 max-w-7xl mx-auto w-full">

        {/* Header */}
        <div className="flex items-center justify-between mb-6">
          <div>
            <h1 className="text-xl font-bold text-[#e8e8ea] flex items-center gap-2">
              <CreditCard size={20} className="text-[#7c68ff]" />
              Billing Dashboard
            </h1>
            <p className="text-[13px] text-[#6c6c74] mt-0.5">Manage customer licenses and subscriptions</p>
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={load}
              className="flex items-center gap-1.5 h-8 px-3 rounded-[8px] bg-[#16161a] border border-[#2a2a31] text-[12px] text-[#a0a0a7] hover:text-[#e8e8ea] hover:border-[#3a3a45] transition-all"
            >
              <RefreshCw size={12} />
              Refresh
            </button>
            <a
              href="https://dashboard.stripe.com"
              target="_blank"
              rel="noopener noreferrer"
              className="flex items-center gap-1.5 h-8 px-3 rounded-[8px] bg-[#16161a] border border-[#2a2a31] text-[12px] text-[#a0a0a7] hover:text-[#e8e8ea] hover:border-[#3a3a45] transition-all"
            >
              <ExternalLink size={12} />
              Stripe Dashboard
            </a>
            <Link
              href="/billing/new"
              className="flex items-center gap-1.5 h-8 px-3 rounded-[8px] bg-[#7c68ff] hover:bg-[#6955e8] text-white text-[12px] font-semibold transition-colors"
            >
              <Plus size={12} />
              Add Customer
            </Link>
          </div>
        </div>

        {/* Summary cards */}
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-4 mb-6">
          {[
            { label: 'Total Active',           value: active,           icon: Building2,  color: '#4dcc88' },
            { label: 'Monthly Recurring',      value: formatMoney(mrr * 100), icon: TrendingUp, color: '#7c68ff' },
            { label: 'Annual Contract Value',  value: formatMoney(acv * 100), icon: CreditCard, color: '#4c8dff' },
            { label: 'Suspended Accounts',     value: suspended,        icon: AlertCircle, color: '#ff5c6c' },
          ].map(({ label, value, icon: Icon, color }) => (
            <div key={label} className="bg-[#16161a] border border-[#2a2a31] rounded-xl p-4">
              <div className="flex items-center gap-2 mb-2">
                <Icon size={14} style={{ color }} />
                <span className="text-[11px] text-[#6c6c74] uppercase tracking-wider">{label}</span>
              </div>
              <p className="text-xl font-bold text-[#e8e8ea]">{value}</p>
            </div>
          ))}
        </div>

        {/* Error */}
        {error && (
          <div className="bg-[#ff5c6c10] border border-[#ff5c6c30] rounded-xl p-4 mb-6 text-[#ff5c6c] text-sm">
            {error}
          </div>
        )}

        {/* Table */}
        <div className="bg-[#16161a] border border-[#2a2a31] rounded-xl overflow-hidden">
          <div className="px-5 py-3.5 border-b border-[#2a2a31] flex items-center justify-between">
            <span className="text-[13px] font-semibold text-[#e8e8ea]">Customer Licenses</span>
            <span className="text-[11px] text-[#44444b]">{licenses.length} total</span>
          </div>

          {loading ? (
            <div className="flex items-center justify-center py-12">
              <RefreshCw size={20} className="text-[#44444b] animate-spin" />
            </div>
          ) : licenses.length === 0 ? (
            <div className="py-12 text-center text-[#44444b] text-sm">No licenses found</div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-[13px]">
                <thead>
                  <tr className="border-b border-[#1f1f25]">
                    {['Hospital', 'Tier', 'Billing', 'Status', 'Period End', 'Amount'].map((h) => (
                      <th key={h} className="px-5 py-3 text-left text-[11px] text-[#44444b] uppercase tracking-wider font-medium">
                        {h}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {licenses.map((l) => {
                    const statusStyle = STATUS_STYLES[l.status] ?? { label: l.status, classes: '' }
                    return (
                      <tr key={l.id} className="border-b border-[#1f1f25] hover:bg-[#1f1f2580] transition-colors">
                        <td className="px-5 py-3.5">
                          <div>
                            <p className="text-[#e8e8ea] font-medium">{l.hospitalName}</p>
                            <p className="text-[11px] text-[#44444b]">{l.contactEmail}</p>
                          </div>
                        </td>
                        <td className="px-5 py-3.5">
                          <span className={clsx(
                            'inline-flex items-center px-2 py-0.5 rounded-full text-[11px] font-medium border',
                            TIER_STYLES[l.tier] ?? ''
                          )}>
                            {PRICING_TIERS[l.tier as PricingTier]?.name ?? l.tier}
                          </span>
                        </td>
                        <td className="px-5 py-3.5 text-[#a0a0a7] capitalize">{l.billingCycle}</td>
                        <td className="px-5 py-3.5">
                          <span className={clsx(
                            'inline-flex items-center px-2 py-0.5 rounded-full text-[11px] font-medium border',
                            statusStyle.classes
                          )}>
                            {statusStyle.label}
                          </span>
                        </td>
                        <td className="px-5 py-3.5 text-[#6c6c74]">
                          {l.currentPeriodEnd
                            ? new Date(l.currentPeriodEnd).toLocaleDateString()
                            : '—'}
                        </td>
                        <td className="px-5 py-3.5 text-[#a0a0a7]">
                          {l.amountDue != null ? formatMoney(l.amountDue) : '—'}
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
