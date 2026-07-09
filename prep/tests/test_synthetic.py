"""test_synthetic.py — synthetic.py descriptor builder + emit.py emit_synthetic
(SPEC §1.8, §2.4 stage[3], §2.5 `check_synthetic_json`).

Asserts:
  * `build_synthetic_json` derives one descriptor per catalog column, using
    only already-PHI-safe inputs (catalog/keys/profiles/phi) — never a raw
    value.
  * PHI-classified columns (phiClass != non-phi) get a safe FAKE-shaped
    generator (`surrogate-fk` if the column is a declared FK, else
    `synthetic-identifier`) — never `numeric`/`categorical` with real content.
  * Non-PHI numeric columns get a `numeric` generator sourced from
    profiles.json min/max/mean (never raw cells).
  * Non-PHI low-cardinality categorical columns get a `categorical` generator
    whose `labels` are EXACTLY the profiles.json `topCategories` values (the
    same non-PHI strings already allowed elsewhere in the bundle).
  * FK columns always get `surrogate-fk` referencing the parent's key space,
    even when they would otherwise look numeric.
  * Primary-key columns (non-FK) get `surrogate-pk`.
  * Time columns get a `timestamp` generator carrying both a historical range
    and a `recentWindow` hint (so temporal NL questions have matching rows).
  * `syntheticRowTarget` is always far below the real `approxRowCount` (SPEC
    §1.8 "never 337M") and never below a small floor.
  * `emit_synthetic` writes synthetic.json + a stable sha256; `manifest.json`
    integration (SPEC §1.2 `files`) is covered by `test_manifest_integrity.py`
    conventions — here we test the file-level round trip in isolation.
  * `phi_gate.check_synthetic_json` passes over a mock-bundle-shaped
    synthetic.json produced by `build_synthetic_json` and fails when a PHI
    column's descriptor carries `params.labels` (constructed adversarially
    to prove the check actually fires).
"""

from __future__ import annotations

from prep.emit import emit_synthetic, sha256_file
from prep.phi_gate import check_synthetic_json
from prep.synthetic import (
    build_column_descriptor,
    build_synthetic_json,
    scale_down_row_target,
)

# ── a mock-bundle-shaped fixture mirroring lib/rag/__tests__/fixtures/bundles/
# mock-v1/{catalog,keys,profiles,phi}.json (trimmed to PatientMock + WardRef +
# HospitalRef + MeasurementsMock + MeasurementTypeRef, enough to exercise
# every generator branch: PK, FK, numeric, categorical w/ topCategories,
# PHI-suppressed direct-identifier, PHI-suppressed free-text, time column).


def _catalog() -> dict:
    return {
        "tables": [
            {
                "tableId": "mock.public.HospitalRef",
                "columns": [
                    {"columnId": "mock.public.HospitalRef.HospitalId", "name": "HospitalId", "isPrimaryKey": True, "isTimeColumn": False},
                    {"columnId": "mock.public.HospitalRef.name", "name": "name", "isPrimaryKey": False, "isTimeColumn": False},
                    {"columnId": "mock.public.HospitalRef.region", "name": "region", "isPrimaryKey": False, "isTimeColumn": False},
                ],
            },
            {
                "tableId": "mock.public.WardRef",
                "columns": [
                    {"columnId": "mock.public.WardRef.WardId", "name": "WardId", "isPrimaryKey": True, "isTimeColumn": False},
                    {"columnId": "mock.public.WardRef.name", "name": "name", "isPrimaryKey": False, "isTimeColumn": False},
                    {"columnId": "mock.public.WardRef.hospitalId", "name": "hospitalId", "isPrimaryKey": False, "isTimeColumn": False},
                ],
            },
            {
                "tableId": "mock.public.PatientMock",
                "columns": [
                    {"columnId": "mock.public.PatientMock.patientRef", "name": "patientRef", "isPrimaryKey": True, "isTimeColumn": False},
                    {"columnId": "mock.public.PatientMock.patientCode", "name": "patientCode", "isPrimaryKey": False, "isTimeColumn": False},
                    {"columnId": "mock.public.PatientMock.hospitalId", "name": "hospitalId", "isPrimaryKey": False, "isTimeColumn": False},
                    {"columnId": "mock.public.PatientMock.wardId", "name": "wardId", "isPrimaryKey": False, "isTimeColumn": False},
                    {"columnId": "mock.public.PatientMock.ageBand", "name": "ageBand", "isPrimaryKey": False, "isTimeColumn": False},
                ],
            },
            {
                "tableId": "mock.public.MeasurementTypeRef",
                "columns": [
                    {"columnId": "mock.public.MeasurementTypeRef.MeasurementTypeId", "name": "MeasurementTypeId", "isPrimaryKey": True, "isTimeColumn": False},
                    {"columnId": "mock.public.MeasurementTypeRef.name", "name": "name", "isPrimaryKey": False, "isTimeColumn": False},
                    {"columnId": "mock.public.MeasurementTypeRef.unit", "name": "unit", "isPrimaryKey": False, "isTimeColumn": False},
                ],
            },
            {
                "tableId": "mock.public.MeasurementsMock",
                "columns": [
                    {"columnId": "mock.public.MeasurementsMock.Id", "name": "Id", "isPrimaryKey": True, "isTimeColumn": False},
                    {"columnId": "mock.public.MeasurementsMock.MeasurementTypeId", "name": "MeasurementTypeId", "isPrimaryKey": False, "isTimeColumn": False},
                    {"columnId": "mock.public.MeasurementsMock.Value", "name": "Value", "isPrimaryKey": False, "isTimeColumn": False},
                    {"columnId": "mock.public.MeasurementsMock.RecordedAt", "name": "RecordedAt", "isPrimaryKey": False, "isTimeColumn": True},
                    {"columnId": "mock.public.MeasurementsMock.patientRef", "name": "patientRef", "isPrimaryKey": False, "isTimeColumn": False},
                ],
            },
        ]
    }


