export type TrinoColumn = { name: string; type: string }
export type TrinoResult = { columns: TrinoColumn[]; rows: Record<string, unknown>[]; rowCount: number }

export type DbTarget = 'telehealth' | 'eclinics'

function getBase() {
  return `http://${process.env.TRINO_HOST || 'localhost'}:${process.env.TRINO_PORT || '8080'}`
}

function getCatalog(db: DbTarget) {
  return db === 'telehealth'
    ? (process.env.TRINO_CATALOG_TELEHEALTH || 'telehealth')
    : (process.env.TRINO_CATALOG_ECLINICS || 'eclinics')
}

export async function executeTrinoQuery(sql: string, db: DbTarget = 'eclinics', schema = 'Shared', maxRows = 1000): Promise<TrinoResult> {
  const base = getBase()
  const user = process.env.TRINO_USER || 'readonly'
  const catalog = getCatalog(db)

  const initRes = await fetch(`${base}/v1/statement`, {
    method: 'POST',
    headers: {
      'Content-Type': 'text/plain',
      'X-Trino-User': user,
      'X-Trino-Catalog': catalog,
      'X-Trino-Schema': schema,
      'X-Trino-Source': 'ceiba-data-explorer',
    },
    body: sql,
  })

  if (!initRes.ok) throw new Error(`Trino submit failed (${initRes.status}): ${await initRes.text()}`)

  let state = await initRes.json()
  let columns: TrinoColumn[] = []
  const rawRows: unknown[][] = []

  while (true) {
    if (state.columns?.length) columns = state.columns.map((c: { name: string; type: string }) => ({ name: c.name, type: c.type }))
    if (state.data) for (const row of state.data) { if (rawRows.length < maxRows) rawRows.push(row as unknown[]) }
    if (state.error) throw new Error(state.error?.message || 'Query failed')
    if (!state.nextUri) break
    await new Promise(r => setTimeout(r, 150))
    const poll = await fetch(state.nextUri, { headers: { 'X-Trino-User': user } })
    if (!poll.ok) break
    state = await poll.json()
  }

  const rows = rawRows.map(row => Object.fromEntries(columns.map((col, i) => [col.name, (row as unknown[])[i]])))
  return { columns, rows, rowCount: rows.length }
}
