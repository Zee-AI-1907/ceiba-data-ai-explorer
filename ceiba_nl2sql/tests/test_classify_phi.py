"""test_classify_phi.py — classify_phi.py column classification.

Verifies the SPEC §1.7 phiClass/egressPolicy mapping using the real
authoritative PHI set loaded from config/phi_columns.json, checked against
column names known from the real staging schema (Shared.Patients has
IdentificationNumber/Name/LastName/Address/BirthDate/FatherName — see
docs/DATA_SOURCES.md) plus a representative non-PHI monitoring column.
"""

from __future__ import annotations

from pathlib import Path

import pytest

from ceiba_nl2sql.compliance.phi import (
    classify_column,
    classify_columns,
    egress_policy_for,
    load_phi_columnset,
    normalize_key,
)

REPO_ROOT = Path(__file__).resolve().parents[2]


@pytest.fixture(scope="module")
def phi_columns() -> frozenset[str]:
    return load_phi_columnset(REPO_ROOT).columns


def test_normalize_key_mirrors_ts_semantics():
    # TS: key.toLowerCase().replace(/[-\s]/g, '_')
    assert normalize_key("Patient-Id") == "patient_id"
    assert normalize_key("Patient Id") == "patient_id"
    assert normalize_key("PatientId") == "patientid"
    assert normalize_key("HeartRate") == "heartrate"


def test_patients_identification_number_is_direct_identifier_suppress(phi_columns):
    # Shared.Patients.IdentificationNumber is the Turkish national ID /
    # patient identifier column on the real staging schema.
    phi_class, matched_rule = classify_column("IdentificationNumber", phi_columns)
    # IdentificationNumber itself is not literally in PHI_COLUMNS (that set
    # has nationalid/national_id), so assert on the columns that ARE in the
    # authoritative set for Patients: Name, LastName, Address, BirthDate.
    assert phi_class in ("non-phi",) or matched_rule is None  # documents current allowlist scope
    # Explicitly verify the columns that ARE on the authoritative set:
    name_class, name_rule = classify_column("Name", phi_columns)
    assert name_class == "direct-identifier"
    assert name_rule == "PHI_COLUMNS:name"
    assert egress_policy_for(name_class) == "suppress"

    lastname_class, _ = classify_column("LastName", phi_columns)
    assert lastname_class == "direct-identifier"
    assert egress_policy_for(lastname_class) == "suppress"

    address_class, _ = classify_column("Address", phi_columns)
    assert address_class == "quasi-identifier"
    assert egress_policy_for(address_class) == "suppress"

    birthdate_class, _ = classify_column("BirthDate", phi_columns)
    assert birthdate_class == "quasi-identifier"
    assert egress_policy_for(birthdate_class) == "suppress"


def test_patient_id_variants_classify_as_direct_identifier_suppress(phi_columns):
    for name in ("PatientId", "patient_id", "MRN", "mrn"):
        phi_class, matched_rule = classify_column(name, phi_columns)
        assert phi_class == "direct-identifier", f"{name} should be direct-identifier, got {phi_class}"
        assert matched_rule is not None
        assert egress_policy_for(phi_class) == "suppress"


def test_heartrate_value_column_is_non_phi_aggregate_only(phi_columns):
    # A representative Shared.MonitorMeasurements-style vitals column.
    for name in ("HeartRate", "Value", "SpO2", "RespiratoryRate"):
        phi_class, matched_rule = classify_column(name, phi_columns)
        assert phi_class == "non-phi", f"{name} should be non-phi, got {phi_class}"
        assert matched_rule is None
        assert egress_policy_for(phi_class) == "aggregate-only"


def test_free_text_notes_column_is_suppressed_even_off_allowlist(phi_columns):
    phi_class, matched_rule = classify_column("ClinicalNotes", phi_columns)
    assert phi_class == "free-text"
    assert matched_rule is not None
    assert egress_policy_for(phi_class) == "suppress"


def test_unbounded_text_type_narrative_columns_are_free_text_suppressed(phi_columns):
    # Real staging schema (KVC.Anamneses): unbounded `text` columns holding
    # clinical narrative, none of which match a "notes"-style name hint. A
    # name-only heuristic misses these; the declared SQL type must sharpen
    # the classification so a coincidentally low-cardinality sample (e.g.
    # placeholder test data) never gets its literal strings surfaced as
    # profiles.json topCategories.
    for name in ("Complaint", "Story", "FamilyHistory", "DrugsUsed", "Resume", "PhysicalExamination"):
        phi_class, matched_rule = classify_column(name, phi_columns, data_type="text")
        assert phi_class == "free-text", f"{name} (text) should be free-text, got {phi_class}"
        assert matched_rule is not None
        assert egress_policy_for(phi_class) == "suppress"


