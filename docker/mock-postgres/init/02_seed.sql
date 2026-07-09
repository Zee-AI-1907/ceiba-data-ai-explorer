-- =============================================================================
-- Ceiba NL->SQL mock Postgres — SEED (Phase P1)
-- =============================================================================
-- Deterministic synthetic rows. NO PHI, NO randomness: every value is derived
-- from a fixed generate_series index, so the dataset is byte-identical across
-- runs and CI runners (given the same init SQL).
--
-- TEMPORAL ANCHOR: RecordedAt / admittedAt are computed as offsets from now()
-- at seed time. This is deterministic in SHAPE (row count, value distribution,
-- relative spacing) and keeps the "last N hours" windows populated no matter
-- WHEN the container is initialized — so the canonical
-- "heart rate > 120 in the last 3 hours" test always has qualifying rows.
-- Absolute timestamps naturally differ by init time; the correctness contract
-- (rows within the recent window, HR values both >120 and <120) is invariant.
--
-- Row counts are intentionally small (hundreds) but shape-realistic.
-- Portable SQL — runs identically in a CI Postgres service container.
-- =============================================================================

SET client_min_messages = warning;

-- Idempotent: clear any prior data (safe if this file is re-applied to a
-- non-empty volume). TRUNCATE ... CASCADE respects FK order.
TRUNCATE TABLE
    public."MeasurementsMock",
    public."VisitMock",
    public."PatientMock",
    public."WardRef",
    public."MeasurementTypeRef",
    public."HospitalRef"
RESTART IDENTITY CASCADE;

-- -----------------------------------------------------------------------------
-- HospitalRef — the mock models a SECOND hospital (HospitalId 2) plus a shared
-- reference hospital (HospitalId 1). HospitalId is the shared id space with
-- staging Shared.Acceptances.HospitalId (cross-source join edge).
-- -----------------------------------------------------------------------------
INSERT INTO public."HospitalRef" ("HospitalId", "name", "region") VALUES
    (1, 'Ceiba Central (shared ref)', 'Marmara'),
    (2, 'Ceiba North (mock 2nd hospital)', 'Aegean');

-- -----------------------------------------------------------------------------
-- MeasurementTypeRef — shared vocabulary. MeasurementTypeId correlates to
-- staging Shared.MonitorMeasurementTypes. MUST include 'Heart Rate' (id 1).
-- -----------------------------------------------------------------------------
INSERT INTO public."MeasurementTypeRef" ("MeasurementTypeId", "name", "unit") VALUES
    (1, 'Heart Rate',       'bpm'),
    (2, 'SpO2',             '%'),
    (3, 'Respiratory Rate', 'breaths/min'),
    (4, 'Temperature',      'degC'),
    (5, 'Mean Arterial Pressure', 'mmHg');

-- -----------------------------------------------------------------------------
-- WardRef — wards under each hospital. WardId shared id space.
-- -----------------------------------------------------------------------------
INSERT INTO public."WardRef" ("WardId", "name", "hospitalId") VALUES
    (10, 'ICU-A',  1),
    (11, 'NICU-1', 1),
    (20, 'ICU-B',  2),
    (21, 'PICU-1', 2);

-- -----------------------------------------------------------------------------
-- PatientMock — 40 synthetic patients. NO PHI: namespaced code + coarse age band.
-- Deterministic distribution across hospitals/wards via the series index.
-- -----------------------------------------------------------------------------
INSERT INTO public."PatientMock" ("patientRef", "patientCode", "hospitalId", "wardId", "ageBand")
SELECT
    idx                                            AS "patientRef",
    'MP-' || lpad(idx::text, 4, '0')               AS "patientCode",
    CASE WHEN idx % 2 = 0 THEN 2 ELSE 1 END        AS "hospitalId",
    CASE
        WHEN idx % 4 = 0 THEN 21
        WHEN idx % 4 = 1 THEN 10
        WHEN idx % 4 = 2 THEN 20
        ELSE 11
    END                                            AS "wardId",
    (ARRAY['0-17','18-39','40-64','65+'])[(idx % 4) + 1] AS "ageBand"
FROM generate_series(1, 40) AS idx;

