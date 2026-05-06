// Clinical abbreviations and expansions for better NL understanding
export const CLINICAL_ABBREVIATIONS: Record<string, string> = {
  'icu': 'intensive care unit',
  'ed': 'emergency department',
  'nicu': 'neonatal intensive care unit',
  'los': 'length of stay',
  'bp': 'blood pressure',
  'hr': 'heart rate',
  'o2': 'oxygen saturation',
  'spo2': 'oxygen saturation',
  'temp': 'temperature',
  'pt': 'patient',
  'pts': 'patients',
  'dx': 'diagnosis',
  'hx': 'history',
  'adm': 'admission',
  'dc': 'discharge',
  'icd': 'icd10 diagnosis code',
}

// Expand abbreviations in user message for better schema matching
export function expandClinicalAbbreviations(text: string): string {
  let expanded = text.toLowerCase()
  for (const [abbr, full] of Object.entries(CLINICAL_ABBREVIATIONS)) {
    expanded = expanded.replace(new RegExp(`\\b${abbr}\\b`, 'gi'), full)
  }
  return expanded
}

// Common clinical time ranges
export const TIME_RANGE_HINTS: Record<string, string> = {
  'today': "DATE(AcceptanceDate) = CURRENT_DATE",
  'this week': "AcceptanceDate >= DATE_TRUNC('week', CURRENT_DATE)",
  'this month': "AcceptanceDate >= DATE_TRUNC('month', CURRENT_DATE)",
  'last 30 days': "AcceptanceDate >= NOW() - INTERVAL '30 days'",
  'last 90 days': "AcceptanceDate >= NOW() - INTERVAL '90 days'",
  'last year': "AcceptanceDate >= NOW() - INTERVAL '1 year'",
  'ytd': "AcceptanceDate >= DATE_TRUNC('year', CURRENT_DATE)",
}

// Detect time range in message and return SQL hint
export function extractTimeRangeHint(text: string): string | null {
  const lower = text.toLowerCase()
  for (const [phrase, sql] of Object.entries(TIME_RANGE_HINTS)) {
    if (lower.includes(phrase)) return sql
  }
  return null
}

// Clinical KPI categories for template organization
export const CLINICAL_CATEGORIES = [
  'Patient Flow',
  'Clinical Outcomes',
  'Resource Utilization',
  'Quality Metrics',
  'Staff & Operations',
] as const
