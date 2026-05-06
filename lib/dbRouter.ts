// ─── Dual Database Router ─────────────────────────────────────────────────────
// Two databases available via Trino:
//   • TeleHealth.DB  → telehealth catalog  (calls, sessions, telemedicine)
//   • Eclinics.DB    → eclinics catalog    (ICU, clinical records, patients)
// ─────────────────────────────────────────────────────────────────────────────

export type DbTarget = 'telehealth' | 'eclinics'

export type DbConfig = {
  id: DbTarget
  label: string
  catalog: string
  schema: string
  color: string
  tables: TableDef[]
}

type TableDef = {
  name: string
  alias: string
  cols: string
  keywords: string[]
}

const TELEHEALTH: DbConfig = {
  id: 'telehealth',
  label: 'TeleHealth.DB',
  catalog: 'telehealth',
  schema: 'public',
  color: '#4dcc88',
  tables: [
    { name: 'telehealth.public."DirectCalls"', alias: 'DirectCalls', cols: 'Id, UserId, SessionId, StartedAt, EndedAt, DurationSeconds, Purpose, Status, InterpreterLanguage', keywords: ['call', 'direct call', 'telemedicine', 'duration', 'interpreter', 'language', 'purpose', 'video'] },
    { name: 'telehealth.public."CallSessions"', alias: 'CallSessions', cols: 'Id, PatientId, DoctorId, StartTime, EndTime, Type, Status', keywords: ['session', 'call session', 'teleconsult', 'remote', 'consult'] },
    { name: 'telehealth.public."CallUsers"', alias: 'CallUsers', cols: 'Id, Name, Role, UnitId, HospitalId', keywords: ['user', 'caller', 'call user', 'provider'] },
    { name: 'telehealth.public."CallLevelDataset"', alias: 'CallLevelDataset', cols: 'CallId, UserId, Purpose, DurationSeconds, Hospital, Unit, Department', keywords: ['call level', 'call data', 'breakdown', 'summary'] },
  ],
}

const ECLINICS: DbConfig = {
  id: 'eclinics',
  label: 'Eclinics.DB',
  catalog: 'eclinics',
  schema: 'Shared',
  color: '#4c8dff',
  tables: [
    { name: 'eclinics."Shared"."Acceptances"', alias: 'Acceptances', cols: 'AcceptanceDate, PatientId, UnitId, DoctorId, DiagnosisCode, LengthOfStay, DischargeDate, Status', keywords: ['patient', 'admission', 'accept', 'discharge', 'stay', 'length', 'status', 'diagnosis', 'admit', 'los'] },
    { name: 'eclinics."Shared"."Units"', alias: 'Units', cols: 'Id, Name, DepartmentId, Capacity, Type', keywords: ['unit', 'icu', 'ward', 'bed', 'capacity', 'nicu', 'ed', 'emergency'] },
    { name: 'eclinics."Shared"."Departments"', alias: 'Departments', cols: 'Id, Name, HospitalId, HeadDoctorId', keywords: ['department', 'dept', 'division'] },
    { name: 'eclinics."Shared"."Hospitals"', alias: 'Hospitals', cols: 'Id, HospitalName, City, Type', keywords: ['hospital', 'facility', 'clinic', 'center', 'site'] },
    { name: 'eclinics."Shared"."Patients"', alias: 'Patients', cols: 'Id, Age, Gender, BloodType, Nationality', keywords: ['patient', 'age', 'gender', 'blood', 'demographic'] },
    { name: 'eclinics."Shared"."Doctors"', alias: 'Doctors', cols: 'Id, Name, Specialization, UnitId', keywords: ['doctor', 'physician', 'specialist', 'staff'] },
    { name: 'eclinics."Shared"."VitalSigns"', alias: 'VitalSigns', cols: 'PatientId, RecordedAt, HeartRate, BloodPressureSys, BloodPressureDia, Temperature, OxygenSat', keywords: ['vital', 'heart', 'blood pressure', 'temperature', 'oxygen', 'saturation', 'bp', 'hr', 'spo2'] },
    { name: 'eclinics."Shared"."Diagnoses"', alias: 'Diagnoses', cols: 'Id, ICD10Code, Description, Category', keywords: ['diagnosis', 'icd', 'code', 'condition', 'disease', 'icd10'] },
    { name: 'eclinics."Shared"."DrugAlerts"', alias: 'DrugAlerts', cols: 'Id, PatientId, DrugGUID, AlertType, TriggeredAt, Severity', keywords: ['drug', 'medication', 'alert', 'pump', 'alarm', 'infusion'] },
  ],
}

export const DB_CONFIGS: Record<DbTarget, DbConfig> = { telehealth: TELEHEALTH, eclinics: ECLINICS }

export function routeToDatabase(userMessage: string): DbTarget {
  const msg = userMessage.toLowerCase()
  let telehealthScore = 0
  let eclinicsScore = 0
  for (const t of TELEHEALTH.tables) telehealthScore += t.keywords.filter(k => msg.includes(k)).length
  for (const t of ECLINICS.tables) eclinicsScore += t.keywords.filter(k => msg.includes(k)).length
  return telehealthScore > eclinicsScore ? 'telehealth' : 'eclinics'
}

export function getSchemaForDb(userMessage: string, dbTarget: DbTarget): string {
  const msg = userMessage.toLowerCase()
  const config = DB_CONFIGS[dbTarget]
  const scored = config.tables
    .map(t => ({ ...t, score: t.keywords.filter(k => msg.includes(k)).length }))
    .sort((a, b) => b.score - a.score)
  const top4 = scored.slice(0, 4)
  const coreAlias = dbTarget === 'eclinics' ? 'Acceptances' : 'DirectCalls'
  const hasCore = top4.some(t => t.alias === coreAlias)
  const tables = hasCore ? top4 : [scored.find(t => t.alias === coreAlias)!, ...top4.slice(0, 3)].filter(Boolean)
  return tables.map(t => `${t.name}(${t.cols})`).join('\n')
}