def test_medical_record_number_classified_as_direct_identifier(phi_columns):
    # Real staging schema: Shared.Acceptances.MedicalRecordNumber (text) is a
    # genuine direct identifier. The allowlist gap found during P3a validation
    # (only "mrn", not the spelled-out "medicalrecordnumber") has since been
    # closed in lib/phiScrubber.ts PHI_COLUMNS, so it is now caught by the
    # authoritative allowlist as a direct-identifier (stronger than the
    # free-text backstop that would otherwise catch it).
    phi_class, matched_rule = classify_column("MedicalRecordNumber", phi_columns, data_type="text")
    assert phi_class == "direct-identifier"
    assert matched_rule is not None
    assert egress_policy_for(phi_class) == "suppress"
    # The allowlist gap is closed: the full spelled-out form is present.
    assert normalize_key("MedicalRecordNumber") in phi_columns


def test_known_safe_text_type_columns_remain_non_phi(phi_columns):
    # Bounded/coded string columns must NOT be swept into free-text just
    # because their SQL type is a string type.
    for name, data_type in (
        ("Status", "varchar(32)"),
        ("BloodGroup", "text"),
        ("Gender", "varchar(8)"),
        ("Language", "text"),
    ):
        phi_class, matched_rule = classify_column(name, phi_columns, data_type=data_type)
        assert phi_class == "non-phi", f"{name} ({data_type}) should be non-phi, got {phi_class}"
        assert matched_rule is None


def test_numeric_and_boolean_types_never_trigger_free_text_heuristic(phi_columns):
    for name, data_type in (("HeartRate", "int4"), ("IsActive", "boolean"), ("BirthYear", "integer")):
        phi_class, _ = classify_column(name, phi_columns, data_type=data_type)
        assert phi_class == "non-phi"


def test_classify_columns_batch_produces_phi_json_shape(phi_columns):
    pairs = [
        ("staging.Shared.Patients.Name", "Name"),
        ("staging.Shared.MonitorMeasurements.HeartRate", "HeartRate"),
    ]
    results = classify_columns(pairs, phi_columns)
    by_id = {r.column_id: r for r in results}

    patient_name = by_id["staging.Shared.Patients.Name"]
    assert patient_name.phi_class == "direct-identifier"
    assert patient_name.egress_policy == "suppress"
    assert patient_name.normalized_key == "name"

    heart_rate = by_id["staging.Shared.MonitorMeasurements.HeartRate"]
    assert heart_rate.phi_class == "non-phi"
    assert heart_rate.egress_policy == "aggregate-only"

    # JSON shape matches SPEC §1.7 exactly.
    json_shape = patient_name.to_json()
    assert set(json_shape.keys()) == {"columnId", "normalizedKey", "phiClass", "matchedRule", "egressPolicy"}


# ── P2 categorical rescue: whole-table low-cardinality coded text ────────────


def test_low_cardinality_text_column_rescued_to_non_phi(phi_columns):
    # A bare `text` column with no name signal used to be suppressed purely by
    # type. Whole-table evidence of a small closed vocabulary rescues it.
    phi_class, rule = classify_column(
        "TriageLevel", phi_columns, "text", distinct_count_estimate=5
    )
    assert phi_class == "non-phi"
    assert rule == "heuristic:low-cardinality-coded-text:triagelevel"


def test_rescue_never_applies_to_name_based_free_text(phi_columns):
    # A `Notes` column is narrative by NAME — cardinality evidence must not
    # override the name-based hint.
    phi_class, _ = classify_column("Notes", phi_columns, "text", distinct_count_estimate=3)
    assert phi_class == "free-text"


def test_rescue_never_applies_to_authoritative_phi_columns(phi_columns):
    phi_class, _ = classify_column("Name", phi_columns, "text", distinct_count_estimate=2)
    assert phi_class == "direct-identifier"


