/**
 * phiScrubber.ts — PHI field anonymisation before sending data to LLMs.
 * SERVER-SIDE ONLY. Do not import in client components.
 */

// ── PHI column key set (lowercase, normalised) ────────────────────────────────

const PHI_COLUMNS = new Set([
  'patientid',
  'patient_id',
  'firstname',
  'lastname',
  'patient_first_name',
  'patient_last_name',
  'name',
  'ssn',
  'mrn',
  'dob',
  'dateofbirth',
  'phone',
  'email',
  'address',
])

function isPhiColumn(key: string): boolean {
  return PHI_COLUMNS.has(key.toLowerCase().replace(/[-\s]/g, '_'))
}

// ── Token generators ──────────────────────────────────────────────────────────

// Maps original values → stable tokens within a scrub run so the same
// patient always gets the same anonymised token in a single response.
type TokenMap = Map<unknown, string>

let _letterIndex = 0
const LETTERS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'

function nextLetter(): string {
  const ch = LETTERS[_letterIndex % LETTERS.length]
  _letterIndex++
  return ch
}

function anonymiseValue(
  key: string,
  value: unknown,
  tokenMap: TokenMap
): string {
  if (value === null || value === undefined) return '[REDACTED]'

  const k = key.toLowerCase()

  // Patient ID — numeric or alphanumeric
  if (k === 'patientid' || k === 'patient_id' || k === 'mrn') {
    if (tokenMap.has(value)) return tokenMap.get(value) as string
    const token = `PT-${String(Math.abs(hashCode(String(value)))).padStart(5, '0').slice(0, 5)}`
    tokenMap.set(value, token)
    return token
  }

  // SSN
  if (k === 'ssn') return '[SSN REDACTED]'

  // Dates / DOB
  if (k === 'dob' || k === 'dateofbirth') return '[DATE REDACTED]'

  // Names
  if (
    k === 'firstname' ||
    k === 'lastname' ||
    k === 'patient_first_name' ||
    k === 'patient_last_name' ||
    k === 'name'
  ) {
    if (tokenMap.has(value)) return tokenMap.get(value) as string
    const token = `Patient-${nextLetter()}`
    tokenMap.set(value, token)
    return token
  }

  // Everything else (phone, email, address)
  return '[PHI REDACTED]'
}

function hashCode(s: string): number {
  let h = 0
  for (let i = 0; i < s.length; i++) {
    h = (Math.imul(31, h) + s.charCodeAt(i)) | 0
  }
  return h
}

// ── Public API ─────────────────────────────────────────────────────────────────

export type ScrubReport = {
  columnsScrubed: string[]
  rowsProcessed: number
  phiValuesReplaced: number
}

export type ScrubResult = {
  scrubbedRows: Record<string, unknown>[]
  scrubReport: ScrubReport
}

export function scrubPHI(
  rows: Record<string, unknown>[],
  columns: { key: string; label: string }[]
): ScrubResult {
  // Reset per-run letter index so tokens are deterministic within a call
  _letterIndex = 0
  const tokenMap: TokenMap = new Map()

  const phiKeys = columns.map((c) => c.key).filter(isPhiColumn)
  let phiValuesReplaced = 0

  const scrubbedRows = rows.map((row) => {
    const scrubbed: Record<string, unknown> = { ...row }
    for (const key of phiKeys) {
      if (key in scrubbed) {
        scrubbed[key] = anonymiseValue(key, scrubbed[key], tokenMap)
        phiValuesReplaced++
      }
    }
    return scrubbed
  })

  return {
    scrubbedRows,
    scrubReport: {
      columnsScrubed: phiKeys,
      rowsProcessed: rows.length,
      phiValuesReplaced,
    },
  }
}
