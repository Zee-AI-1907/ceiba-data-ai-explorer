import Stripe from 'stripe'

export const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!, {
  apiVersion: '2026-04-22.dahlia',
})

// Pricing tier definitions matching the business model
export const PRICING_TIERS = {
  starter:    { name: 'Starter',       beds: '<200',      annualPrice: 30000,  monthlyPrice: 2750 },
  growth:     { name: 'Growth',        beds: '200–500',   annualPrice: 60000,  monthlyPrice: 5500 },
  enterprise: { name: 'Enterprise',    beds: '500–1,000', annualPrice: 96000,  monthlyPrice: 8800 },
  system:     { name: 'Health System', beds: '1,000+',    annualPrice: 0,      monthlyPrice: 0   }, // custom
} as const

export type PricingTier = keyof typeof PRICING_TIERS