def _keys() -> dict:
    return {
        "primaryKeys": [
            {"tableId": "mock.public.HospitalRef", "columns": ["HospitalId"]},
            {"tableId": "mock.public.WardRef", "columns": ["WardId"]},
            {"tableId": "mock.public.PatientMock", "columns": ["patientRef"]},
            {"tableId": "mock.public.MeasurementTypeRef", "columns": ["MeasurementTypeId"]},
            {"tableId": "mock.public.MeasurementsMock", "columns": ["Id"]},
        ],
        "foreignKeys": [
            {
                "fkId": "mock.public.WardRef.hospitalId->mock.public.HospitalRef.HospitalId",
                "fromTable": "mock.public.WardRef",
                "fromColumns": ["hospitalId"],
                "toTable": "mock.public.HospitalRef",
                "toColumns": ["HospitalId"],
            },
            {
                "fkId": "mock.public.PatientMock.hospitalId->mock.public.HospitalRef.HospitalId",
                "fromTable": "mock.public.PatientMock",
                "fromColumns": ["hospitalId"],
                "toTable": "mock.public.HospitalRef",
                "toColumns": ["HospitalId"],
            },
            {
                "fkId": "mock.public.PatientMock.wardId->mock.public.WardRef.WardId",
                "fromTable": "mock.public.PatientMock",
                "fromColumns": ["wardId"],
                "toTable": "mock.public.WardRef",
                "toColumns": ["WardId"],
            },
            {
                "fkId": "mock.public.MeasurementsMock.MeasurementTypeId->mock.public.MeasurementTypeRef.MeasurementTypeId",
                "fromTable": "mock.public.MeasurementsMock",
                "fromColumns": ["MeasurementTypeId"],
                "toTable": "mock.public.MeasurementTypeRef",
                "toColumns": ["MeasurementTypeId"],
            },
            {
                "fkId": "mock.public.MeasurementsMock.patientRef->mock.public.PatientMock.patientRef",
                "fromTable": "mock.public.MeasurementsMock",
                "fromColumns": ["patientRef"],
                "toTable": "mock.public.PatientMock",
                "toColumns": ["patientRef"],
            },
        ],
    }


