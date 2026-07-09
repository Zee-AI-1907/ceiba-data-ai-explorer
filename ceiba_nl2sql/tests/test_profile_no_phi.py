"""test_profile_no_phi.py — profile.py PHI-suppression + shape guarantees.

Mirrors the guarantees `lib/phiScrubber.ts` `buildAggregateProfile` tests
assert, translated to the Python `sample_aggregate_from_rows` reducer:
  * A PHI column -> kind="phi-suppressed", counts only, NEVER a value.
  * A numeric column -> kind="numeric" with min/max/mean, no topCategories.
  * A low-cardinality NON-PHI column -> up to 8 top category labels.
  * A high-cardinality NON-PHI column (> HIGH_CARDINALITY_ABSOLUTE=20) ->
    counts only, no topCategories (could be an identifier).

No real database connection is required — these tests exercise the
DB-agnostic reducer directly with synthetic in-memory rows.
"""

from __future__ import annotations

from ceiba_nl2sql.compliance.aggregate_profile import (
    HIGH_CARDINALITY_ABSOLUTE,
    MAX_TOP_CATEGORIES,
    ProfileColumn,
    sample_aggregate_from_rows,
)

PHI_COLUMNS = frozenset({"patientid", "name", "lastname", "address", "birthdate"})


def _column_by_key(profile, key: str):
    for col in profile.columns:
        if col.key == key:
            return col
    raise AssertionError(f"no column {key!r} in profile")


def test_phi_column_is_suppressed_never_a_value():
    rows = [
        {"PatientId": "MRN-0001", "HeartRate": 72},
        {"PatientId": "MRN-0002", "HeartRate": 88},
        {"PatientId": "MRN-0003", "HeartRate": 95},
    ]
    columns = [
        ProfileColumn(key="PatientId", label="PatientId", type="text"),
        ProfileColumn(key="HeartRate", label="HeartRate", type="int4"),
    ]
    profile = sample_aggregate_from_rows(rows, columns, PHI_COLUMNS)

    patient_id_col = _column_by_key(profile, "PatientId")
    assert patient_id_col.kind == "phi-suppressed"
    assert patient_id_col.non_null_count == 3
    assert patient_id_col.distinct_count == 3
    # NEVER a value: no min/max/mean, no topCategories on a suppressed column.
    assert patient_id_col.min is None
    assert patient_id_col.max is None
    assert patient_id_col.mean is None
    assert patient_id_col.top_categories is None

    # Serialized JSON must not contain any raw MRN string either.
    serialized = patient_id_col.to_json()
    assert "MRN-0001" not in str(serialized)
    assert "MRN-0002" not in str(serialized)
    assert set(serialized.keys()) == {"key", "label", "type", "kind", "nonNullCount", "distinctCount"}


def test_low_cardinality_identifier_is_suppressed_not_emitted():
    """Regression for the P2 staging leak (classify→emit seam).

    `MotherName`/`MotherIdNumber` on the real schema are dense (0% null) and
    low-distinct — the OLD rescue reclassified them non-phi, so the reducer
    emitted up to 8 real names + national IDs as `topCategories`. The whole
    reason this went unnoticed is the mock fixtures have no such column. Feed
    the reducer that exact shape (with the whole-table evidence that used to
    trigger the rescue) and assert it is phi-suppressed with NO values emitted.
    """
    rows = [
        {"MotherName": "Ayşe Yılmaz", "MotherIdNumber": "12345678901"},
        {"MotherName": "Fatma Demir", "MotherIdNumber": "23456789012"},
        {"MotherName": "Zeynep Kaya", "MotherIdNumber": "34567890123"},
    ]
    columns = [
        # distinct_count_estimate + null_frac are exactly the whole-table
        # evidence that used to flip these to non-phi via the rescue.
        ProfileColumn(key="MotherName", label="MotherName", type="text",
                      distinct_count_estimate=18, null_frac=0.0),
        ProfileColumn(key="MotherIdNumber", label="MotherIdNumber", type="text",
                      distinct_count_estimate=18, null_frac=0.0),
    ]
    profile = sample_aggregate_from_rows(rows, columns, PHI_COLUMNS)

    for key in ("MotherName", "MotherIdNumber"):
        col = _column_by_key(profile, key)
        assert col.kind == "phi-suppressed", f"{key} was not suppressed"
        assert col.top_categories is None, f"{key} emitted topCategories"
    # No raw name or ID string may appear anywhere in the serialized profile.
    blob = str(profile.to_json())
    for leaked in ("Ayşe", "Yılmaz", "Fatma", "12345678901", "23456789012"):
        assert leaked not in blob, f"leaked {leaked!r}"


def test_numeric_column_emits_min_max_mean_only():
    rows = [{"HeartRate": v} for v in (60, 70, 80, 90, 100)]
    columns = [ProfileColumn(key="HeartRate", label="HeartRate", type="int4")]
    profile = sample_aggregate_from_rows(rows, columns, PHI_COLUMNS)

    hr = _column_by_key(profile, "HeartRate")
    assert hr.kind == "numeric"
    assert hr.min == 60
    assert hr.max == 100
    assert hr.mean == 80.0
    assert hr.top_categories is None


