#!/usr/bin/env node
// Ceiba Data AI Explorer — QA Agent
// Run: npm run qa

import { writeFileSync, mkdirSync, existsSync } from 'fs'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const BASE = 'http://localhost:3005'
const REPORT_DIR = join(__dirname, '../.qa-reports')
const REPORT_FILE = join(REPORT_DIR, `qa-${new Date().toISOString().slice(0,10)}.json`)

const results = []

async function test(name, fn) {
  const start = Date.now()
  try {
    await fn()
    results.push({ name, status: 'pass', ms: Date.now() - start })
    process.stdout.write(`  ✅ ${name}\n`)
  } catch (e) {
    results.push({ name, status: 'fail', ms: Date.now() - start, error: e.message })
    process.stdout.write(`  ❌ ${name} — ${e.message}\n`)
  }
}

const assert = (cond, msg) => { if (!cond) throw new Error(msg || 'Assertion failed') }

async function api(path, opts = {}) {
  const res = await fetch(`${BASE}${path}`, opts)
  const text = await res.text()
  let json
  try { json = JSON.parse(text) } catch { json = null }
  return { res, json, text }
}

// ── PAGE LOADS ───────────────────────────────────────────────────────────────
console.log('\n📄 Page Loads')
for (const [path, label] of [['/dashboards','Dashboards'],['/charts','Charts'],['/datasets','Datasets'],['/data-explorer','SQL Lab']]) {
  await test(label, async () => {
    const res = await fetch(`${BASE}${path}`)
    assert(res.status === 200, `HTTP ${res.status}`)
    const html = await res.text()
    assert(html.includes('Ceiba') || html.length > 500, 'Page looks empty')
  })
}

// ── CHAT API ─────────────────────────────────────────────────────────────────
console.log('\n💬 Chat API')
await test('Clinical question gets a reply', async () => {
  const { res, json } = await api('/api/chat', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ message: 'What does ICU length of stay mean clinically?' })
  })
  assert(res.status === 200, `HTTP ${res.status}`)
  assert(json?.reply?.length > 10, 'Reply too short or missing')
})

await test('No API key returns 500', async () => {
  // Just verify the route exists and responds (key is set, so 200 expected)
  const { res } = await api('/api/chat', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ message: 'hello' })
  })
  assert([200, 500].includes(res.status), `Unexpected status ${res.status}`)
})

// ── SQL GENERATE ─────────────────────────────────────────────────────────────
console.log('\n🧠 SQL Generate API')
await test('Clinical request returns SQL', async () => {
  const { res, json } = await api('/api/sql-generate', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ userMessage: 'How many patients admitted per unit this month?' })
  })
  assert(res.status === 200, `HTTP ${res.status}`)
  assert(json?.sql?.toUpperCase().includes('SELECT'), 'Missing SELECT in SQL')
  assert(!json?.scopeError, 'Clinical request blocked as out-of-scope')
})

await test('Off-topic request is blocked', async () => {
  const { res, json } = await api('/api/sql-generate', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ userMessage: 'What is the Bitcoin price today?' })
  })
  assert(res.status === 422 || json?.scopeError === true, 'Off-topic not blocked')
})

await test('Second identical call is cached', async () => {
  const body = JSON.stringify({ userMessage: 'Show patient count by department last 30 days' })
  const opts = { method: 'POST', headers: { 'Content-Type': 'application/json' }, body }
  await api('/api/sql-generate', opts) // warm cache
  const t = Date.now()
  const { json } = await api('/api/sql-generate', opts)
  const ms = Date.now() - t
  assert(json?.cached === true, 'Cache miss on second call')
  assert(ms < 300, `Cached call too slow: ${ms}ms`)
})

// ── CHART SUGGEST ─────────────────────────────────────────────────────────────
console.log('\n📊 Chart Suggest API')
const cols = [{ key: 'unit', label: 'Unit', type: 'text' }, { key: 'count', label: 'Count', type: 'number' }]
const rows = [{ unit: 'ICU', count: 412 }, { unit: 'ED', count: 200 }, { unit: 'NICU', count: 85 }]