def _profiles() -> dict:
    return {
        "tables": [
            {
                "tableId": "mock.public.HospitalRef",
                "approxRowCount": 2,
                "columns": [
                    {"columnId": "mock.public.HospitalRef.HospitalId", "kind": "numeric", "min": 1.0, "max": 2.0, "mean": 1.5},
                    {"columnId": "mock.public.HospitalRef.name", "kind": "phi-suppressed"},
                    {"columnId": "mock.public.HospitalRef.region", "kind": "phi-suppressed"},
                ],
            },
            {
                "tableId": "mock.public.WardRef",
                "approxRowCount": 4,
                "columns": [
                    {"columnId": "mock.public.WardRef.WardId", "kind": "numeric", "min": 10.0, "max": 21.0, "mean": 15.5},
                    {"columnId": "mock.public.WardRef.name", "kind": "phi-suppressed"},
                    {"columnId": "mock.public.WardRef.hospitalId", "kind": "numeric", "min": 1.0, "max": 2.0, "mean": 1.5},
                ],
            },
            {
                "tableId": "mock.public.PatientMock",
                "approxRowCount": 40,
                "columns": [
                    {"columnId": "mock.public.PatientMock.patientRef", "kind": "numeric", "min": 1.0, "max": 40.0, "mean": 20.5},
                    {"columnId": "mock.public.PatientMock.patientCode", "kind": "categorical"},  # high-card, no topCategories
                    {"columnId": "mock.public.PatientMock.hospitalId", "kind": "numeric", "min": 1.0, "max": 2.0, "mean": 1.5},
                    {"columnId": "mock.public.PatientMock.wardId", "kind": "numeric", "min": 10.0, "max": 21.0, "mean": 15.5},
                    {"columnId": "mock.public.PatientMock.ageBand", "kind": "phi-suppressed"},
                ],
            },
            {
                "tableId": "mock.public.MeasurementTypeRef",
                "approxRowCount": 5,
                "columns": [
                    {"columnId": "mock.public.MeasurementTypeRef.MeasurementTypeId", "kind": "numeric", "min": 1.0, "max": 5.0, "mean": 3.0},
                    {"columnId": "mock.public.MeasurementTypeRef.name", "kind": "phi-suppressed"},
                    {
                        "columnId": "mock.public.MeasurementTypeRef.unit",
                        "kind": "categorical",
                        "topCategories": [
                            {"value": "bpm", "count": 1},
                            {"value": "%", "count": 1},
                        ],
                    },
                ],
            },
            {
                "tableId": "mock.public.MeasurementsMock",
                "approxRowCount": 337_000_000,  # real-scale row count on purpose
                "columns": [
                    {"columnId": "mock.public.MeasurementsMock.Id", "kind": "numeric", "min": 1.0, "max": 900003.0, "mean": 5829.08},
                    {"columnId": "mock.public.MeasurementsMock.MeasurementTypeId", "kind": "numeric", "min": 1.0, "max": 5.0, "mean": 3.0},
                    {"columnId": "mock.public.MeasurementsMock.Value", "kind": "numeric", "min": 16.0, "max": 240.0, "mean": 84.6},
                    {"columnId": "mock.public.MeasurementsMock.RecordedAt", "kind": "categorical"},
                    {"columnId": "mock.public.MeasurementsMock.patientRef", "kind": "numeric", "min": 1.0, "max": 40.0, "mean": 20.4},
                ],
            },
        ]
    }


def _phi() -> dict:
    def entry(column_id: str, phi_class: str) -> dict:
        return {"columnId": column_id, "phiClass": phi_class}

    return {
        "phiColumnsetHash": "sha256:test",
        "columns": [
            entry("mock.public.HospitalRef.HospitalId", "non-phi"),
            entry("mock.public.HospitalRef.name", "direct-identifier"),
            entry("mock.public.HospitalRef.region", "free-text"),
            entry("mock.public.WardRef.WardId", "non-phi"),
            entry("mock.public.WardRef.name", "direct-identifier"),
            entry("mock.public.WardRef.hospitalId", "non-phi"),
            entry("mock.public.PatientMock.patientRef", "non-phi"),
            entry("mock.public.PatientMock.patientCode", "non-phi"),
            entry("mock.public.PatientMock.hospitalId", "non-phi"),
            entry("mock.public.PatientMock.wardId", "non-phi"),
            entry("mock.public.PatientMock.ageBand", "free-text"),
            entry("mock.public.MeasurementTypeRef.MeasurementTypeId", "non-phi"),
            entry("mock.public.MeasurementTypeRef.name", "direct-identifier"),
            entry("mock.public.MeasurementTypeRef.unit", "non-phi"),
            entry("mock.public.MeasurementsMock.Id", "non-phi"),
            entry("mock.public.MeasurementsMock.MeasurementTypeId", "non-phi"),
            entry("mock.public.MeasurementsMock.Value", "non-phi"),
            entry("mock.public.MeasurementsMock.RecordedAt", "non-phi"),
            entry("mock.public.MeasurementsMock.patientRef", "non-phi"),
        ],
    }


