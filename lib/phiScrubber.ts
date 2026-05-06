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
  // Extended PHI column names (HIPAA compliance — do not remove)
  'patientfirstname',
  'patientlastname',
  'patient_name',
  'fullname',
  'full_name',
  'birthdate',
  'birth_date',
  'nationalid',
  'national_id',
  'tc_kimlik',
  'tckimlik',
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

// Turkish National ID pattern: 11 digits, first digit non-zero
const TURKISH_ID_PATTERN = /^[1-9]\d{10}$/

function anonymiseValue(
  key: string,
  value: unknown,
  tokenMap: TokenMap
): string {
  if (value === null || value === undefined) return '[REDACTED]'

  // Normalise key the same way isPhiColumn does, for consistent matching
  const k = key.toLowerCase().replace(/[-\s]/g, '_')

  // Patient ID — numeric or alphanumeric; use full hex hash to avoid collisions
  if (k === 'patientid' || k === 'patient_id' || k === 'mrn') {
    if (tokenMap.has(value)) return tokenMap.get(value) as string
    const token = `PT-${Math.abs(hashCode(String(value))).toString(16).toUpperCase().padStart(8, '0')}`
    tokenMap.set(value, token)
    return token
  }

  // SSN
  if (k === 'ssn') return '[SSN REDACTED]'

  // National / Turkish identity numbers
  if (k === 'nationalid' || k === 'national_id' || k === 'tc_kimlik' || k === 'tckimlik') {
    return '[NATIONAL ID REDACTED]'
  }

  // Dates / DOB
  if (k === 'dob' || k === 'dateofbirth' || k === 'birthdate' || k === 'birth_date') {
    return '[DATE REDACTED]'
  }

  // Names (extended set)
  if (
    k === 'firstname' ||
    k === 'lastname' ||
    k === 'patient_first_name' ||
    k === 'patient_last_name' ||
    k === 'name' ||
    k === 'patientfirstname' ||
    k === 'patientlastname' ||
    k === 'patient_name' ||
    k === 'fullname' ||
    k === 'full_name'
  ) {
    if (tokenMap.has(value)) return tokenMap.get(value) as string
    const token = `Patient-${nextLetter()}`
    tokenMap.set(value, token)
    return token
  }

  // Turkish ID pattern detection on any PHI column value
  if (typeof value === 'string' && TURKISH_ID_PATTERN.test(value.trim())) {
    return '[NATIONAL ID REDACTED]'
  }
  if (typeof value === 'number' && TURKISH_ID_PATTERN.test(String(value))) {
    return '[NATIONAL ID REDACTED]'
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

    // Scrub known PHI columns
    for (const key of phiKeys) {
      if (key in scrubbed) {
        scrubbed[key] = anonymiseValue(key, scrubbed[key], tokenMap)
        phiValuesReplaced++
      }
    }

    // Second pass: scan ALL column values for Turkish National ID pattern
    // regardless of column name, to catch unlabelled identity numbers
    for (const key of Object.keys(scrubbed)) {
      if (phiKeys.includes(key)) continue // already handled above
      const val = scrubbed[key]
      const strVal = typeof val === 'number' ? String(val) : (typeof val === 'string' ? val.trim() : null)
      if (strVal && TURKISH_ID_PATTERN.test(strVal)) {
        scrubbed[key] = '[NATIONAL ID REDACTED]'
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
