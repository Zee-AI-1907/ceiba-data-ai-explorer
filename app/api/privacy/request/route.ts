import { NextRequest, NextResponse } from 'next/server'
import { randomUUID } from 'crypto'
import fs from 'fs'
import path from 'path'

const VALID_TYPES = ['access', 'correct', 'delete', 'export', 'object'] as const
type RequestType = (typeof VALID_TYPES)[number]

function isValidType(t: unknown): t is RequestType {
  return typeof t === 'string' && (VALID_TYPES as readonly string[]).includes(t)
}

function isValidEmail(email: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)
}

export async function POST(req: NextRequest) {
  let body: unknown
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
  }

  const { name, email, type, description } = body as Record<string, unknown>

  // Validate required fields
  if (!name || typeof name !== 'string' || name.trim().length === 0) {
    return NextResponse.json({ error: 'Name is required' }, { status: 400 })
  }

  if (!email || typeof email !== 'string' || !isValidEmail(email.trim())) {
    return NextResponse.json({ error: 'A valid email address is required' }, { status: 400 })
  }

  if (!isValidType(type)) {
    return NextResponse.json(
      { error: `Request type must be one of: ${VALID_TYPES.join(', ')}` },
      { status: 400 }
    )
  }

  const referenceId = randomUUID()
  const timestamp = new Date().toISOString()

  const logEntry = {
    referenceId,
    timestamp,
    type,
    name: name.trim(),
    email: email.trim().toLowerCase(),
    description: typeof description === 'string' ? description.trim() : '',
    ipAddress:
      req.headers.get('x-forwarded-for') ??
      req.headers.get('x-real-ip') ??
      'unknown',
  }

  // Write to logs/privacy-requests.log (JSON lines)
  try {
    const logDir = path.join(process.cwd(), 'logs')
    if (!fs.existsSync(logDir)) {
      fs.mkdirSync(logDir, { recursive: true })
    }
    const logPath = path.join(logDir, 'privacy-requests.log')
    fs.appendFileSync(logPath, JSON.stringify(logEntry) + '\n', 'utf8')
  } catch (err) {
    // Log write failure is non-fatal for the response, but we still want it noted
    console.error('[privacy/request] Failed to write log entry:', err)
  }

  return NextResponse.json({ success: true, referenceId }, { status: 200 })
}
