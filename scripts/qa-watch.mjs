#!/usr/bin/env node
// Continuous QA watcher — run: npm run qa:watch [interval_minutes]
import { execSync } from 'child_process'
import { dirname, join } from 'path'
import { fileURLToPath } from 'url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const INTERVAL = parseInt(process.argv[2] || '10', 10) * 60 * 1000
const AGENT = join(__dirname, 'qa-agent.mjs')

let run = 0, streak = 0

function tick() {
  run++
  console.log(`\n[${new Date().toLocaleTimeString()}] QA Run #${run}`)
  try {
    execSync(`node "${AGENT}"`, { stdio: 'inherit' })
    streak = 0
  } catch {
    streak++
    if (streak >= 3) console.error(`\n🚨 ${streak} consecutive QA failures! Check the app.`)
  }
}

console.log(`🤖 QA Watch — every ${INTERVAL/60000}min. Ctrl+C to stop.`)
tick()
setInterval(tick, INTERVAL)
