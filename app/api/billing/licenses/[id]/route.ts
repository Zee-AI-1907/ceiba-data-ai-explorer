import { NextRequest, NextResponse } from 'next/server'
import { auth } from '@clerk/nextjs/server'
import { getLicense, updateLicense } from '@/lib/licenseStore'

async function requireAdmin() {
  const { userId, sessionClaims } = await auth()
  if (!userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const role = (sessionClaims?.publicMetadata as Record<string, string>)?.role
  if (role !== 'admin') {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }
  return null
}

export async function GET(
  req: NextRequest,
  { params }: { params: { id: string } }
) {
  const denied = await requireAdmin()
  if (denied) return denied

  const license = getLicense(params.id)
  if (!license) return NextResponse.json({ error: 'Not found' }, { status: 404 })
  return NextResponse.json(license)
}

export async function PATCH(
  req: NextRequest,
  { params }: { params: { id: string } }
) {
  const denied = await requireAdmin()
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