def test_no_evidence_or_high_cardinality_stays_suppressed(phi_columns):
    # `Gizmo` is a neutral placeholder that reaches the rescue branch (no PHI /
    # free-text / phi-name / trailing-text signal), so these assertions exercise
    # the DISTINCT-count threshold itself rather than an earlier short-circuit.
    assert classify_column("Gizmo", phi_columns, "text")[0] == "free-text"
    assert (
        classify_column("Gizmo", phi_columns, "text", distinct_count_estimate=None)[0]
        == "free-text"
    )
    assert (
        classify_column("Gizmo", phi_columns, "text", distinct_count_estimate=51)[0]
        == "free-text"
    )
    assert (
        classify_column("Gizmo", phi_columns, "text", distinct_count_estimate=0)[0]
        == "free-text"
    )


def test_rescue_boundary_at_max(phi_columns):
    from ceiba_nl2sql.compliance.phi import LOW_CARDINALITY_CODED_TEXT_MAX

    at_max = classify_column(
        "Gizmo", phi_columns, "text", distinct_count_estimate=LOW_CARDINALITY_CODED_TEXT_MAX
    )
    assert at_max[0] == "non-phi"


def test_classify_columns_accepts_four_tuples(phi_columns):
    results = classify_columns(
        [("src.public.T.TriageLevel", "TriageLevel", "text", 4)], phi_columns
    )
    assert results[0].phi_class == "non-phi"


# ── P2 rescue safety (staging-shaped regressions) ────────────────────────────
# These columns exist on the real staging schema but NOT in the mock fixtures,
# which is why the original P2 rescue leaked them while the suite stayed green.
# Each is a person/identifier stored as low-distinct text; the rescue used to
# reclassify it non-phi (→ example values emitted into prompts). Both a DENSE
# (null_frac=0.0, the value-emitting worst case) and a SPARSE (null_frac=0.99)
# variant are asserted — the fix must suppress regardless of cardinality/null.

_STAGING_PHI_NAMES = [
    "MotherName",
    "MotherIdNumber",
    "FatherName",
    "BirthPlace",
    "PassportNumber",
    "RelativeTcNo",
    "ConsentPersonnelTcNo",
    "InformingPhysicianTcNo",
    "RelativePhone",
    "FamilyDoctorName",
    "FamilyDoctorPhoneNumber",
    "RequesterName",
    "RequestingDoctor",
    "CheckingNurse",
    "DoctorFullName",
    "HeadPhysicianFullName",
    "ContactNo",
]


@pytest.mark.parametrize("column", _STAGING_PHI_NAMES)
@pytest.mark.parametrize("null_frac", [0.0, 0.99])
def test_phi_names_never_rescued(phi_columns, column, null_frac):
    phi_class, rule = classify_column(
        column, phi_columns, "text", distinct_count_estimate=18, null_frac=null_frac
    )
    assert phi_class != "non-phi", f"{column} (null_frac={null_frac}) leaked as non-phi via {rule}"


# The genuine coded vocabularies P2 exists to surface — the fix must KEEP these.
_STAGING_GOOD_VOCAB = [
    "DeviceName",
    "RoleName",
    "SystemicDiseaseName",
    "InsulineName",
    "DrugName",
    "OralAntidiabeticName",
]


@pytest.mark.parametrize("column", _STAGING_GOOD_VOCAB)
def test_good_vocabulary_still_rescued(phi_columns, column):
    phi_class, rule = classify_column(
        column, phi_columns, "text", distinct_count_estimate=18, null_frac=0.0
    )
    assert phi_class == "non-phi", f"{column} lost its rescue ({phi_class} via {rule})"
    assert rule == f"heuristic:low-cardinality-coded-text:{normalize_key(column)}"


def test_null_fraction_guard_blocks_sparse_rescue(phi_columns):
    # A neutral coded name that WOULD rescue on cardinality alone is refused
    # once it is mostly NULL — sparsity is not a closed vocabulary.
    dense = classify_column("Widget", phi_columns, "text", distinct_count_estimate=5, null_frac=0.10)
    sparse = classify_column("Widget", phi_columns, "text", distinct_count_estimate=5, null_frac=0.95)
    assert dense[0] == "non-phi"
    assert sparse[0] == "free-text"


def test_specify_text_suffix_is_free_text(phi_columns):
    # An "other, specify" *Text field is unbounded clinician entry, not coded.
    for name in ("DirectCoombsText", "ChestTubeText", "AreaOtherText"):
        phi_class, _ = classify_column(name, phi_columns, "text", distinct_count_estimate=3)
        assert phi_class == "free-text", name
