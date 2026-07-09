#!/usr/bin/env node
// gen-phi-columns.mjs — NL2SQL P0 PHI bridge (SPEC §2.5).
//
// Generates config/phi_columns.json from the AUTHORITATIVE PHI column set in
// lib/phiScrubber.ts (PHI_COLUMNS + normalizeKey). The Python prep toolchain and
// the CI PHI gate consume this JSON so they reuse the EXACT same set as the TS
// runtime — a drift between the two fails the build (see the bridge/drift tests).
//
// Output shape:
//   { "phiColumns": [...sorted normalized...],
//     "phiColumnsetHash": "<sha256 of sorted normalized joined by comma>" }
//
// Deterministic + idempotent: running twice produces a byte-identical file.
//
// Run:  npm run phi:sync
// (npm script invokes this via `node --experimental-strip-types` so the .ts source
//  can be imported directly without adding a TS loader dependency.)

import { createHash } from 'node:crypto'
import { writeFileSync, readFileSync, existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const scriptDir = dirname(fileURLToPath(import.meta.url))
const repoRoot = join(scriptDir, '..')
const phiScrubberPath = join(repoRoot, 'lib', 'phiScrubber.ts')
const outputPath = join(repoRoot, 'config', 'phi_columns.json')

// Import the authoritative set + normalizer directly from the TS source. Node's
// --experimental-strip-types removes the type annotations at load time.
const { PHI_COLUMNS, normalizeKey } = await import(pathToFileURL(phiScrubberPath).href)

if (!(PHI_COLUMNS instanceof Set) || typeof normalizeKey !== 'function') {
  console.error('gen-phi-columns: PHI_COLUMNS / normalizeKey not exported from lib/phiScrubber.ts')
  process.exit(1)
}

// Normalize every entry (idempotent for already-normalized keys), dedupe, sort.
const normalizedSorted = Array.from(
  new Set(Array.from(PHI_COLUMNS, (key) => normalizeKey(String(key))))
).toSorted()

const phiColumnsetHash = createHash('sha256')
  .update(normalizedSorted.join(','))
  .digest('hex')

const payload = { phiColumns: normalizedSorted, phiColumnsetHash }
const serialized = JSON.stringify(payload, null, 2) + '\n'

const alreadyCurrent =
  existsSync(outputPath) && readFileSync(outputPath, 'utf8') === serialized

writeFileSync(outputPath, serialized)

console.error(
  `gen-phi-columns: wrote ${outputPath}\n` +
    `  columns: ${normalizedSorted.length}\n` +
    `  phiColumnsetHash: ${phiColumnsetHash}\n` +
    `  ${alreadyCurrent ? '(idempotent — file unchanged)' : '(file updated)'}`
)