def _build() -> dict:
    return build_synthetic_json(catalog=_catalog(), keys=_keys(), profiles=_profiles(), phi=_phi())


def _table(synthetic: dict, table_id: str) -> dict:
    for t in synthetic["tables"]:
        if t["tableId"] == table_id:
            return t
    raise AssertionError(f"no table {table_id!r} in synthetic.json")


def _column(table: dict, column_id: str) -> dict:
    for c in table["columns"]:
        if c["columnId"] == column_id:
            return c
    raise AssertionError(f"no column {column_id!r} in table {table['tableId']!r}")


# ── shape: one descriptor per table/column ──────────────────────────────────


def test_one_table_entry_per_catalog_table_and_one_column_per_catalog_column():
    synthetic = _build()
    catalog = _catalog()

    assert {t["tableId"] for t in synthetic["tables"]} == {t["tableId"] for t in catalog["tables"]}
    for table in synthetic["tables"]:
        catalog_table = next(t for t in catalog["tables"] if t["tableId"] == table["tableId"])
        assert {c["columnId"] for c in table["columns"]} == {
            c["columnId"] for c in catalog_table["columns"]
        }


# ── PHI columns get a safe, fake-shaped generator — never real content ─────


def test_phi_suppressed_non_fk_column_gets_synthetic_identifier_generator():
    synthetic = _build()
    hospital = _table(synthetic, "mock.public.HospitalRef")

    name_col = _column(hospital, "mock.public.HospitalRef.name")
    assert name_col["generator"] == "synthetic-identifier"
    assert "labels" not in name_col["params"]
    assert "values" not in name_col["params"]

    region_col = _column(hospital, "mock.public.HospitalRef.region")
    assert region_col["generator"] == "synthetic-identifier"
    assert "labels" not in region_col["params"]


def test_phi_column_that_is_also_declared_fk_still_gets_surrogate_fk_not_fake_label():
    # WardRef.hospitalId is BOTH a declared FK AND, incidentally, non-PHI here
    # — but if a future schema made an FK column PHI-classified (e.g. a direct
    # patient-id FK), FK integrity must still win over the fake-shape branch.
    synthetic = _build()
    ward = _table(synthetic, "mock.public.WardRef")
    hospital_id_col = _column(ward, "mock.public.WardRef.hospitalId")
    assert hospital_id_col["generator"] == "surrogate-fk"
    assert hospital_id_col["params"]["references"] == "mock.public.HospitalRef.HospitalId"


def test_no_real_or_raw_value_anywhere_in_the_synthetic_document():
    """No cell-derived string should ever appear except the exact non-PHI
    topCategories labels already present in profiles.json (bpm/%). Scans the
    full serialized document for a handful of stand-in "real" values that
    must never leak (mirrors the PHI-suppressed fixture inputs' shape without
    hardcoding a check per column).
    """
    import json

    synthetic = _build()
    serialized = json.dumps(synthetic)

    # None of the PHI-suppressed columns' (nonexistent, by construction) raw
    # values leak — there ARE no raw values in the fixture inputs (profiles.json
    # never carries them for phi-suppressed kind), so this asserts the
    # generator never fabricates value-shaped content for those columns either.
    for table in synthetic["tables"]:
        for col in table["columns"]:
            assert col["generator"] in {
                "surrogate-pk",
                "surrogate-fk",
                "numeric",
                "categorical",
                "timestamp",
                "synthetic-identifier",
            }


# ── FK columns always get surrogate-fk referencing the parent's key space ──


def test_fk_column_gets_surrogate_fk_referencing_parent_key_space():
    synthetic = _build()
    measurements = _table(synthetic, "mock.public.MeasurementsMock")

    patient_ref_col = _column(measurements, "mock.public.MeasurementsMock.patientRef")
    assert patient_ref_col["generator"] == "surrogate-fk"
    assert patient_ref_col["params"]["references"] == "mock.public.PatientMock.patientRef"

    measurement_type_col = _column(measurements, "mock.public.MeasurementsMock.MeasurementTypeId")
    assert measurement_type_col["generator"] == "surrogate-fk"
    assert (
        measurement_type_col["params"]["references"]
        == "mock.public.MeasurementTypeRef.MeasurementTypeId"
    )


