# Mock Topology — Local Synthetic Companion Postgres (Phase P1)

> The **mock** side of the NL→SQL federation topology. A local, throwaway
> Postgres (`docker/mock-postgres`) holding **deterministic synthetic data with
> NO PHI**, correlated to staging `CeibaHospitalDB` via a **shared id space**.
> This is what P3/P6 seed against and what the engines (`lib/engine/**`, P2)
> `ATTACH`/connect to for cross-source, read-only federation tests.
>
> See also: `docs/DATA_SOURCES.md`, `docs/NL2SQL_PLAN.md` (§P1, §0a decisions
> #1 and #5).

## What it is / is not

- **Is:** a second "hospital" plus a shared reference vocabulary, so a federated
  query has to join **across** staging and this mock DB.
- **Is not:** a copy of staging. It contains **no real patient data**. All
  patient/visit keys are **mock-local surrogate keys** with no relationship to
  staging identifiers.

## Connection

| Property | Value |
|---|---|
| Engine | PostgreSQL 16 (OrbStack / Docker; CI uses a Postgres service container) |
| Host / port | `localhost:55433` (fixed; avoids the `55432` staging SSH tunnel) |
| Database | `mockdb` |
| Admin role (bootstrap only) | `mock_admin` / `mock_admin_pw` |
| **Read-only role (engines connect as this)** | **`ceiba_ro` / `ceiba_ro_pw`** |
| `MOCK_DSN` | `postgresql://ceiba_ro:ceiba_ro_pw@localhost:55433/mockdb` |

`ceiba_ro` is a **genuinely read-only principal** (primary infra-level read-only
control): `USAGE` on `public` + `SELECT` on all tables, `CREATE` revoked, no
DML/DDL/sequence-write grants, and default privileges keep future tables
SELECT-only. Defined in `docker/mock-postgres/init/03_readonly_role.sql`.

Up/down:

```bash
bash scripts/mock-db-up.sh              # start, wait for healthcheck
bash scripts/mock-db-down.sh            # stop, keep data volume
bash scripts/mock-db-down.sh --volumes  # stop + wipe volume (re-seed identically)
```

## Shared id space (mock ↔ staging correlation)

Per `NL2SQL_PLAN.md` §0a decision #1, the mock and staging share three integer
id spaces. Everything else (patient/visit keys) is mock-local.

| Shared key | Type | Mock home | Staging correlate | Cross-source edge |
|---|---|---|---|---|
| `HospitalId` | `int` | `public."HospitalRef"."HospitalId"` (PK) | `Shared.Acceptances.HospitalId` | **Yes — primary join edge:** `Shared.Acceptances.HospitalId → mock.public."HospitalRef"."HospitalId"` |
| `MeasurementTypeId` | `int` | `public."MeasurementTypeRef"."MeasurementTypeId"` (PK) | `Shared.MonitorMeasurementTypes` | reference-vocabulary correlation |
| `WardId` | `int` | `public."WardRef"."WardId"` (PK) | ward/unit dimension | dimension correlation |

**Mock-local (NOT shared, no PHI):** `PatientMock."patientRef"` /
`"patientCode"` (e.g. `MP-0001`) and `VisitMock."visitRef"` are namespaced
surrogate keys with **no overlap** with staging PHI. `MeasurementsMock."patientRef"`
references `PatientMock`, never a staging patient.

## Mock tables → staging correlation map

| Mock table | Purpose | Correlates to staging |
|---|---|---|
| `public."HospitalRef"` (`HospitalId` PK, `name`, `region`) | Cross-source join target; second hospital + shared ref | `Shared.Acceptances.HospitalId` |
| `public."MeasurementTypeRef"` (`MeasurementTypeId` PK, `name`, `unit`) | Shared measurement vocabulary; includes **Heart Rate** (id `1`) | `Shared.MonitorMeasurementTypes` |
| `public."WardRef"` (`WardId` PK, `name`, `hospitalId`→HospitalRef) | Wards per hospital | ward/unit dimension |
| `public."PatientMock"` (`patientRef` PK, `patientCode`, `hospitalId`, `wardId`, `ageBand`) | Synthetic patients; **no PHI** (no name/DOB/MRN) | *mock-local only* |
| `public."VisitMock"` (`visitRef` PK, `patientRef`, `wardId`, `admittedAt`, `dischargedAt`) | Synthetic encounters | *mock-local only* |
| `public."MeasurementsMock"` (`Id` PK, `DeviceId`, `MeasurementTypeId`→ref, `Value`, `RecordedAt`, `patientRef`→PatientMock) | Large time-series analog | `Shared.MonitorMeasurements` (~337M rows) |

### Identifier conventions

Schema is `public` with **PascalCase, double-quoted** identifiers, mirroring
staging (e.g. staging `Shared."MonitorMeasurements"` ↔ mock
`public."MeasurementsMock"`). Generated SQL must quote these.

## Indexed time column (cardinality guard)

Per §0a decision #5, `public."MeasurementsMock"."RecordedAt"` (`timestamptz`)
has a **btree index** `IX_MeasurementsMock_RecordedAt`, so the cardinality
guard's `requiredTimeColumn` resolves in CI exactly as it does on staging. A
composite `IX_MeasurementsMock_Type_RecordedAt` (`MeasurementTypeId`,
`RecordedAt`) additionally supports the canonical heart-rate filter.

## Seed shape (deterministic, no PHI)

Defined in `docker/mock-postgres/init/02_seed.sql`; fully deterministic (values
derived from a fixed `generate_series` index — no randomness).

- **2** hospitals (`HospitalId` 1, 2), **5** measurement types (Heart Rate = 1),
  **4** wards, **40** patients, **40** visits.
- **~483** `MeasurementsMock` rows spanning the **last 7 days**, ~21 min apart.
- Heart-Rate (`MeasurementTypeId = 1`) `Value`s alternate **>120 and <120**,
  including within the **last 3 hours**, so the canonical
  *"heart rate > 120 in the last 3 hours"* question always has qualifying rows.
- Timestamps are anchored to `now()` at init time: the **shape** (row count,
  value distribution, relative spacing, window membership) is invariant across
  runs; only absolute wall-clock timestamps shift with init time.

## CI note

CI seeds a Postgres **service container** with the same
`docker/mock-postgres/init/*.sql` (no OrbStack). The init SQL is deliberately
portable — plain SQL, no OrbStack-specific features — and idempotent (drops +
`TRUNCATE ... RESTART IDENTITY` + `ON CONFLICT`), so re-application is safe.