-- -----------------------------------------------------------------------------
-- VisitMock — one visit per patient. admittedAt anchored to now() so encounters
-- are "recent"; deterministic spacing by patientRef.
-- -----------------------------------------------------------------------------
INSERT INTO public."VisitMock" ("visitRef", "patientRef", "wardId", "admittedAt", "dischargedAt")
SELECT
    p."patientRef"                                            AS "visitRef",
    p."patientRef"                                            AS "patientRef",
    p."wardId"                                                AS "wardId",
    now() - make_interval(hours => (p."patientRef" % 7) * 24) AS "admittedAt",
    CASE
        WHEN p."patientRef" % 3 = 0
        THEN now() - make_interval(hours => (p."patientRef" % 7) * 24) + interval '12 hours'
        ELSE NULL   -- still admitted
    END                                                       AS "dischargedAt"
FROM public."PatientMock" p;

-- -----------------------------------------------------------------------------
-- MeasurementsMock — the time-series analog.
--
-- Layout (all deterministic, derived from series index `s`):
--   * 480 rows total.
--   * RecordedAt spans the last 7 days: each row is spaced ~21 minutes apart
--     going backwards from now() (7 days * 24h * 60m / 480 rows ~= 21 min).
--     => the most recent ~9 rows fall inside the last 3 hours.
--   * MeasurementTypeId cycles 1..5; type 1 = Heart Rate.
--   * For Heart Rate rows, Value alternates deterministically so BOTH
--     >120 and <120 values exist, INCLUDING within the last 3 hours.
--   * patientRef cycles 1..40; DeviceId derived from patientRef.
-- -----------------------------------------------------------------------------
INSERT INTO public."MeasurementsMock"
    ("Id", "DeviceId", "MeasurementTypeId", "Value", "RecordedAt", "patientRef")
SELECT
    s                                                   AS "Id",
    1000 + ((s % 40) + 1)                               AS "DeviceId",
    ((s % 5) + 1)                                       AS "MeasurementTypeId",
    CASE ((s % 5) + 1)
        -- Heart Rate: alternate high (>120) / normal (<120) deterministically.
        WHEN 1 THEN CASE WHEN s % 2 = 0 THEN 135.0 + (s % 15) ELSE 72.0 + (s % 20) END
        WHEN 2 THEN 92.0 + (s % 8)          -- SpO2 %
        WHEN 3 THEN 14.0 + (s % 10)         -- Respiratory rate
        WHEN 4 THEN 36.4 + ((s % 20) * 0.05)-- Temperature degC
        ELSE        70.0 + (s % 30)         -- MAP mmHg
    END                                                 AS "Value",
    -- Newest row (s = 480) is ~21 min ago; oldest (s = 1) is ~7 days ago.
    now() - make_interval(mins => (480 - s) * 21)       AS "RecordedAt",
    ((s % 40) + 1)                                      AS "patientRef"
FROM generate_series(1, 480) AS s;

-- Guarantee: at least one Heart Rate (type 1) value > 120 inside the LAST 3
-- HOURS regardless of the arithmetic above. Deterministic, idempotent upsert on
-- a reserved high Id so re-applying the seed does not accumulate rows.
INSERT INTO public."MeasurementsMock"
    ("Id", "DeviceId", "MeasurementTypeId", "Value", "RecordedAt", "patientRef")
VALUES
    (900001, 1001, 1, 145.0, now() - interval '30 minutes',  1),
    (900002, 1002, 1, 158.0, now() - interval '90 minutes',  2),
    (900003, 1003, 1,  68.0, now() - interval '45 minutes',  3)  -- a <120 recent HR
ON CONFLICT ("Id") DO UPDATE SET
    "DeviceId"          = EXCLUDED."DeviceId",
    "MeasurementTypeId" = EXCLUDED."MeasurementTypeId",
    "Value"             = EXCLUDED."Value",
    "RecordedAt"        = EXCLUDED."RecordedAt",
    "patientRef"        = EXCLUDED."patientRef";

-- Refresh planner stats so the cardinality guard / EXPLAIN see the seeded shape.
ANALYZE public."MeasurementsMock";
ANALYZE public."VisitMock";
ANALYZE public."PatientMock";
