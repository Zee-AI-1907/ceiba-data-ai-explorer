import { NextRequest, NextResponse } from 'next/server'
import { auth } from '@clerk/nextjs/server'
import { getLicenses, createLicense } from '@/lib/licenseStore'
import type { BillingCycle, LicenseStatus } from '@/lib/licenseStore'
import type { PricingTier } from '@/lib/stripe'

async function requireAdmin() {
  const { userId, sessionClaims } = await auth()
  if (!userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const role = (sessionClaims?.publicMetadata as Record<string, string>)?.role
  if (role !== 'admin') {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }
  return null
}

export async function GET(req: NextRequest) {
  void req
  const denied = await requireAdmin()
  if (denied) return denied
  return NextResponse.json(getLicenses())
}

export async function POST(req: NextRequest) {
  const denied = await requireAdmin()
  if (denied) return denied

  const body = await req.json() as {
    hospitalName: string
    contactEmail: string
    tier: PricingTier
    billingCycle: BillingCycle
    status?: LicenseStatus
    notes?: string
  }

  if (!body.hospitalName || !body.contactEmail || !body.tier || !body.billingCycle) {
    return NextResponse.json({ error: 'Missing required fields' }, { status: 400 })
  }

  const license = createLicense({
    hospitalName: body.hospitalName,
    contactEmail: body.contactEmail,
    tier: body.tier,
    billingCycle: body.billingCycle,
    status: body.status ?? 'active',
    notes: body.notes,
  })
  return NextResponse.json(license, { status: 201 })
}
