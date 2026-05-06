#!/usr/bin/env node
// QA Fix Agent — reads latest failure report and suggests fixes via OpenAI
// Run: npm run qa:fix
import { readFileSync, readdirSync, existsSync } from 'fs'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const REPORT_DIR = join(__dirname, '../.qa-reports')
const KEY = process.env.OPENAI_API_KEY

if (!KEY) { console.error('OPENAI_API_KEY not set'); process.exit(1) }
if (!existsSync(REPORT_DIR)) { console.log('No reports yet. Run: npm run qa'); process.exit(0) }

const files = readdirSync(REPORT_DIR).filter(f => f.endsWith('.json')).sort().reverse()
if (!files.length) { console.log('No reports found.'); process.exit(0) }

const report = JSON.parse(readFileSync(join(REPORT_DIR, files[0]), 'utf-8'))
const failures = report.results.filter(r => r.status === 'fail')

if (!failures.length) { console.log('✅ No failures in latest report!'); process.exit(0) }

console.log(`\n🔧 Analyzing ${failures.length} failure(s) from ${report.runAt}\n`)

const summary = failures.map(f => `- "${f.name}": ${f.error}`).join('\n')

const res = await fetch('https://api.openai.com/v1/chat/completions', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${KEY}` },
  body: JSON.stringify({
    model: 'gpt-4o-mini',
    messages: [
      { role: 'system', content: 'You are a senior engineer reviewing QA failures for a Next.js clinical data app (Ceiba Data AI Explorer) with routes: /api/chat, /api/sql-generate, /api/chart-suggest, /api/query (Trino), /api/dashboards, /api/cache-stats. Be concise and actionable.' },
      { role: 'user', content: `QA failures:\n${summary}\n\nFor each: 1) root cause 2) exact fix (file + change).` }
    ],
    max_tokens: 600, temperature: 0.2,
  })
})

const data = await res.json()
console.log('💡 Suggested fixes:\n')
console.log(data.choices?.[0]?.message?.content || 'No suggestions.')
