"""live_bench_queries.py — the 10 benchmark queries for the 2026-07 exemplar-gen
+ prompt-steering matrix (docs/superpowers/specs/2026-07-10-*).

Each query pairs a natural-language question (as a user would type it) with a
REFERENCE SQL whose semantics define correctness, and a `compare_mode` telling
the harness how to compare the pipeline's executed result against the
reference's executed result (both run against the same staging data at the same
moment, so time-relative windows line up). Reference SQL is authored + validated
against staging (Shared schema); answers below are the values observed at
authoring time (they drift with live data — the harness recomputes, never
hardcodes).

compare_mode:
  - "scalar"      : result is a single number (count / value); equal within tolerance.
  - "value"       : result's first row carries the extreme value in column 0; compare that scalar.
  - "group_top"   : result is (key, count) groups; compare the SET of top-K keys (order-free).
  - "topk_keys"   : result is ranked rows; compare the SET of the top-K keys in column 0.
"""
from __future__ import annotations
from dataclasses import dataclass


@dataclass(frozen=True)
class BenchQuery:
    id: str
    question: str
    category: str
    reference_sql: str
    compare_mode: str
    interpretation: str


QUERIES: list[BenchQuery] = [
    BenchQuery(
        id="admitted_last_day",
        question="can you bring me patients admitted in the last day?",
        category="admissions",
        reference_sql='''SELECT count(DISTINCT a."PatientId") FROM "Shared"."Acceptances" a
            WHERE a."AcceptanceDate" >= now() - interval '1 day' ''',
        compare_mode="scalar",
        interpretation="distinct patients with an Acceptance in the last 24h",
    ),
    BenchQuery(
        id="admitted_3_to_7_days",
        question="give me the list of patients admitted more than 3 days ago (within the last week)",
        category="length_of_stay",
        reference_sql='''SELECT count(DISTINCT a."PatientId") FROM "Shared"."Acceptances" a
            WHERE a."AcceptanceDate" < now() - interval '3 days'
              AND a."AcceptanceDate" >= now() - interval '7 days' ''',
        compare_mode="scalar",
        interpretation="distinct patients admitted between 3 and 7 days ago",
    ),
    BenchQuery(
        id="worst_hr_last_day",
        question="get me the patient and vitals whose heart rate was worst (highest) in the last day",
        category="vitals_extreme",
        reference_sql='''SELECT mm."Value", a."PatientId" FROM "Shared"."MonitorMeasurements" mm
            JOIN "Shared"."Monitors" m ON mm."DeviceId"=m."Id"
            JOIN "Shared"."Acceptances" a ON m."AcceptanceId"=a."Id"
            WHERE mm."MeasurementTypeId"=2 AND m."MeasuredDate" >= now() - interval '1 day'
            ORDER BY mm."Value" DESC LIMIT 1''',
        compare_mode="value",
        interpretation="highest HR (MeasurementTypeId=2) value in the last 24h",
    ),
    BenchQuery(
        id="ventilated_patients",
        question="can you get me the list of ventilated patients?",
        category="ventilation_status",
        reference_sql='''SELECT count(DISTINCT a."PatientId") FROM "Shared"."VentilatorMeasurements" vm
            JOIN "Shared"."Ventilators" v ON vm."DeviceId"=v."Id"
            JOIN "Shared"."Acceptances" a ON v."AcceptanceId"=a."Id"
            WHERE v."MeasuredDate" >= now() - interval '1 day' ''',
        compare_mode="scalar",
        interpretation="distinct patients with a ventilator measurement in the last 24h",
    ),
    BenchQuery(
        id="bed_occupancy_per_unit",
        question="show me bed occupancy per unit right now",
        category="bed_occupancy",
        reference_sql='''SELECT b."UnitId", count(*) AS occupied FROM "Shared"."Beds" b
            WHERE b."PatientId" IS NOT NULL
            GROUP BY b."UnitId" ORDER BY occupied DESC LIMIT 5''',
        compare_mode="group_top",
        interpretation="count of occupied (PatientId not null) beds per unit",
    ),
    BenchQuery(
        id="patients_per_hospital",
        question="count of patients per hospital",
        category="org_rollup",
        reference_sql='''SELECT h."Id" AS hospital, count(DISTINCT a."PatientId") AS patients
            FROM "Shared"."Acceptances" a
            JOIN "Shared"."Units" u ON a."UnitId"=u."Id"
            JOIN "Shared"."Departments" d ON u."DepartmentId"=d."Id"
            JOIN "Shared"."Hospitals" h ON d."HospitalId"=h."Id"
            GROUP BY h."Id" ORDER BY patients DESC LIMIT 5''',
        compare_mode="group_top",
        interpretation="distinct patients per hospital via acceptance->unit->department->hospital",
    ),
    BenchQuery(
        id="avg_spo2_per_patient",
        question="average oxygen saturation per patient over the last 24 hours",
        category="vitals_trend",
        reference_sql='''SELECT count(*) FROM (
              SELECT a."PatientId", avg(mm."Value") FROM "Shared"."MonitorMeasurements" mm
              JOIN "Shared"."Monitors" m ON mm."DeviceId"=m."Id"
              JOIN "Shared"."Acceptances" a ON m."AcceptanceId"=a."Id"
              WHERE mm."MeasurementTypeId"=12 AND m."MeasuredDate" >= now() - interval '1 day'
              GROUP BY a."PatientId") s''',
        compare_mode="scalar",
        interpretation="number of patients having an avg SpO2 (type 12) in the last 24h",
    ),
    BenchQuery(
        id="no_measurement_last_6h",
        question="which admitted patients have no monitor measurement in the last 6 hours?",
        category="anti_join",
        reference_sql='''SELECT count(DISTINCT a."PatientId") FROM "Shared"."Acceptances" a
            JOIN "Shared"."Monitors" m ON m."AcceptanceId"=a."Id"
            WHERE NOT EXISTS (
              SELECT 1 FROM "Shared"."MonitorMeasurements" mm
              JOIN "Shared"."Monitors" m2 ON mm."DeviceId"=m2."Id"
              WHERE m2."AcceptanceId"=a."Id" AND m2."MeasuredDate" >= now() - interval '6 hours')''',
        compare_mode="scalar",
        interpretation="distinct patients with a monitor but no measurement in the last 6h",
    ),
    BenchQuery(
        id="longest_ventilated",
        question="who are the longest-ventilated patients?",
        category="ventilation_duration",
        reference_sql='''SELECT a."PatientId",
              extract(epoch FROM (max(v."MeasuredDate")-min(v."MeasuredDate")))/3600 AS span_h
            FROM "Shared"."Ventilators" v JOIN "Shared"."Acceptances" a ON v."AcceptanceId"=a."Id"
            GROUP BY a."PatientId" ORDER BY span_h DESC LIMIT 5''',
        compare_mode="topk_keys",
        interpretation="patients ranked by ventilator measurement span (max-min MeasuredDate)",
    ),
    BenchQuery(
        id="admissions_per_department_7d",
        question="how many admissions per department in the last 7 days?",
        category="dept_rollup",
        reference_sql='''SELECT d."Id" AS dept, count(*) AS admissions FROM "Shared"."Acceptances" a
            JOIN "Shared"."Units" u ON a."UnitId"=u."Id"
            JOIN "Shared"."Departments" d ON u."DepartmentId"=d."Id"
            WHERE a."AcceptanceDate" >= now() - interval '7 days'
            GROUP BY d."Id" ORDER BY admissions DESC LIMIT 5''',
        compare_mode="group_top",
        interpretation="count of Acceptances per department (via unit) in the last 7 days",
    ),
]
