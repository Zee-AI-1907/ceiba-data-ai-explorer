/**
 * phiScrubber.ts — AI-egress safety for the clinical data explorer.
 * SERVER-SIDE ONLY. Do not import in client components.
 *
 * ── PRIMARY CONTROL: schema + aggregates only (H15 / B5 / N1) ─────────────────
 * The compliance boundary for AI egress is NOT this file's masking. Per
 * PRODUCTION_READINESS_REPORT.md H15/B5, row-level PHI must NEVER leave the trust
 * boundary to OpenAI while the BAA/residency questions are open. The routes send
 * only a COLUMN SCHEMA + AGGREGATE STATISTICS (counts, distinct-counts, numeric
 * min/max/mean, a few non-PHI categorical labels) — see `buildAggregateProfile`.
 * No raw cell value from a patient row is ever included in an aggregate profile.
 *
 * ── BAA / residency egress gate (B5 / N1) ─────────────────────────────────────
 * Even the aggregate profile is data DERIVED from patient rows. Until the OpenAI
 * BAA is signed AND the data-residency (KVKK cross-border) basis is resolved, the
 * routes must not send ANY patient-derived data off-region. `assertEgressAllowed`
 * reads `OPENAI_BAA_SIGNED` (default false) and reports whether row-derived data
 * may egress. When false, routes operate in a degraded, schema-only mode or reject.
 *
 * ── scrubPHI: best-effort masking, NOT a compliance boundary (H15) ────────────
 * `scrubPHI` remains as defense-in-depth for the narrow case where a small amount
 * of scrubbed context is genuinely needed. It is an allowlist + single-regex
 * masker: it CANNOT detect PHI embedded in free text (a name typed into a notes
 * field sails through). Do NOT treat a scrubPHI pass as "safe to send raw rows".
 * It is reentrant/pure (H21): no module-global mutable state.
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

function normalizeKey(key: string): string {
  return key.toLowerCase().replace(/[-\s]/g, '_')
}

// ── Additive named exports (NL2SQL P0 PHI bridge) ─────────────────────────────
// Re-export the authoritative PHI column set and its key-normalization helper so
// the prep toolchain / config bridge can reuse the SAME set (§2.5). These are the
// existing module-private `PHI_COLUMNS` and `normalizeKey` — same references, no
// behavioral change. Do NOT fork or redefine the set elsewhere; import from here.
export { PHI_COLUMNS, normalizeKey }

function isPhiColumn(key: string): boolean {
  return PHI_COLUMNS.has(normalizeKey(key))
}

// ── Token generators ──────────────────────────────────────────────────────────

// Maps original values → stable tokens within a scrub run so the same
// patient always gets the same anonymised token in a single response.
type TokenMap = Map<unknown, string>

const LETTERS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'

/**
 * A per-call anonymisation context. H21: previously `_letterIndex` was a
 * module-global that raced across concurrent requests. It is now local state
 * created fresh for each `scrubPHI` invocation, so the function is reentrant.
 */
interface ScrubContext {
  tokenMap: TokenMap
  letterIndex: number
}

function nextLetter(ctx: ScrubContext): string {
  const ch = LETTERS[ctx.letterIndex % LETTERS.length]
  ctx.letterIndex++
  return ch
}

// Turkish National ID pattern: 11 digits, first digit non-zero
const TURKISH_ID_PATTERN = /^[1-9]\d{10}$/

