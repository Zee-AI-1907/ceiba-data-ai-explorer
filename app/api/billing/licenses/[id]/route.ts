import { NextRequest, NextResponse } from 'next/server'
import { getToken } from 'next-auth/jwt'
import { getLicense, updateLicense } from '@/lib/licenseStore'

async function requireAdmin(req: NextRequest) {
  const token = await getToken({ req, secret: process.env.NEXTAUTH_SECRET })
  if (!token) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  if ((token as { role?: string }).role !== 'admin') {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }
  return null
}

export async function GET(
  req: NextRequest,
  { params }: { params: { id: string } }
) {
  const denied = await requireAdmin(req)
  if (denied) return denied

  const license = getLicense(params.id)
  if (!license) return NextResponse.json({ error: 'Not found' }, { status: 404 })
  return NextResponse.json(license)
}

export async function PATCH(
  req: NextRequest,
  { params }: { params: { id: string } }
) {
  const denied = await requireAdmin(req)
  if (denied) return denied

  const license = getLicense(params.id)
  if (!license) return NextResponse.json({ error: 'Not found' }, { status: 404 })

  const updates = await req.json()
  // Prevent id/createdAt from being overwritten
  delete updates.id
  delete updates.createdAt

  const updated = updateLicense(params.id, updates)
  return NextResponse.json(updated)
}