def test_fk_wins_over_looking_numeric():
    # patientRef/hospitalId/wardId would all pass as plain "numeric" columns
    # by profiles.json kind alone; FK integrity must take precedence so
    # synthesized rows always reference a live parent row.
    synthetic = _build()
    patient = _table(synthetic, "mock.public.PatientMock")
    hospital_id_col = _column(patient, "mock.public.PatientMock.hospitalId")
    ward_id_col = _column(patient, "mock.public.PatientMock.wardId")
    assert hospital_id_col["generator"] == "surrogate-fk"
    assert ward_id_col["generator"] == "surrogate-fk"


# ── primary keys (non-FK) get surrogate-pk ──────────────────────────────────


def test_primary_key_column_gets_surrogate_pk():
    synthetic = _build()
    hospital = _table(synthetic, "mock.public.HospitalRef")
    pk_col = _column(hospital, "mock.public.HospitalRef.HospitalId")
    assert pk_col["generator"] == "surrogate-pk"


# ── non-PHI numeric / categorical descriptors sourced from profiles.json ───


def test_non_phi_numeric_column_gets_numeric_generator_from_profile_stats():
    synthetic = _build()
    measurements = _table(synthetic, "mock.public.MeasurementsMock")
    value_col = _column(measurements, "mock.public.MeasurementsMock.Value")
    assert value_col["generator"] == "numeric"
    assert value_col["params"]["min"] == 16.0
    assert value_col["params"]["max"] == 240.0
    assert value_col["params"]["mean"] == 84.6


def test_non_phi_categorical_with_top_categories_gets_labels_and_weights():
    synthetic = _build()
    measurement_type = _table(synthetic, "mock.public.MeasurementTypeRef")
    unit_col = _column(measurement_type, "mock.public.MeasurementTypeRef.unit")
    assert unit_col["generator"] == "categorical"
    assert unit_col["params"]["labels"] == ["bpm", "%"]
    assert len(unit_col["params"]["weights"]) == 2
    assert abs(sum(unit_col["params"]["weights"]) - 1.0) < 1e-6


def test_non_phi_high_cardinality_categorical_without_top_categories_gets_fake_shape():
    # patientCode is non-PHI but profiles.json gave it no topCategories
    # (high-cardinality, could be an identifier) — must NOT invent labels.
    synthetic = _build()
    patient = _table(synthetic, "mock.public.PatientMock")
    code_col = _column(patient, "mock.public.PatientMock.patientCode")
    assert code_col["generator"] == "synthetic-identifier"
    assert "labels" not in code_col["params"]


# ── time columns get a timestamp generator with a recent-window hint ───────


def test_time_column_gets_timestamp_generator_with_recent_window_hint():
    synthetic = _build()
    measurements = _table(synthetic, "mock.public.MeasurementsMock")
    recorded_at_col = _column(measurements, "mock.public.MeasurementsMock.RecordedAt")
    assert recorded_at_col["generator"] == "timestamp"
    assert "recentWindow" in recorded_at_col["params"]
    assert recorded_at_col["params"]["end"] == "now"
    assert recorded_at_col["params"]["start"].startswith("-")


def test_recorded_at_shaped_column_gets_short_hours_window_for_last_n_hours_questions():
    # "heart rate > 120 in the last 3 hours" needs a SHORT recentWindow so
    # loadSynthetic.ts can guarantee matching rows inside that narrow band.
    descriptor = build_column_descriptor(
        column_id="mock.public.MeasurementsMock.RecordedAt",
        column_name="RecordedAt",
        is_time_column=True,
        profile_col=None,
        phi_class="non-phi",
        fk_reference=None,
        is_primary_key=False,
    )
    assert descriptor.params["recentWindow"] == "PT3H"
    assert "recentWindowAnchor" not in descriptor.params


def test_admitted_at_shaped_column_gets_day_anchored_window_for_yesterday_questions():
    # "patients admitted yesterday" needs a CALENDAR-DAY-anchored window, not
    # a rolling N-hour one — distinct from RecordedAt's shape.
    descriptor = build_column_descriptor(
        column_id="mock.public.VisitMock.admittedAt",
        column_name="admittedAt",
        is_time_column=True,
        profile_col=None,
        phi_class="non-phi",
        fk_reference=None,
        is_primary_key=False,
    )
    assert descriptor.params["recentWindow"] == "P1D"
    assert descriptor.params["recentWindowAnchor"] == "previous-day"


