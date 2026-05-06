import { NextRequest, NextResponse } from 'next/server'
import { sqlCache, hashKey } from '@/lib/cache'
import { getRelevantSchema } from '@/lib/schemaInjector'
import { requireAuth } from '@/lib/apiAuth'

function buildSystemPrompt(schema: string): string {
  return `You are a clinical SQL expert for Ceiba Health. Generate PostgreSQL queries for healthcare databases.

Available tables (use "Shared" schema):
${schema}

Rules:
- ONLY generate clinical/healthcare SQL. If the request is not clinical, return: {"error": "scope"}
- Return ONLY valid JSON: {"sql": "...", "description": "one line what this query does"}
- Use double quotes for identifiers. Add LIMIT 1000 unless aggregating.
- Prefer readable aliases.`
}

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

  const { userMessage, schemaHint } = await req.json()

  // Check cache first — same question = zero LLM tokens
  const cacheKey = hashKey(userMessage)
  const cached = sqlCache.get(cacheKey)
  if (cached) {
    return NextResponse.json({ sql: cached.sql, description: cached.description, cached: true })
  }

  // Smart schema injection — only include relevant tables (~65% token reduction)
  const relevantSchema = getRelevantSchema(userMessage)

  const userPrompt = schemaHint
    ? `Schema hint: ${schemaHint}\n\nUser request: "${userMessage}"`
    : `User request: "${userMessage}"`

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
          { role: 'system', content: buildSystemPrompt(relevantSchema) },
          { role: 'user', content: userPrompt },
        ],
        max_tokens: 400,
        temperature: 0.1,
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

    // Out-of-scope: LLM returned {"error": "scope"}
    if (parsed.error === 'scope') {
      return NextResponse.json({ scopeError: true }, { status: 422 })
    }

    // Cache the result for 30 minutes
    sqlCache.set(cacheKey, { sql: parsed.sql, description: parsed.description }, 30 * 60 * 1000)

    return NextResponse.json({ sql: parsed.sql, description: parsed.description, cached: false })
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 500 })
  }
}
