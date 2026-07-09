-- =============================================================================
-- Ceiba NL->SQL mock Postgres — SCHEMA (Phase P1)
-- =============================================================================
-- Synthetic, NO-PHI schema that mirrors staging conventions:
--   * schema `public` with PascalCase, double-quoted identifiers
--     (staging uses e.g. Shared."MonitorMeasurements"; here public."HospitalRef")
--   * a SHARED ID SPACE with staging (see docs/mock-topology.md, §0a decision #1):
--       HospitalId (int), MeasurementTypeId (int), WardId (int)
--   * patient/visit surrogate keys are MOCK-LOCAL (namespaced, no staging PHI)
--
-- This file is idempotent (DROP ... IF EXISTS then CREATE) so re-seeding or a CI
-- service container that re-applies init SQL produces the same objects.
--
-- Portability: plain SQL only — no OrbStack-specific features. Safe to run in a
-- CI Postgres service container.
-- =============================================================================

SET client_min_messages = warning;

-- Drop in dependency order (children before parents) so re-init is clean.
DROP TABLE IF EXISTS public."VisitMock"          CASCADE;
DROP TABLE IF EXISTS public."MeasurementsMock"   CASCADE;
DROP TABLE IF EXISTS public."PatientMock"        CASCADE;
DROP TABLE IF EXISTS public."WardRef"            CASCADE;
DROP TABLE IF EXISTS public."MeasurementTypeRef" CASCADE;
DROP TABLE IF EXISTS public."HospitalRef"        CASCADE;

-- -----------------------------------------------------------------------------
-- HospitalRef — the cross-source JOIN TARGET.
-- Correlates to staging Shared.Acceptances.HospitalId. HospitalId is part of the
-- shared id space; this mock DB models a SECOND hospital + shared reference vocab.
-- -----------------------------------------------------------------------------
CREATE TABLE public."HospitalRef" (
    "HospitalId" integer PRIMARY KEY,
    "name"       text NOT NULL,
    "region"     text NOT NULL
);
COMMENT ON TABLE public."HospitalRef" IS
    'Cross-source join target. HospitalId is shared with staging Shared.Acceptances.HospitalId. Synthetic, no PHI.';

-- -----------------------------------------------------------------------------
-- MeasurementTypeRef — shared reference vocabulary.
-- Correlates to staging Shared.MonitorMeasurementTypes. MeasurementTypeId is
-- part of the shared id space. MUST include a 'Heart Rate' type (§0a #1, P1 task).
-- -----------------------------------------------------------------------------
CREATE TABLE public."MeasurementTypeRef" (
    "MeasurementTypeId" integer PRIMARY KEY,
    "name"              text NOT NULL,
    "unit"              text NOT NULL
);
COMMENT ON TABLE public."MeasurementTypeRef" IS
    'Shared measurement vocabulary. MeasurementTypeId correlates to staging Shared.MonitorMeasurementTypes. Synthetic.';

-- -----------------------------------------------------------------------------
-- WardRef — wards belonging to hospitals. WardId is part of the shared id space.
-- -----------------------------------------------------------------------------
CREATE TABLE public."WardRef" (
    "WardId"     integer PRIMARY KEY,
    "name"       text NOT NULL,
    "hospitalId" integer NOT NULL
        REFERENCES public."HospitalRef" ("HospitalId")
);
COMMENT ON TABLE public."WardRef" IS
    'Wards per hospital. WardId shared id space; hospitalId FK -> HospitalRef. Synthetic.';

-- -----------------------------------------------------------------------------
-- PatientMock — synthetic patients with MOCK-LOCAL surrogate keys ONLY.
-- NO PHI: no names, no dates of birth, no MRNs. Only a namespaced code + coarse
-- non-identifying attributes. patientRef in MeasurementsMock points here.
-- -----------------------------------------------------------------------------
CREATE TABLE public."PatientMock" (
    "patientRef"  integer PRIMARY KEY,          -- mock-local surrogate key
    "patientCode" text NOT NULL UNIQUE,         -- synthetic, e.g. 'MP-0001'
    "hospitalId"  integer NOT NULL
        REFERENCES public."HospitalRef" ("HospitalId"),
    "wardId"      integer
        REFERENCES public."WardRef" ("WardId"),
    "ageBand"     text NOT NULL                 -- coarse, non-identifying bucket
);
COMMENT ON TABLE public."PatientMock" IS
    'Synthetic patients. patientRef/patientCode are MOCK-LOCAL surrogate keys with NO relation to staging PHI. No names/DOB/MRN.';

-- -----------------------------------------------------------------------------
-- VisitMock — synthetic encounters with mock-local surrogate keys.
-- -----------------------------------------------------------------------------
CREATE TABLE public."VisitMock" (
    "visitRef"    integer PRIMARY KEY,          -- mock-local surrogate key
    "patientRef"  integer NOT NULL
        REFERENCES public."PatientMock" ("patientRef"),
    "wardId"      integer
        REFERENCES public."WardRef" ("WardId"),
    "admittedAt"  timestamptz NOT NULL,
    "dischargedAt" timestamptz
);
COMMENT ON TABLE public."VisitMock" IS
    'Synthetic encounters. visitRef/patientRef are MOCK-LOCAL surrogate keys, no staging PHI.';

-- -----------------------------------------------------------------------------
-- MeasurementsMock — the LARGE-TABLE ANALOG (staging Shared.MonitorMeasurements,
-- ~337M rows). §0a decision #5: created WITH a btree index on RecordedAt so the
-- cardinality guard's requiredTimeColumn resolves in CI exactly as on staging.
-- -----------------------------------------------------------------------------
CREATE TABLE public."MeasurementsMock" (
    "Id"                bigint PRIMARY KEY,
    "DeviceId"          integer NOT NULL,
    "MeasurementTypeId" integer NOT NULL
        REFERENCES public."MeasurementTypeRef" ("MeasurementTypeId"),
    "Value"             double precision NOT NULL,
    "RecordedAt"        timestamptz NOT NULL,
    "patientRef"        integer NOT NULL
        REFERENCES public."PatientMock" ("patientRef")
);
COMMENT ON TABLE public."MeasurementsMock" IS
    'Synthetic time-series analog of staging Shared.MonitorMeasurements. RecordedAt btree-indexed so cardinalityGuard requiredTimeColumn resolves. No PHI.';

-- §0a decision #5 — the indexed time column the cardinality guard requires.
CREATE INDEX "IX_MeasurementsMock_RecordedAt"
    ON public."MeasurementsMock" ("RecordedAt");

-- Helpful composite for the canonical "heart rate > 120 in last 3h" filter
-- (type + time). Still leaves the pure-time index above for the guard to find.
CREATE INDEX "IX_MeasurementsMock_Type_RecordedAt"
    ON public."MeasurementsMock" ("MeasurementTypeId", "RecordedAt");
