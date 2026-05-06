import { NextRequest, NextResponse } from 'next/server'

const SYSTEM_PROMPT = `You are a clinical data assistant for Ceiba Health. You help clinicians understand their healthcare data, interpret results, and make data-driven decisions.

You can help with:
- Interpreting query results and clinical metrics
- Explaining trends in patient data
- Suggesting follow-up analyses
- Answering questions about clinical KPIs (LOS, readmission rates, occupancy, etc.)

Keep responses concise and clinically relevant. If asked something outside healthcare/clinical data, politely redirect.

Format responses clearly — use bullet points for lists, be direct.`

export async function POST(req: NextRequest) {
  const apiKey = process.env.OPENAI_API_KEY
  if (!apiKey) return NextResponse.json({ error: 'No API key' }, { status: 500 })

  const { message, context } = await req.json()

  // context = optional summary of current query results to give LLM awareness
  const userContent = context
    ? `Current query results context: ${context}\n\nUser question: ${message}`
    : message

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
          { role: 'system', content: SYSTEM_PROMPT },
          { role: 'user', content: userContent },
        ],
        max_tokens: 300,
        temperature: 0.4,
        stream: false,
      }),
    })

    if (!response.ok) {
      const err = await response.text()
      return NextResponse.json({ error: err }, { status: 502 })
    }

    const data = await response.json()
    const reply = data.choices?.[0]?.message?.content ?? 'I could not generate a response.'
    return NextResponse.json({ reply })
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 500 })
  }
}
