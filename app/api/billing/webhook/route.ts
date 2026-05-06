import { NextRequest, NextResponse } from 'next/server'
import fs from 'fs'
import path from 'path'
import { stripe } from '@/lib/stripe'
import {
  getLicenseByStripeCustomer,
  createLicense,
  updateLicense,
} from '@/lib/licenseStore'
import type { BillingCycle } from '@/lib/licenseStore'
import type { PricingTier } from '@/lib/stripe'

// ─── Logging ──────────────────────────────────────────────────────────────────

const LOGS_DIR = path.join(process.cwd(), 'logs')
const LOG_FILE  = path.join(LOGS_DIR, 'billing-events.log')

function logEvent(level: 'INFO' | 'WARN' | 'CRITICAL', event: string, data?: unknown) {
  try {
    if (!fs.existsSync(LOGS_DIR)) fs.mkdirSync(LOGS_DIR, { recursive: true })
    const line = `[${new Date().toISOString()}] [${level}] ${event}${data ? ' ' + JSON.stringify(data) : ''}\n`
    fs.appendFileSync(LOG_FILE, line, 'utf-8')
    console.log(line.trim())
  } catch { /* non-fatal */ }
}

// ─── Webhook handler ──────────────────────────────────────────────────────────
// This route is called by Stripe — no auth middleware, only signature verification.

export async function POST(req: NextRequest) {
  const body = await req.text()
  const sig  = req.headers.get('stripe-signature') ?? ''

  let event
  try {
    event = stripe.webhooks.constructEvent(body, sig, process.env.STRIPE_WEBHOOK_SECRET!)
  } catch (err) {
    logEvent('WARN', 'webhook_signature_failed', { error: String(err) })
    return NextResponse.json({ error: 'Invalid signature' }, { status: 400 })
  }

  logEvent('INFO', `webhook_received: ${event.type}`, { id: event.id })

  try {
    switch (event.type) {

      // ── Payment succeeded ──────────────────────────────────────────────────
      case 'invoice.payment_succeeded': {
        const invoice = event.data.object as import('stripe').Stripe.Invoice
        const customerId = typeof invoice.customer === 'string' ? invoice.customer : invoice.customer?.id
        if (!customerId) break

        const license = getLicenseByStripeCustomer(customerId)
        if (!license) break

        updateLicense(license.id, {
          status: 'active',
          gracePeriodEnd: undefined,
          stripeInvoiceId: invoice.id,
          currentPeriodStart: invoice.period_start
            ? new Date(invoice.period_start * 1000).toISOString()
            : undefined,
          currentPeriodEnd: invoice.period_end
            ? new Date(invoice.period_end * 1000).toISOString()
            : undefined,
          amountDue: invoice.amount_paid ?? undefined,
        })
        logEvent('INFO', 'payment_succeeded', { licenseId: license.id, customerId })
        break
      }

      // ── Payment failed ─────────────────────────────────────────────────────
      case 'invoice.payment_failed':
      case 'invoice.payment_action_required': {
        const invoice = event.data.object as import('stripe').Stripe.Invoice
        const customerId = typeof invoice.customer === 'string' ? invoice.customer : invoice.customer?.id
        if (!customerId) break

        const license = getLicenseByStripeCustomer(customerId)
        if (!license) break

        const gracePeriodEnd = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString()
        updateLicense(license.id, {
          status: 'grace_period',
          gracePeriodEnd,
          amountDue: invoice.amount_due ?? undefined,
        })
        logEvent('CRITICAL', 'payment_failed_grace_period_started', {
          licenseId: license.id,
          customerId,
          gracePeriodEnd,
          amountDue: invoice.amount_due,
        })
        // In production: send email to license.contactEmail
        break
      }

      // ── Subscription deleted ───────────────────────────────────────────────
      case 'customer.subscription.deleted': {
        const sub = event.data.object as import('stripe').Stripe.Subscription
        const customerId = typeof sub.customer === 'string' ? sub.customer : sub.customer?.id
        if (!customerId) break

        const license = getLicenseByStripeCustomer(customerId)
        if (!license) break

        updateLicense(license.id, {
          status: 'suspended',
          suspendedAt: new Date().toISOString(),
          suspensionReason: 'Subscription deleted in Stripe',
        })
        logEvent('WARN', 'subscription_deleted_suspended', { licenseId: license.id, customerId })
        break
      }

      // ── Subscription updated ───────────────────────────────────────────────
      case 'customer.subscription.updated': {
        const sub = event.data.object as import('stripe').Stripe.Subscription
        const customerId = typeof sub.customer === 'string' ? sub.customer : sub.customer?.id
        if (!customerId) break

        const license = getLicenseByStripeCustomer(customerId)
        if (!license) break

        // Extract tier/cycle from metadata if present
        const meta = sub.metadata ?? {}
        const updates: Parameters<typeof updateLicense>[1] = {}
        if (meta.tier) updates.tier = meta.tier as PricingTier
        if (meta.billingCycle) updates.billingCycle = meta.billingCycle as BillingCycle
        if (Object.keys(updates).length > 0) {
          updateLicense(license.id, updates)
          logEvent('INFO', 'subscription_updated', { licenseId: license.id, ...updates })
        }
        break
      }

      // ── Checkout completed → create or activate license ────────────────────
      case 'checkout.session.completed': {
        const session = event.data.object as import('stripe').Stripe.Checkout.Session
        const customerId = typeof session.customer === 'string' ? session.customer : session.customer?.id
        if (!customerId) break

        const meta = session.metadata ?? {}
        const existing = getLicenseByStripeCustomer(customerId)

        if (existing) {
          updateLicense(existing.id, { status: 'active', stripeCustomerId: customerId })
          logEvent('INFO', 'checkout_activated_existing_license', { licenseId: existing.id })
        } else {
          const license = createLicense({
            hospitalName:    meta.hospitalName    ?? 'Unknown',
            contactEmail:    meta.contactEmail    ?? session.customer_email ?? '',
            tier:            (meta.tier as PricingTier) ?? 'starter',
            billingCycle:    (meta.billingCycle as BillingCycle) ?? 'monthly',
            status:          'active',
            stripeCustomerId: customerId,
            stripeSubscriptionId: typeof session.subscription === 'string'
              ? session.subscription
              : session.subscription?.id,
            notes: meta.notes,
          })
          logEvent('INFO', 'checkout_created_new_license', { licenseId: license.id, customerId })
        }
        break
      }

      default:
        logEvent('INFO', `webhook_unhandled: ${event.type}`)
    }
  } catch (err) {
    logEvent('CRITICAL', `webhook_processing_error: ${event.type}`, { error: String(err) })
    return NextResponse.json({ error: 'Processing error' }, { status: 500 })
  }

  return NextResponse.json({ received: true })
}
