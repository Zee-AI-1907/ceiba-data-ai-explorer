import { NextRequest, NextResponse } from 'next/server'
import { getToken } from 'next-auth/jwt'
import { getLicenses, createLicense } from '@/lib/licenseStore'
import type { BillingCycle, LicenseStatus } from '@/lib/licenseStore'
import type { PricingTier } from '@/lib/stripe'

async function requireAdmin(req: NextRequest) {
  const token = await getToken({ req, secret: process.env.NEXTAUTH_SECRET })
  if (!token) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  if ((token as { role?: string }).role !== 'admin') {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }
  return null
}

export async function GET(req: NextRequest) {
  const denied = await requireAdmin(req)
  if (denied) return denied
  return NextResponse.json(getLicenses())
}

export async function POST(req: NextRequest) {
  const denied = await requireAdmin(req)
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
