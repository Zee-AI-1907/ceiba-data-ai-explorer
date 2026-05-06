import { NextRequest, NextResponse } from 'next/server'
import { logAuditEvent } from '@/lib/auditLog'
import { scrubPHI } from '@/lib/phiScrubber'

const NARRATIVE_SYSTEM_PROMPT = `You are a clinical data analyst. Given a dataset and the user's original question, write a concise 2-4 sentence plain-English narrative summary.
Highlight the top finding, any notable outliers, and one actionable insight.
Be specific with numbers. Use clinical language appropriate for physicians.
Do not use markdown. Write in prose, not bullets.
If the data contains date or time columns, calculate and mention simple trends such as "Up 23% vs last week" or "Highest in the past 30 days" when the data supports it.

After the narrative, also provide:
- highlights: an array of 2-4 short key finding strings (each under 60 chars, plain text, no markdown)
- anomalies: an array of 0-3 short anomaly strings if any outliers or unusual patterns exist (empty array if none)

Respond ONLY with valid JSON in this exact shape:
{
  "narrative": "...",
  "highlights": ["...", "..."],
  "anomalies": ["..."]
}`

type Column = { key: string; label: string; type?: string }
type Row = Record<string, unknown>

interface NarrativeRequest {
  columns: Column[]
  rows: Row[]
  question?: string
}

export async function POST(req: NextRequest) {
  const apiKey = process.env.OPENAI_API_KEY
  if (!apiKey) return NextResponse.json({ error: 'No API key' }, { status: 500 })

  let body: NarrativeRequest
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
  }

  const { columns, rows, question } = body

  if (!columns || !rows || rows.length === 0) {
    return NextResponse.json({ error: 'No data provided' }, { status: 400 })
  }

  // Log narrative generation (WARNING — PHI data is being sent to external AI)
  logAuditEvent({
    action: 'NARRATIVE_GENERATED',
    resourceType: 'patient_data',
    detail: `Narrative requested for ${rows.length} rows, question: ${String(question ?? '').slice(0, 200)}`,
    rowsAffected: rows.length,
    severity: 'WARNING',
    userId: 'system',
    userEmail: 'system',
    ipAddress: req.headers.get('x-forwarded-for') ?? req.headers.get('x-real-ip') ?? undefined,
  })

  // Scrub PHI before sending to OpenAI
  const { scrubbedRows } = scrubPHI(rows, columns)

  // Build a concise data summary to send to the LLM (cap at 50 rows to control tokens)
  const sampleRows = scrubbedRows.slice(0, 50)
  const columnList = columns.map((c) => `${c.label}${c.type ? ` (${c.type})` : ''}`).join(', ')
  const rowSummary = JSON.stringify(sampleRows)

  const userContent = [
    question ? `User question: ${question}` : '',
    `Total rows: ${rows.length}`,
    `Columns: ${columnList}`,
    `Data (up to 50 rows): ${rowSummary}`,
  ]
    .filter(Boolean)
    .join('\n')

  try {
    const response = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: 'gpt-4o-mini',
        messages: [
          { role: 'system', content: NARRATIVE_SYSTEM_PROMPT },
          { role: 'user', content: userContent },
        ],
        max_tokens: 600,
        temperature: 0.3,
        response_format: { type: 'json_object' },
        stream: false,
      }),
    })

    if (!response.ok) {
      const err = await response.text()
      return NextResponse.json({ error: err }, { status: 502 })
    }

    const data = await response.json()
    const rawContent = data.choices?.[0]?.message?.content ?? '{}'

    let parsed: { narrative?: string; highlights?: string[]; anomalies?: string[] }
    try {
      parsed = JSON.parse(rawContent)
    } catch {
      return NextResponse.json({ error: 'Failed to parse AI response' }, { status: 500 })
    }

    return NextResponse.json({
      narrative: parsed.narrative ?? '',
      highlights: Array.isArray(parsed.highlights) ? parsed.highlights : [],
      anomalies: Array.isArray(parsed.anomalies) ? parsed.anomalies : [],
    })
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 500 })
  }
}
