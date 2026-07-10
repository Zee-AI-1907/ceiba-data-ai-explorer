"""test_output_scrub.py — PHI scrubber for arbitrary query-result samples.

Covers `scrub_output_sample`, the LOAD-BEARING SAFETY gate that decides which
cells of a generated query's result sample may be embedded and shipped to an
external LLM. It maps each OUTPUT column back through sqlglot lineage to its
source `(table, column)` and consults phiClass; anything it cannot prove safe
is replaced with the sentinel `"<suppressed>"`. Every test below builds `rows`
as literal dicts (simulating DB output) — no DB, no network.

`phi_columns` key format (see module docstring / Task 7):
    columnId "staging.Shared.Patients.Name"  ->  key "patients.name"
    (last two dot-segments of the columnId, BOTH lowercased, joined by ".")
"""

from __future__ import annotations

from prep.enrich.output_scrub import SUPPRESSED, scrub_output_sample

# Schema keyed by BARE table name -> {column: type}, for sqlglot qualify.
SCHEMA = {
    "Patients": {"Id": "INT", "Name": "TEXT"},
    "MonitorMeasurementTypes": {"Id": "INT", "Name": "TEXT", "PatientId": "INT"},
    "Vitals": {"Systolic": "INT", "Diastolic": "INT", "PatientId": "INT"},
}

PHI_COLUMNS = {
    "patients.id": "non-phi",
    "patients.name": "direct-identifier",
    "monitormeasurementtypes.id": "non-phi",
    "monitormeasurementtypes.name": "non-phi",
    "monitormeasurementtypes.patientid": "non-phi",
    "vitals.systolic": "non-phi",
    "vitals.diastolic": "non-phi",
    "vitals.patientid": "non-phi",
}


def test_a_direct_identifier_column_is_suppressed():
    """(a) A projection of a direct-identifier column is suppressed in EVERY row."""
    sql = 'SELECT p."Name" AS x FROM "Shared"."Patients" p'
    rows = [{"x": "Alice Alpha"}, {"x": "Bob Beta"}]
    out = scrub_output_sample(sql, rows, PHI_COLUMNS, SCHEMA)
    assert [r["x"] for r in out] == [SUPPRESSED, SUPPRESSED]


def test_b_aggregate_count_shows_actual_number():
    """(b) count(*) is aggregate → the actual number survives."""
    sql = 'SELECT count(*) AS n FROM "Shared"."Patients" p'
    rows = [{"n": 42}]
    out = scrub_output_sample(sql, rows, PHI_COLUMNS, SCHEMA)
    assert out == [{"n": 42}]


def test_c_non_phi_id_and_non_phi_label_both_survive():
    """(c) A non-phi id and a non-phi label both emit their real values."""
    sql = (
        'SELECT p."Id" AS pid, mt."Name" AS mtype '
        'FROM "Shared"."Patients" p '
        'JOIN "Shared"."MonitorMeasurementTypes" mt ON mt."PatientId" = p."Id"'
    )
    rows = [
        {"pid": 1, "mtype": "HeartRate"},
        {"pid": 2, "mtype": "SpO2"},
    ]
    out = scrub_output_sample(sql, rows, PHI_COLUMNS, SCHEMA)
    assert out == [
        {"pid": 1, "mtype": "HeartRate"},
        {"pid": 2, "mtype": "SpO2"},
    ]


def test_d_two_source_column_expression_is_suppressed():
    """(d) An expression over TWO source columns can't map to one cell → suppress."""
    sql = 'SELECT (v."Systolic" + v."Diastolic") AS z FROM "Shared"."Vitals" v'
    rows = [{"z": 200}, {"z": 190}]
    out = scrub_output_sample(sql, rows, PHI_COLUMNS, SCHEMA)
    assert [r["z"] for r in out] == [SUPPRESSED, SUPPRESSED]


def test_e_unknown_provenance_column_is_suppressed():
    """(e) A source column absent from phi_columns → fail closed → suppress."""
    # "Vitals.Diastolic" is intentionally removed from the phi map below.
    phi_without_diastolic = {
        k: v for k, v in PHI_COLUMNS.items() if k != "vitals.diastolic"
    }
    sql = 'SELECT v."Diastolic" AS d FROM "Shared"."Vitals" v'
    rows = [{"d": 80}, {"d": 85}]
    out = scrub_output_sample(sql, rows, phi_without_diastolic, SCHEMA)
    assert [r["d"] for r in out] == [SUPPRESSED, SUPPRESSED]


# ── Additional fail-closed guards (safety hardening beyond required set) ──────


def test_min_of_direct_identifier_is_suppressed():
    """min()/max() over a PHI column returns a REAL member cell → must suppress.

    A literal reading of "any aggregate is safe" would leak here: min("Name")
    is a real patient name, not a numeric summary. Only COUNT is unconditionally
    safe; other aggregates are safe only over non-phi columns.
    """
    sql = 'SELECT min(p."Name") AS earliest FROM "Shared"."Patients" p'
    rows = [{"earliest": "Alice Alpha"}]
    out = scrub_output_sample(sql, rows, PHI_COLUMNS, SCHEMA)
    assert out == [{"earliest": SUPPRESSED}]


def test_count_of_phi_column_is_safe():
    """count(Name) returns a cardinality, never a name → safe."""
    sql = 'SELECT count(p."Name") AS n FROM "Shared"."Patients" p'
    rows = [{"n": 7}]
    out = scrub_output_sample(sql, rows, PHI_COLUMNS, SCHEMA)
    assert out == [{"n": 7}]


def test_avg_of_non_phi_column_is_safe():
    """avg() over a non-phi numeric column is a genuine numeric summary → safe."""
    sql = 'SELECT avg(v."Systolic") AS a FROM "Shared"."Vitals" v'
    rows = [{"a": 123.4}]
    out = scrub_output_sample(sql, rows, PHI_COLUMNS, SCHEMA)
    assert out == [{"a": 123.4}]


def test_select_star_suppresses_all():
    """SELECT * — unknown output columns → suppress every cell."""
    sql = 'SELECT * FROM "Shared"."Patients" p'
    rows = [{"Id": 1, "Name": "Alice Alpha"}]
    out = scrub_output_sample(sql, rows, PHI_COLUMNS, SCHEMA)
    assert out == [{"Id": SUPPRESSED, "Name": SUPPRESSED}]


def test_sample_rows_truncation():
    """Only the first `sample_rows` rows are returned."""
    sql = 'SELECT p."Id" AS pid FROM "Shared"."Patients" p'
    rows = [{"pid": i} for i in range(10)]
    out = scrub_output_sample(sql, rows, PHI_COLUMNS, SCHEMA, sample_rows=3)
    assert out == [{"pid": 0}, {"pid": 1}, {"pid": 2}]


def test_unparseable_sql_suppresses_all():
    """A SQL string sqlglot can't parse → fail closed → suppress every cell."""
    sql = "this is not valid sql (((("
    rows = [{"a": 1, "b": 2}]
    out = scrub_output_sample(sql, rows, PHI_COLUMNS, SCHEMA)
    assert out == [{"a": SUPPRESSED, "b": SUPPRESSED}]


def test_unqualified_column_fails_closed_when_qualify_cannot_resolve():
    """An unqualified column that qualify can't bind (schema keyed by bare name,
    schema-qualified FROM) resolves to no table → fail closed → suppress."""
    sql = 'SELECT "Id" AS pid FROM "Shared"."Patients"'
    rows = [{"pid": 1}]
    out = scrub_output_sample(sql, rows, PHI_COLUMNS, SCHEMA)
    assert out == [{"pid": SUPPRESSED}]
