type TableDef = { name: string; cols: string; keywords: string[]; catalog?: 'telehealth' | 'eclinics' }

const CLINICAL_TABLES: TableDef[] = [
  {
    name: '"Shared"."Acceptances"',
    catalog: 'telehealth',
    cols: 'AcceptanceDate, PatientId, UnitId, DoctorId, DiagnosisCode, LengthOfStay, DischargeDate, Status',
    keywords: ['patient', 'admission', 'accept', 'discharge', 'stay', 'length', 'status', 'diagnosis', 'admit'],
  },
  {
    name: '"Shared"."Units"',
    catalog: 'telehealth',
    cols: 'Id, Name, DepartmentId, Capacity, Type',
    keywords: ['unit', 'icu', 'ward', 'bed', 'capacity', 'department'],
  },
  {
    name: '"Shared"."Departments"',
    catalog: 'telehealth',
    cols: 'Id, Name, HospitalId, HeadDoctorId',
    keywords: ['department', 'dept', 'division', 'section'],
  },
  {
    name: '"Shared"."Hospitals"',
    catalog: 'telehealth',
    cols: 'Id, HospitalName, City, Type',
    keywords: ['hospital', 'facility', 'clinic', 'center', 'site'],
  },
  {
    name: '"Shared"."Patients"',
    catalog: 'telehealth',
    cols: 'Id, Age, Gender, BloodType, Nationality',
    keywords: ['patient', 'age', 'gender', 'blood', 'demographic', 'nationality'],
  },
  {
    name: '"Shared"."Doctors"',
    catalog: 'telehealth',
    cols: 'Id, Name, Specialization, UnitId',
    keywords: ['doctor', 'physician', 'specialist', 'staff', 'provider'],
  },
  {
    name: '"Shared"."VitalSigns"',
    catalog: 'telehealth',
    cols: 'PatientId, RecordedAt, HeartRate, BloodPressureSys, BloodPressureDia, Temperature, OxygenSat',
    keywords: ['vital', 'heart', 'blood pressure', 'temperature', 'oxygen', 'saturation', 'bp', 'hr'],
  },
  {
    name: '"Shared"."Diagnoses"',
    catalog: 'telehealth',
    cols: 'Id, ICD10Code, Description, Category',
    keywords: ['diagnosis', 'diagnos', 'icd', 'code', 'condition', 'disease'],
  },
  // Eclinics tables (critical care & ICU)
  {
    name: 'eclinics.public."CriticalPatients"',
    catalog: 'eclinics',
    cols: 'PatientId, AdmissionDate, DiagnosisCode, APACHEScore, GCSScore, VentilatorStatus, ICUBed',
    keywords: ['critical', 'apache', 'gcs', 'icu', 'ventilator', 'eclinics', 'intensive'],
  },
  {
    name: 'eclinics.public."DrugAlerts"',
    catalog: 'eclinics',
    cols: 'PatientId, DrugGUID, AlertType, AlertTime, Severity, AcknowledgedBy',
    keywords: ['drug', 'alert', 'medication', 'pump', 'infusion', 'severity'],
  },
  {
    name: 'eclinics.public."ClinicalNotes"',
    catalog: 'eclinics',
    cols: 'PatientId, NoteDate, NoteType, DoctorId, Summary',
    keywords: ['note', 'clinical note', 'summary', 'doctor note', 'observation'],
  },
]

export function getRelevantSchema(userMessage: string): string {
  return getSchemaForDatabase('both', userMessage)
}

export function getSchemaForDatabase(
  db: 'telehealth' | 'eclinics' | 'both',
  userMessage: string
): string {
  const msg = userMessage.toLowerCase()

  // Filter tables by catalog if a specific DB is selected
  const filteredTables = db === 'both'
    ? CLINICAL_TABLES
    : CLINICAL_TABLES.filter((t) => !t.catalog || t.catalog === db)

  // Score each table
  const scored = filteredTables.map(t => ({
    ...t,
    score: t.keywords.filter(k => msg.includes(k)).length,
  }))

  // Sort by relevance score (descending)
  const sorted = scored.sort((a, b) => b.score - a.score)

  // Take top 4 tables max to keep prompt lean
  const relevant = sorted.slice(0, 4)

  // Always include the primary table for the selected DB
  const primaryTableName = db === 'eclinics' ? 'CriticalPatients' : 'Acceptances'
  const hasPrimary = relevant.some(t => t.name.includes(primaryTableName))
  const tables = hasPrimary
    ? relevant
    : [scored.find(t => t.name.includes(primaryTableName)) ?? scored[0], ...relevant.slice(0, 3)].filter(Boolean)

  return tables
    .map(t => `${t.name}(${t.cols})`)
    .join('\n')
}
