import { NextRequest, NextResponse } from 'next/server'
import { chartCache, hashKey } from '@/lib/cache'
import { requireAuth } from '@/lib/apiAuth'

// ─── Token-optimized chart suggestion endpoint ───────────────────────────────
// Strategy:
//  • System prompt: ~80 tokens (strict JSON-only response)
//  • User message: column schema + max 15 sample rows in compact CSV (no JSON overhead)
//  • Model: gpt-4o-mini (cheap, fast, great at structured extraction)
//  • No conversation history — this is a pure one-shot inference call
//  • Cache: 60-minute TTL keyed on (userMessage, column keys)
// ─────────────────────────────────────────────────────────────────────────────

// ── Scope: only clinical / healthcare data analysis ─────────────────────────
const CLINICAL_SCOPE_PROMPT = `You are a clinical data visualization assistant for Ceiba Health.
Your SOLE purpose is analyzing and visualizing healthcare and clinical data.
Allowed topics: patient metrics, clinical KPIs, hospital operations, treatment outcomes, medical records, healthcare SQL query results, and any health-related analytics.

If the user request is NOT related to clinical or healthcare data analysis, return ONLY this JSON:
{"scopeError": true, "message": "I can only help with clinical and healthcare data analysis."}

Otherwise, return ONLY valid JSON chart config with NO explanation:
{
  "type": "bar"|"line"|"area"|"pie"|"donut"|"scatter"|"bigNumber",
  "title": string,
  "description": string (1 sentence),
  "xKey": string|null,
  "yKey": string|null,
  "categoryKey": string|null,
  "valueKey": string|null,
  "colorScheme": "blue"|"green"|"purple"|"orange"|"mixed"
}
Rules: pie/donut need valueKey+categoryKey. bigNumber needs one numeric column. bar/line/area need xKey+yKey.`

export async function POST(req: NextRequest) {
  const { error } = await requireAuth(req)
  if (error) return error

  const apiKey = process.env.OPENAI_API_KEY
  if (!apiKey) {
    return NextResponse.json(
      { error: 'OPENAI_API_KEY not set. Add it to .env.local' },
      { status: 500 }
    )
  }

  const { columns, rows, userMessage } = await req.json()

  // Check cache first — keyed on (userMessage + column keys)
  const cacheKey = hashKey(userMessage, columns.map((c: { key: string }) => c.key).join(','))
  const cached = chartCache.get(cacheKey)
  if (cached) {
    return NextResponse.json({ config: cached, cached: true })
  }

  // Build compact user message (tokens ≈ columns + 15 rows × avg 10 tokens)
  const colSummary = columns
    .map((c: { key: string; label: string; type?: string }) => `${c.label}(${c.type || 'text'})`)
    .join(', ')

  const sampleRows = rows
    .slice(0, 15)
    .map((r: Record<string, unknown>) =>
      columns.map((c: { key: string }) => r[c.key] ?? '').join(' | ')
    )
    .join('\n')

  const userPrompt = `Columns: ${colSummary}\nSample data:\n${sampleRows}\n\nUser request: "${userMessage}"`

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
          { role: 'system', content: CLINICAL_SCOPE_PROMPT },
          { role: 'user', content: userPrompt },
        ],
        max_tokens: 200,
        temperature: 0.2,
        response_format: { type: 'json_object' },
      }),
    })

    if (!response.ok) {
      const err = await response.text()
      return NextResponse.json({ error: `OpenAI error: ${err}` }, { status: 502 })
    }

    const data = await response.json()
    const content = data.choices?.[0]?.message?.content ?? '{}'
    const parsed = JSON.parse(content)

    // Layer 2: LLM flagged the request as out of clinical scope
    if (parsed.scopeError) {
      return NextResponse.json({ scopeError: true, message: parsed.message }, { status: 422 })
    }

    // Cache the result for 60 minutes
    chartCache.set(cacheKey, parsed, 60 * 60 * 1000)

    return NextResponse.json({ config: parsed, cached: false })
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 500 })
  }
}