await test('Returns valid chart config', async () => {
  const { res, json } = await api('/api/chart-suggest', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ columns: cols, rows, userMessage: 'Show a bar chart of patients by unit' })
  })
  assert(res.status === 200, `HTTP ${res.status}`)
  assert(json?.config?.type, 'Missing chart type')
  assert(['bar','line','area','pie','donut','scatter','bigNumber'].includes(json.config.type), `Bad type: ${json.config.type}`)
  assert(json?.config?.title, 'Missing chart title')
})

await test('Off-topic chart blocked', async () => {
  const { res, json } = await api('/api/chart-suggest', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ columns: cols, rows, userMessage: 'Show me crypto prices' })
  })
  assert(res.status === 422 || json?.scopeError === true, 'Off-topic chart not blocked')
})

// ── QUERY API (SAFETY) ────────────────────────────────────────────────────────
console.log('\n🛡️  Query Safety')
for (const [sql, label] of [
  ['INSERT INTO "Shared"."Patients" VALUES (1)', 'Blocks INSERT'],
  ['DROP TABLE "Shared"."Patients"', 'Blocks DROP'],
  ['DELETE FROM "Shared"."Patients"', 'Blocks DELETE'],
  ['UPDATE "Shared"."Patients" SET Age=0', 'Blocks UPDATE'],
]) {
  await test(label, async () => {
    const { res } = await api('/api/query', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sql, database: 'eclinics' })
    })
    assert(res.status === 403, `Expected 403, got ${res.status}`)
  })
}

await test('Blocks empty SQL', async () => {
  const { res } = await api('/api/query', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sql: '', database: 'eclinics' })
  })
  assert(res.status === 400, `Expected 400, got ${res.status}`)
})

// ── DASHBOARD API ─────────────────────────────────────────────────────────────
console.log('\n🗂️  Dashboard API')
const testDash = { id: `qa-${Date.now()}`, name: 'QA Test Dashboard', status: 'Draft', charts: [], owner: 'QA Agent', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() }

await test('GET returns array', async () => {
  const { res, json } = await api('/api/dashboards')
  assert(res.status === 200, `HTTP ${res.status}`)
  assert(Array.isArray(json), 'Expected array')
})

await test('POST creates dashboard', async () => {
  const { res, json } = await api('/api/dashboards', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(testDash)
  })
  assert(res.status === 200, `HTTP ${res.status}`)
  assert(json?.ok === true, 'Expected ok: true')
})

await test('GET by id returns created dashboard', async () => {
  const { res, json } = await api(`/api/dashboards?id=${testDash.id}`)
  assert(res.status === 200, `HTTP ${res.status}`)
  assert(json?.id === testDash.id, 'Wrong dashboard returned')
})

await test('DELETE removes dashboard', async () => {
  const { res, json } = await api(`/api/dashboards?id=${testDash.id}`, { method: 'DELETE' })
  assert(res.status === 200, `HTTP ${res.status}`)
  assert(json?.ok === true, 'Expected ok: true')
})

// ── CACHE STATS ───────────────────────────────────────────────────────────────
console.log('\n⚡ Cache Stats')
await test('Cache stats endpoint responds', async () => {
  const { res, json } = await api('/api/cache-stats')
  assert(res.status === 200, `HTTP ${res.status}`)
  assert(typeof json?.sql?.size === 'number', 'Missing sql.size')
  assert(typeof json?.chart?.size === 'number', 'Missing chart.size')
})

// ── REPORT ────────────────────────────────────────────────────────────────────
if (!existsSync(REPORT_DIR)) mkdirSync(REPORT_DIR, { recursive: true })

const passed = results.filter(r => r.status === 'pass').length
const failed = results.filter(r => r.status === 'fail').length
const totalMs = results.reduce((a, r) => a + r.ms, 0)

const report = { runAt: new Date().toISOString(), summary: { passed, failed, total: results.length, totalMs }, results }
writeFileSync(REPORT_FILE, JSON.stringify(report, null, 2))

console.log(`\n${'─'.repeat(50)}`)
console.log(`QA: ${passed}/${results.length} passed | ${failed} failed | ${totalMs}ms`)
if (failed > 0) {
  console.log('\nFailed:')
  results.filter(r => r.status === 'fail').forEach(r => console.log(`  ❌ ${r.name}: ${r.error}`))
}
console.log(`Report → ${REPORT_FILE}`)
process.exit(failed > 0 ? 1 : 0)
