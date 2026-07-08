# Data Sources & Federation Topology

> Working reference for the NL→SQL system and the database-agnostic preparation
> toolchain. Describes the real staging database, its shape, and the local
> multi-database test topology. **Credentials are never stored in this repo** —
> see `.env.example` / your secrets manager.

## Access & safety rules (MANDATORY)

- The staging database user is a **superuser** in a **staging** environment.
- **Read-only, always.** Every connection MUST:
  1. Connect with `PGOPTIONS='-c default_transaction_read_only=on'` (server-enforced
     for every statement on the connection), and
  2. Issue `SET SESSION CHARACTERISTICS AS TRANSACTION READ ONLY;` as the **first**
     statement.
- Only `SELECT` / introspection (`information_schema`, `pg_catalog`) queries. **No
  DDL, no DML, no `CREATE TEMP`** — all are rejected by the read-only transaction
  (verified: `CREATE TEMP TABLE` → `ERROR: cannot execute CREATE TABLE in a
  read-only transaction`).
- Generated SQL from the NL→SQL agent must additionally pass `lib/sqlGuard.ts`
  (defense-in-depth) before execution, and the runtime connection role should be a
  genuinely read-only principal (infra requirement, not app-enforceable).

## Staging database

| Property | Value |
|---|---|
| Engine | PostgreSQL 15.15 (Ubuntu) |
| Host / port | `localhost:55432` (SSH tunnel) |
| Reconnect | if the tunnel drops: `ssh dev.db -L 55432:localhost:5432` (background) |
| User | `CeibaSa` (superuser — keep read-only) |
| Databases | `CeibaHospitalDB` (clinical target), `ValidationDB`, `uadapt`, `validation`, `postgres` |

### `CeibaHospitalDB` shape

Schemas (table counts): `Shared` **942**, `public` 110, `ICU` 66, `NICU` 49,
`VEM` 46, `AgentOps` 21, `hangfire` 12, `Audit` 6, `PICU` 5, `KVC` 3, `System` 2,
`repack` 2.

Largest tables (approx rows) — the NL→SQL system must push time/predicate filters
and `LIMIT` down, since these are huge time-series:

| Table | ~Rows |
|---|---|
| `Shared.MonitorMeasurements` | 337M |
| `Shared.VentilatorMeasurements` | 271M |
| `Shared.Monitors` | 60M |
| `Shared.NewsParameters` | 32M |
| `Shared.PumpMeasurements` | 28M |
| `Shared.VitalAlarms` | 15.5M |
| `Shared.Ventilators` | 15M |
| `NICU.Incubators` | 14M |
| `Shared.BloodGasMeasurements` | 3.4M |
| `Shared.Laboratories` | 2.2M |
| `Shared.ICD10s` | 22K |

Clinical domains present: monitor/ventilator/pump vitals & waveforms, NEWS scores,
blood-gas, ICU SAPS/SOFA scoring, NICU incubators, labs, ICD-10 coding, audit.

### Implications for the design

- **~1000+ tables** → schema retrieval/linking is mandatory; injecting the full
  schema into the LLM is impossible. Retrieval must scale (see
  `docs/research/NL2SQL_RESEARCH.md` and `docs/NL2SQL_SPEC.md`).
- **Billions of measurement rows** → RAG artifacts carry cardinality/row-count
  metadata so the LLM is guided to filter (time-bounds, patient/encounter scoping).
- **PascalCase, quoted, multi-schema identifiers** (e.g. `Shared."MonitorMeasurements"`)
  → dialect/quoting handling is a first-class concern.
- **Temporal queries** ("admitted yesterday", "heart rate > 120 in the last 3 hours")
  are first-class.
- **PHI/egress:** the prep toolchain embeds **schema/metadata and synthetic or
  aggregate descriptors only** — never raw patient values. Row-level PHI does not
  egress to any LLM without a signed BAA + resolved data residency (the
  `OPENAI_BAA_SIGNED` gate, default closed).

## Local multi-database test topology (OrbStack)

To exercise **cross-database federation** without touching staging with writes, a
local companion Postgres runs in OrbStack containing **synthetic mock data that
correlates with the staging schema** (e.g. a reference/lookup DB, or a second
"hospital" that federated queries must join across).

- Federation engine is an **open, swappable decision** (Trino is one candidate;
  StarRocks / Dremio / DuckDB / Calcite / Postgres FDW + a pooling/proxy layer are
  under evaluation — see the research doc). The topology used for tests is:
  `staging CeibaHospitalDB` (read-only) + `local mock DB` (OrbStack).
- The evaluation harness role-plays a driving LLM, feeds NL questions + retrieved
  schema context, captures the generated SQL, and scores it (read-only guard,
  parses, references real tables, executes on the local/synthetic topology).

See also: `docs/research/NL2SQL_RESEARCH.md`, `docs/NL2SQL_SPEC.md`,
`docs/NL2SQL_PLAN.md`, and the memory notes `nl2sql-product-goal`,
`staging-db-access`.