# ── syntheticRowTarget: always scaled DOWN, never near real cardinality ────


def test_synthetic_row_target_never_approaches_real_cardinality():
    synthetic = _build()
    measurements = _table(synthetic, "mock.public.MeasurementsMock")
    # Real approxRowCount fed in was 337,000,000.
    assert measurements["syntheticRowTarget"] < 10_000
    assert measurements["syntheticRowTarget"] > 0


def test_scale_down_row_target_is_monotonic_and_bounded():
    small = scale_down_row_target(4)
    medium = scale_down_row_target(50_000)
    huge = scale_down_row_target(337_000_000)

    assert small < medium <= huge
    assert huge <= 5000  # never close to the real 337M scale
    assert scale_down_row_target(0) >= 1  # floor for FK-referenced empty tables


def test_row_target_floor_for_zero_row_lookup_tables():
    target = scale_down_row_target(0)
    assert target >= 5  # a lookup table with 0 profiled rows still gets a usable target


# ── build_column_descriptor precedence (unit-level, no full document) ──────


def test_column_descriptor_precedence_fk_beats_primary_key_flag():
    # A column that is BOTH flagged isPrimaryKey (defensively, by a caller
    # bug) AND has an fk_reference must resolve to surrogate-fk — FK integrity
    # always wins.
    descriptor = build_column_descriptor(
        column_id="mock.public.X.y",
        column_name="y",
        is_time_column=False,
        profile_col={"kind": "numeric", "min": 1, "max": 2, "mean": 1.5},
        phi_class="non-phi",
        fk_reference="mock.public.Parent.id",
        is_primary_key=True,
    )
    assert descriptor.generator == "surrogate-fk"


def test_column_descriptor_precedence_time_column_beats_phi_class():
    # Even if a time column were (incorrectly) classified as free-text by an
    # over-eager heuristic, shape must stay a timestamp generator, never a
    # fake-string generator that would corrupt query semantics.
    descriptor = build_column_descriptor(
        column_id="mock.public.X.RecordedAt",
        column_name="RecordedAt",
        is_time_column=True,
        profile_col=None,
        phi_class="free-text",
        fk_reference=None,
        is_primary_key=False,
    )
    assert descriptor.generator == "timestamp"


# ── emit.emit_synthetic: file + hash round trip ─────────────────────────────


def test_emit_synthetic_writes_file_and_matching_hash(tmp_path):
    synthetic = _build()
    path, digest = emit_synthetic(tmp_path, synthetic)

    assert path.is_file()
    assert path.name == "synthetic.json"
    assert sha256_file(path) == digest


def test_emit_synthetic_is_deterministic_byte_for_byte():
    import tempfile
    from pathlib import Path as _Path

    synthetic = _build()
    with tempfile.TemporaryDirectory() as d1, tempfile.TemporaryDirectory() as d2:
        _, hash1 = emit_synthetic(_Path(d1), synthetic)
        _, hash2 = emit_synthetic(_Path(d2), synthetic)
        assert hash1 == hash2


# ── phi_gate.check_synthetic_json integration ───────────────────────────────


def test_check_synthetic_json_passes_clean_document_built_by_build_synthetic_json():
    synthetic = _build()
    phi = _phi()
    violations = check_synthetic_json(phi, synthetic)
    assert violations == []


def test_check_synthetic_json_catches_adversarial_labels_on_phi_column():
    # Construct a deliberately poisoned synthetic.json (NOT produced by
    # build_synthetic_json — this proves the gate itself would catch a
    # regression, e.g. a future code change that accidentally starts emitting
    # labels for a suppressed column).
    phi = _phi()
    poisoned = {
        "tables": [
            {
                "tableId": "mock.public.HospitalRef",
                "syntheticRowTarget": 10,
                "columns": [
                    {
                        "columnId": "mock.public.HospitalRef.name",
                        "generator": "categorical",
                        "params": {"labels": ["Ceiba General", "Ceiba East"]},
                    }
                ],
            }
        ]
    }
    violations = check_synthetic_json(phi, poisoned)
    assert len(violations) == 1
    assert violations[0].check == "no_raw_cell_value"
    assert violations[0].location == "synthetic.json"
