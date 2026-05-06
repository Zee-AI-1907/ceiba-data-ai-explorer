import fs from 'fs'
import path from 'path'
import { randomUUID } from 'crypto'
import type { PricingTier } from './stripe'

// ─── Types ────────────────────────────────────────────────────────────────────

export type BillingCycle   = 'monthly' | 'annual'
export type LicenseStatus  = 'active' | 'grace_period' | 'suspended' | 'cancelled' | 'trial'

export type CustomerLicense = {
  id: string                   // internal ID
  hospitalName: string
  contactEmail: string
  tier: PricingTier
  billingCycle: BillingCycle
  status: LicenseStatus
  stripeCustomerId?: string
  stripeSubscriptionId?: string
  stripeInvoiceId?: string
  currentPeriodStart?: string  // ISO date
  currentPeriodEnd?: string    // ISO date
  gracePeriodEnd?: string      // ISO date (7 days after payment failure)
  amountDue?: number           // cents
  createdAt: string
  updatedAt: string
  suspendedAt?: string
  suspensionReason?: string
  notes?: string
}

// ─── File path ────────────────────────────────────────────────────────────────

const DATA_DIR      = path.join(process.cwd(), 'data')
const LICENSES_FILE = path.join(DATA_DIR, 'licenses.json')

function ensureDataDir() {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true })
  }
}

// ─── Read / Write ─────────────────────────────────────────────────────────────

function readAll(): CustomerLicense[] {
  ensureDataDir()
  if (!fs.existsSync(LICENSES_FILE)) return []
  try {
    return JSON.parse(fs.readFileSync(LICENSES_FILE, 'utf-8')) as CustomerLicense[]
  } catch {
    return []
  }
}

function writeAll(licenses: CustomerLicense[]) {
  ensureDataDir()
  fs.writeFileSync(LICENSES_FILE, JSON.stringify(licenses, null, 2), 'utf-8')
}

// ─── Public API ───────────────────────────────────────────────────────────────

export function getLicenses(): CustomerLicense[] {
  return readAll()
}

export function getLicense(id: string): CustomerLicense | null {
  return readAll().find((l) => l.id === id) ?? null
}

export function getLicenseByStripeCustomer(stripeCustomerId: string): CustomerLicense | null {
  return readAll().find((l) => l.stripeCustomerId === stripeCustomerId) ?? null
}

export function createLicense(
  data: Omit<CustomerLicense, 'id' | 'createdAt' | 'updatedAt'>
): CustomerLicense {
  const licenses = readAll()
  const now = new Date().toISOString()
  const license: CustomerLicense = {
    ...data,
    id: randomUUID(),
    createdAt: now,
    updatedAt: now,
  }
  licenses.push(license)
  writeAll(licenses)
  return license
}

export function updateLicense(id: string, updates: Partial<CustomerLicense>): CustomerLicense {
  const licenses = readAll()
  const idx = licenses.findIndex((l) => l.id === id)
  if (idx === -1) throw new Error(`License ${id} not found`)
  const updated: CustomerLicense = {
    ...licenses[idx],
    ...updates,
    id,
    updatedAt: new Date().toISOString(),
  }
  licenses[idx] = updated
  writeAll(licenses)
  return updated
}

/**
 * Returns true if the license allows access:
 *  - status === 'active'
 *  - status === 'trial'
 *  - status === 'grace_period' AND gracePeriodEnd is still in the future
 */
export function isLicenseActive(license: CustomerLicense): boolean {
  if (license.status === 'active' || license.status === 'trial') return true
  if (license.status === 'grace_period' && license.gracePeriodEnd) {
    return new Date(license.gracePeriodEnd) > new Date()
  }
  return false
}