function anonymiseValue(key: string, value: unknown, ctx: ScrubContext): string {
  if (value === null || value === undefined) return '[REDACTED]'

  // Normalise key the same way isPhiColumn does, for consistent matching
  const k = normalizeKey(key)

  // Patient ID — numeric or alphanumeric; use full hex hash to avoid collisions
  if (k === 'patientid' || k === 'patient_id' || k === 'mrn') {
    if (ctx.tokenMap.has(value)) return ctx.tokenMap.get(value) as string
    const token = `PT-${Math.abs(hashCode(String(value))).toString(16).toUpperCase().padStart(8, '0')}`
    ctx.tokenMap.set(value, token)
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
    if (ctx.tokenMap.has(value)) return ctx.tokenMap.get(value) as string
    const token = `Patient-${nextLetter(ctx)}`
    ctx.tokenMap.set(value, token)
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

// ── Public API: scrubPHI (best-effort masking, NOT a compliance boundary) ──────

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
  // H21: per-call state — no shared module-global. Reentrant/pure across calls.
  const ctx: ScrubContext = { tokenMap: new Map(), letterIndex: 0 }

  const phiKeys = columns.map((c) => c.key).filter(isPhiColumn)
  let phiValuesReplaced = 0

  const scrubbedRows = rows.map((row) => {
    const scrubbed: Record<string, unknown> = { ...row }

    // Scrub known PHI columns
    for (const key of phiKeys) {
      if (key in scrubbed) {
        scrubbed[key] = anonymiseValue(key, scrubbed[key], ctx)
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

// ── BAA / residency egress gate (B5 / N1) ─────────────────────────────────────

export type EgressDecision = {
  /** True only when the BAA is signed AND residency is resolved. */
  allowed: boolean
  /** Machine-readable reason when not allowed. */
  reason: 'baa_not_signed' | null
  /** Human-safe message for a 422 SCOPE response / audit detail. */
  message: string
}

/**
 * Is sending patient-row-DERIVED data (aggregates, scrubbed context) to OpenAI
 * currently permitted? Controlled by `OPENAI_BAA_SIGNED` (default false).
 *
 * The env var is the operational assertion that BOTH (a) a signed OpenAI BAA and
 * (b) the KVKK cross-border/residency basis (N1) are in place. It is deliberately
 * a single hard gate: while false, NO data derived from patient rows egresses.
 * Static schema (table/column names — not patient data) may still be sent so the
 * routes can operate in a degraded, schema-only mode.
 */
export function isEgressAllowed(): boolean {
  return process.env.OPENAI_BAA_SIGNED === 'true'
}

/**
 * assertEgressAllowed — decision object for routes to branch on. Routes that need
 * to send ANY patient-derived data (aggregate profile, scrubbed context) must
 * check this and return 422 SCOPE (or degrade to schema-only) when not allowed.
 */
export function assertEgressAllowed(): EgressDecision {
  if (isEgressAllowed()) {
    return { allowed: true, reason: null, message: 'AI egress permitted (BAA + residency asserted).' }
  }
  return {
    allowed: false,
    reason: 'baa_not_signed',
    message:
      'AI features over patient data are disabled until the OpenAI BAA and data-residency (KVKK cross-border) basis are in place. Set OPENAI_BAA_SIGNED=true only after both are resolved.',
  }
}

// ── Aggregate profile builder — the PRIMARY egress payload (H15 / B5) ──────────

export type Column = { key: string; label: string; type?: string }

export type ColumnAggregate = {
  key: string
  label: string
  type: string
  /** How the value was classified for aggregation. */
  kind: 'numeric' | 'categorical' | 'phi-suppressed'
  /** Non-null value count for this column across the profiled rows. */
  nonNullCount: number
  /** Number of distinct values (cardinality). Never the values themselves for PHI. */
  distinctCount: number
  /** Numeric-only aggregates. */
  min?: number
  max?: number
  mean?: number
  /**
   * For NON-PHI, low-cardinality categorical columns only: up to 8 distinct
   * category LABELS (e.g. status codes, department names) with counts. NEVER
   * emitted for PHI columns and NEVER for high-cardinality columns (which could
   * be identifiers). This is the only place any cell-derived string appears, and
   * only for columns the PHI allowlist does not flag.
   */
  topCategories?: { value: string; count: number }[]
}

export type AggregateProfile = {
  totalRows: number
  /** Number of rows actually scanned to build the profile (may be capped). */
  sampledRows: number
  columns: ColumnAggregate[]
}

/** Max distinct categories to surface for a non-PHI categorical column. */
const MAX_TOP_CATEGORIES = 8
/**
 * A column with more distinct values than this (relative to row count) is treated
 * as potentially identifying and its category labels are NOT emitted — only its
 * distinct count. This stops high-cardinality free-text / id-like columns from
 * leaking raw values through the "categorical" path.
 */
const HIGH_CARDINALITY_ABSOLUTE = 20

function isFiniteNumber(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v)
}

/**
 * buildAggregateProfile — reduce raw rows to a schema + aggregate statistics
 * payload that carries NO raw row-level values (except low-cardinality,
 * non-PHI category labels). This is what the AI routes send instead of rows.
 *
 * Guarantees (asserted by tests):
 *  • No value from a PHI-allowlisted column ever appears in the output.
 *  • No numeric/id-like raw value is echoed; numerics collapse to min/max/mean.
 *  • Only NON-PHI, low-cardinality columns contribute category labels, capped.
 */
export function buildAggregateProfile(
  rows: Record<string, unknown>[],
  columns: Column[],
  { maxSampleRows = 5000 }: { maxSampleRows?: number } = {}
): AggregateProfile {
  const sample = rows.slice(0, maxSampleRows)

  const columnAggregates: ColumnAggregate[] = columns.map((col) => {
    const type = col.type ?? 'text'
    const phi = isPhiColumn(col.key)

    let nonNullCount = 0
    const distinct = new Set<string>()
    const categoryCounts = new Map<string, number>()
    let numericMin = Number.POSITIVE_INFINITY
    let numericMax = Number.NEGATIVE_INFINITY
    let numericSum = 0
    let numericCount = 0

    for (const row of sample) {
      const value = row[col.key]
      if (value === null || value === undefined || value === '') continue
      nonNullCount++

      if (isFiniteNumber(value)) {
        numericCount++
        numericSum += value
        if (value < numericMin) numericMin = value
        if (value > numericMax) numericMax = value
      }

      // Track distinct cardinality by a stringified form. For PHI columns we
      // still count cardinality but NEVER retain the string as a category label.
      const asString = typeof value === 'object' ? JSON.stringify(value) : String(value)
      distinct.add(asString)
      if (!phi) {
        categoryCounts.set(asString, (categoryCounts.get(asString) ?? 0) + 1)
      }
    }

    // PHI columns: suppress entirely — only counts leave, never a value.
    if (phi) {
      return {
        key: col.key,
        label: col.label,
        type,
        kind: 'phi-suppressed',
        nonNullCount,
        distinctCount: distinct.size,
      }
    }

    // Numeric columns: emit min/max/mean, never raw values.
    const mostlyNumeric = numericCount > 0 && numericCount >= nonNullCount * 0.8
    if (mostlyNumeric) {
      return {
        key: col.key,
        label: col.label,
        type,
        kind: 'numeric',
        nonNullCount,
        distinctCount: distinct.size,
        min: numericMin,
        max: numericMax,
        mean: Math.round((numericSum / numericCount) * 1000) / 1000,
      }
    }

    // Categorical: only surface labels when the column is low-cardinality AND
    // not PHI. High-cardinality columns could be identifiers → counts only.
    const lowCardinality = distinct.size > 0 && distinct.size <= HIGH_CARDINALITY_ABSOLUTE
    const topCategories = lowCardinality
      ? Array.from(categoryCounts.entries())
          .toSorted((a, b) => b[1] - a[1])
          .slice(0, MAX_TOP_CATEGORIES)
          .map(([value, count]) => ({ value, count }))
      : undefined

    return {
      key: col.key,
      label: col.label,
      type,
      kind: 'categorical',
      nonNullCount,
      distinctCount: distinct.size,
      ...(topCategories ? { topCategories } : {}),
    }
  })

  return {
    totalRows: rows.length,
    sampledRows: sample.length,
    columns: columnAggregates,
  }
}

/**
 * renderAggregateProfileForPrompt — a compact, human-readable rendering of the
 * aggregate profile for inclusion in an LLM user message. Contains only schema +
 * statistics, never raw rows.
 */
export function renderAggregateProfileForPrompt(profile: AggregateProfile): string {
  const lines: string[] = [
    `Total rows: ${profile.totalRows} (profiled ${profile.sampledRows})`,
    'Column statistics (aggregates only — no patient row values):',
  ]
  for (const c of profile.columns) {
    const parts = [`- ${c.label} [${c.type}] (${c.kind}): ${c.nonNullCount} non-null, ${c.distinctCount} distinct`]
    if (c.kind === 'numeric') {
      parts.push(`min=${c.min}, max=${c.max}, mean=${c.mean}`)
    } else if (c.topCategories && c.topCategories.length > 0) {
      const cats = c.topCategories.map((t) => `${t.value}=${t.count}`).join(', ')
      parts.push(`top: ${cats}`)
    }
    lines.push(parts.join('; '))
  }
  return lines.join('\n')
}
