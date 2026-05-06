import { NextRequest, NextResponse } from 'next/server'
import { executeTrinoQuery } from '@/lib/trinoClient'
import { logWithSession, logAuditEvent, getRecentAuditEvents } from '@/lib/auditLog'
import { detectAnomalies } from '@/lib/anomalyDetector'
import { requireAuth } from '@/lib/apiAuth'
import fs from 'fs'
import path from 'path'

const ANOMALY_LOG = path.join(process.cwd(), 'logs', 'anomalies.log')

function writeAnomalyLog(line: string): void {
  try {
    fs.appendFileSync(ANOMALY_LOG, line + '\n', 'utf8')
  } catch {
    // Never crash the request over a log write failure
  }
}

export async function POST(req: NextRequest) {
  const { error } = await requireAuth(req)
  if (error) return error

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

    // Write audit event (includes hash chaining)
    await logWithSession(req, {
      action: 'QUERY_RUN',
      resourceType: 'patient_data',
      detail: `SQL: ${sql.slice(0, 300)}`,
      rowsAffected: result.rowCount,
      severity: 'INFO',
    })

    // Anomaly detection — load recent events for context
    const recentEvents = getRecentAuditEvents(200)
    const latestEvent = recentEvents[0]
    if (latestEvent) {
      const flags = detectAnomalies(latestEvent, recentEvents.slice(1))
      if (flags.length > 0) {
        const anomalyLine = JSON.stringify({
          timestamp: new Date().toISOString(),
          eventId: latestEvent.id,
          userId: latestEvent.userId,
          flags,
        })
        writeAnomalyLog(anomalyLine)
        // Also audit the anomaly detection itself at WARNING severity
        logAuditEvent({
          userId: latestEvent.userId,
          userEmail: latestEvent.userEmail,
          action: 'QUERY_RUN',
          resourceType: 'query',
          detail: `ANOMALY DETECTED: ${flags.join(', ')} — SQL: ${sql.slice(0, 200)}`,
          severity: 'WARNING',
        })
      }
    }

    return NextResponse.json({
      columns,
      rows: result.rows,
      rowCount: result.rowCount,
    })
  } catch (e) {
    await logWithSession(req, {
      action: 'QUERY_FAILED',
      resourceType: 'query',
      detail: `SQL: ${sql?.slice(0, 300) ?? ''} — Error: ${String(e).slice(0, 200)}`,
      severity: 'WARNING',
    })
    return NextResponse.json({ error: String(e) }, { status: 500 })
  }
}
