import { NextRequest, NextResponse } from 'next/server'
import { executeTrinoQuery } from '@/lib/trinoClient'
import { logAuditEvent } from '@/lib/auditLog'

export async function POST(req: NextRequest) {
  const { sql, database, schema, limit } = await req.json()

  if (!sql?.trim()) {
    return NextResponse.json({ error: 'No SQL provided' }, { status: 400 })
  }

  // Safety: block any write operations
  const normalized = sql.trim().toUpperCase()
  const BLOCKED = ['INSERT', 'UPDATE', 'DELETE', 'DROP', 'CREATE', 'ALTER', 'TRUNCATE', 'GRANT', 'REVOKE']
  const firstWord = normalized.split(/\s+/)[0]
  if (BLOCKED.includes(firstWord)) {
    return NextResponse.json({ error: 'Write operations are not allowed. Read-only access only.' }, { status: 403 })
  }

  try {
    const catalog = (database === 'eclinics' ? 'eclinics' : 'telehealth') as 'telehealth' | 'eclinics'
    const result = await executeTrinoQuery(sql, catalog, schema || 'public', limit || 1000)

    const columns = result.columns.map(c => ({ key: c.name, label: c.name, type: c.type }))
    logAuditEvent({
      action: 'QUERY_RUN',
      resourceType: 'patient_data',
      detail: `SQL: ${sql.slice(0, 300)}`,
      rowsAffected: result.rowCount,
      severity: 'INFO',
      userId: 'system',
      userEmail: 'system',
      ipAddress: req.headers.get('x-forwarded-for') ?? req.headers.get('x-real-ip') ?? undefined,
    })
    return NextResponse.json({
      columns,
      rows: result.rows,
      rowCount: result.rowCount,
    })
  } catch (e) {
    logAuditEvent({
      action: 'QUERY_FAILED',
      resourceType: 'query',
      detail: `SQL: ${sql?.slice(0, 300) ?? ''} — Error: ${String(e).slice(0, 200)}`,
      severity: 'WARNING',
      userId: 'system',
      userEmail: 'system',
      ipAddress: req.headers.get('x-forwarded-for') ?? req.headers.get('x-real-ip') ?? undefined,
    })
    return NextResponse.json({ error: String(e) }, { status: 500 })
  }
}