def test_low_cardinality_non_phi_gets_top_categories_capped_at_eight():
    # 10 distinct-ish inputs collapsing into 3 categories, well under the
    # HIGH_CARDINALITY_ABSOLUTE=20 ceiling.
    rows = (
        [{"Status": "Active"}] * 5
        + [{"Status": "Discharged"}] * 3
        + [{"Status": "Pending"}] * 2
    )
    columns = [ProfileColumn(key="Status", label="Status", type="text")]
    profile = sample_aggregate_from_rows(rows, columns, PHI_COLUMNS)

    status = _column_by_key(profile, "Status")
    assert status.kind == "categorical"
    assert status.distinct_count == 3
    assert status.top_categories is not None
    assert len(status.top_categories) <= MAX_TOP_CATEGORIES
    values = {c.value: c.count for c in status.top_categories}
    assert values == {"Active": 5, "Discharged": 3, "Pending": 2}


def test_high_cardinality_non_phi_suppresses_labels_counts_only():
    # 25 distinct values > HIGH_CARDINALITY_ABSOLUTE (20) -> no topCategories,
    # even though the column itself is not on the PHI allowlist (could be an
    # identifier-like column). Declared type is a bounded "code" type (not
    # unbounded text) and the name matches a known-safe hint ("code"), so this
    # exercises the cardinality-ceiling branch in isolation from the separate
    # unbounded-free-text-type heuristic (see test_classify_phi.py for that).
    rows = [{"ExternalRefCode": f"REF-{i}"} for i in range(HIGH_CARDINALITY_ABSOLUTE + 5)]
    columns = [ProfileColumn(key="ExternalRefCode", label="ExternalRefCode", type="varchar(16)")]
    profile = sample_aggregate_from_rows(rows, columns, PHI_COLUMNS)

    ref = _column_by_key(profile, "ExternalRefCode")
    assert ref.kind == "categorical"
    assert ref.distinct_count == HIGH_CARDINALITY_ABSOLUTE + 5
    assert ref.top_categories is None

    serialized = ref.to_json()
    assert "topCategories" not in serialized
    for i in range(HIGH_CARDINALITY_ABSOLUTE + 5):
        assert f"REF-{i}" not in str(serialized)


def test_phi_column_cardinality_counted_but_never_labeled_even_low_card():
    # Even a LOW-cardinality PHI column (e.g. a small enum-like PHI field)
    # must never surface topCategories — PHI suppression wins over the
    # low-cardinality allowance.
    rows = [{"BirthDate": "1990-01-01"}] * 3 + [{"BirthDate": "1985-06-15"}] * 2
    columns = [ProfileColumn(key="BirthDate", label="BirthDate", type="date")]
    profile = sample_aggregate_from_rows(rows, columns, PHI_COLUMNS)

    birth_date = _column_by_key(profile, "BirthDate")
    assert birth_date.kind == "phi-suppressed"
    assert birth_date.distinct_count == 2
    assert birth_date.top_categories is None
    serialized = birth_date.to_json()
    assert "1990-01-01" not in str(serialized)
    assert "1985-06-15" not in str(serialized)


def test_null_and_empty_values_excluded_from_non_null_count():
    rows = [{"Value": 1}, {"Value": None}, {"Value": ""}, {"Value": 2}]
    columns = [ProfileColumn(key="Value", label="Value", type="int4")]
    profile = sample_aggregate_from_rows(rows, columns, PHI_COLUMNS)

    value_col = _column_by_key(profile, "Value")
    assert value_col.non_null_count == 2


def test_max_sample_rows_bounds_the_scan():
    rows = [{"HeartRate": i} for i in range(10_000)]
    columns = [ProfileColumn(key="HeartRate", label="HeartRate", type="int4")]
    profile = sample_aggregate_from_rows(rows, columns, PHI_COLUMNS, max_sample_rows=100)

    assert profile.sampled_rows == 100
    assert profile.total_rows == 10_000


# ── P2 categorical rescue in the reducer ─────────────────────────────────────


def test_low_cardinality_text_column_rescued_with_whole_table_evidence():
    rows = [{"TriageLevel": v} for v in ("red", "yellow", "green", "red", "green")]
    columns = [
        ProfileColumn(key="TriageLevel", label="TriageLevel", type="text", distinct_count_estimate=3)
    ]
    profile = sample_aggregate_from_rows(rows, columns, PHI_COLUMNS)
    col = _column_by_key(profile, "TriageLevel")
    assert col.kind == "categorical"
    assert col.top_categories is not None
    assert {c.value for c in col.top_categories} == {"red", "yellow", "green"}


def test_text_column_without_evidence_stays_suppressed():
    # Same rows, but no whole-table distinct evidence -> the type heuristic
    # fails closed exactly as before the rescue existed.
    rows = [{"TriageLevel": v} for v in ("red", "yellow", "green")]
    columns = [ProfileColumn(key="TriageLevel", label="TriageLevel", type="text")]
    profile = sample_aggregate_from_rows(rows, columns, PHI_COLUMNS)
    col = _column_by_key(profile, "TriageLevel")
    assert col.kind == "phi-suppressed"
    assert col.top_categories is None


def test_rescued_column_with_sample_cardinality_above_20_gets_counts_only():
    # Whole-table evidence rescues classification (<=50), but the emitted
    # topCategories discipline (<=20 distinct in sample, TS-mirrored) still
    # applies — a 21..50-distinct vocabulary gets kind=categorical, no labels.
    rows = [{"Code": f"code-{i}"} for i in range(25)]
    columns = [ProfileColumn(key="Code", label="Code", type="text", distinct_count_estimate=25)]
    profile = sample_aggregate_from_rows(rows, columns, PHI_COLUMNS)
    col = _column_by_key(profile, "Code")
    assert col.kind == "categorical"
    assert col.top_categories is None
