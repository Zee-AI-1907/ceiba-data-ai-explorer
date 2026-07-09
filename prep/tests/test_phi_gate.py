"""test_phi_gate.py — the CI PHI gate (SPEC §2.5).

Asserts:
  * A poisoned artifact (a phi-suppressed column carrying a raw value, or a
    PHI column carrying topCategories, or a high-cardinality column carrying
    topCategories) fails the gate with a non-empty violation list.
  * A clean artifact passes.
  * The AST scan catches a raw `SELECT col FROM table` literal placed outside
    a `sample_aggregate*` function, and does NOT flag one placed inside such a
    function, and does NOT flag a metadata-only information_schema query.
  * The columnset-hash check catches drift between phi.json and the
    authoritative config/phi_columns.json.
  * The embedding-local check fails closed for a non-local provider.
"""

from __future__ import annotations

import textwrap
from pathlib import Path

import pytest

from ceiba_nl2sql.compliance.phi import load_phi_columnset

from prep.config import load_config
from prep.phi_gate import (
    check_columnset_hash,
    check_embedding_local,
    check_profiles_json,
    run_gate,
    scan_file_for_raw_select,
)

REPO_ROOT = Path(__file__).resolve().parents[2]
CONFIG_PATH = REPO_ROOT / "config" / "prep.config.yaml"


@pytest.fixture(scope="module")
def phi_columnset_hash() -> str:
    return load_phi_columnset(REPO_ROOT).columnset_hash


@pytest.fixture()
def clean_phi_json(phi_columnset_hash: str) -> dict:
    return {
        "phiColumnsetHash": phi_columnset_hash,
        "columns": [
            {
                "columnId": "staging.Shared.Patients.Name",
                "normalizedKey": "name",
                "phiClass": "direct-identifier",
                "matchedRule": "PHI_COLUMNS:name",
                "egressPolicy": "suppress",
            },
            {
                "columnId": "staging.Shared.MonitorMeasurements.HeartRate",
                "normalizedKey": "heartrate",
                "phiClass": "non-phi",
                "matchedRule": None,
                "egressPolicy": "aggregate-only",
            },
        ],
    }


@pytest.fixture()
def clean_profiles_json() -> dict:
    return {
        "tables": [
            {
                "tableId": "staging.Shared.MonitorMeasurements",
                "approxRowCount": 337_000_000,
                "rowCountSource": "pg_class.reltuples",
                "columns": [
                    {
                        "columnId": "staging.Shared.MonitorMeasurements.HeartRate",
                        "kind": "numeric",
                        "nonNullCount": 4987,
                        "nullRate": 0.003,
                        "distinctCount": 190,
                        "min": 20,
                        "max": 240,
                        "mean": 84.6,
                    }
                ],
            },
            {
                "tableId": "staging.Shared.Patients",
                "approxRowCount": 5000,
                "rowCountSource": "pg_class.reltuples",
                "columns": [
                    {
                        "columnId": "staging.Shared.Patients.Name",
                        "kind": "phi-suppressed",
                        "nonNullCount": 5000,
                        "nullRate": 0.0,
                        "distinctCount": 5000,
                    }
                ],
            },
        ]
    }


def test_clean_artifact_passes_columnset_hash_check(clean_phi_json, phi_columnset_hash):
    violations = check_columnset_hash(REPO_ROOT, clean_phi_json)
    assert violations == []


def test_poisoned_columnset_hash_fails(clean_phi_json):
    poisoned = dict(clean_phi_json)
    poisoned["phiColumnsetHash"] = "sha256:deadbeef-not-the-real-hash"
    violations = check_columnset_hash(REPO_ROOT, poisoned)
    assert len(violations) >= 1
    assert any(v.check == "columnset_hash" for v in violations)


def test_clean_profiles_json_passes(clean_phi_json, clean_profiles_json):
    violations = check_profiles_json(clean_phi_json, clean_profiles_json)
    assert violations == []


def test_poisoned_profile_phi_suppressed_with_value_fails(clean_phi_json, clean_profiles_json):
    poisoned = clean_profiles_json.copy()
    poisoned["tables"] = [dict(t) for t in clean_profiles_json["tables"]]
    patients_table = poisoned["tables"][1]
    patients_table["columns"] = [dict(patients_table["columns"][0])]
    # Poison: a phi-suppressed column carrying a raw-value-shaped field.
    patients_table["columns"][0]["topCategories"] = [{"value": "Ege Apak", "count": 1}]

    violations = check_profiles_json(clean_phi_json, poisoned)
    assert len(violations) >= 1
    assert any(v.check == "no_raw_cell_value" for v in violations)
    # The raw value must never appear anywhere in the violation text either
    # (violations should describe the shape of the problem, not repeat PHI).
    for v in violations:
        assert "Ege Apak" not in v.message


def test_poisoned_high_cardinality_topcategories_fails(clean_phi_json, clean_profiles_json):
    poisoned = {
        "tables": [
            {
                "tableId": "staging.Shared.SomeTable",
                "approxRowCount": 1000,
                "rowCountSource": "pg_class.reltuples",
                "columns": [
                    {
                        "columnId": "staging.Shared.SomeTable.ExternalRef",
                        "kind": "categorical",
                        "nonNullCount": 1000,
                        "nullRate": 0.0,
                        "distinctCount": 999,  # > HIGH_CARDINALITY_ABSOLUTE (20)
                        "topCategories": [{"value": "REF-1", "count": 1}],
                    }
                ],
            }
        ]
    }
    violations = check_profiles_json(clean_phi_json, poisoned)
    assert len(violations) >= 1
    assert any("distinctCount" in v.message for v in violations)


def test_poisoned_quasi_identifier_with_topcategories_fails(clean_phi_json):
    phi_json = dict(clean_phi_json)
    phi_json["columns"] = list(clean_phi_json["columns"]) + [
        {
            "columnId": "staging.Shared.Patients.Address",
            "normalizedKey": "address",
            "phiClass": "quasi-identifier",
            "matchedRule": "PHI_COLUMNS:address",
            "egressPolicy": "suppress",
        }
    ]
    poisoned_profiles = {
        "tables": [
            {
                "tableId": "staging.Shared.Patients",
                "approxRowCount": 5000,
                "rowCountSource": "pg_class.reltuples",
                "columns": [
                    {
                        "columnId": "staging.Shared.Patients.Address",
                        "kind": "categorical",
                        "nonNullCount": 5000,
                        "nullRate": 0.0,
                        "distinctCount": 5,
                        "topCategories": [{"value": "123 Fake St", "count": 5000}],
                    }
                ],
            }
        ]
    }
    violations = check_profiles_json(phi_json, poisoned_profiles)
    assert len(violations) >= 1
    assert any(v.check == "no_raw_cell_value" for v in violations)


def test_full_gate_clean_passes(clean_phi_json, clean_profiles_json):
    config = load_config(CONFIG_PATH)
    report = run_gate(
        repo_root=REPO_ROOT,
        config=config,
        phi_json=clean_phi_json,
        profiles_json=clean_profiles_json,
    )
    assert report.passed is True
    assert report.violations == []


def test_full_gate_poisoned_fails(clean_phi_json, clean_profiles_json):
    config = load_config(CONFIG_PATH)
    poisoned_phi = dict(clean_phi_json)
    poisoned_phi["phiColumnsetHash"] = "not-the-real-hash"
    report = run_gate(
        repo_root=REPO_ROOT,
        config=config,
        phi_json=poisoned_phi,
        profiles_json=clean_profiles_json,
    )
    assert report.passed is False
    assert len(report.violations) >= 1


def test_embedding_local_check_fails_closed_for_remote_provider():
    config = load_config(CONFIG_PATH)
    # Config objects are frozen dataclasses; build a mutated copy via dataclasses.replace
    # on the nested embedding config to simulate a non-local provider.
    import dataclasses

    remote_embedding = dataclasses.replace(config.embedding, provider="openai")
    remote_config = dataclasses.replace(config, embedding=remote_embedding)

    violations = check_embedding_local(remote_config)
    assert len(violations) == 1
    assert violations[0].check == "embedding_local"


def test_embedding_local_check_passes_for_local_provider():
    config = load_config(CONFIG_PATH)
    assert config.embedding.provider == "local"
    assert check_embedding_local(config) == []


# ── AST scan: sample_aggregate is the sole data path ────────────────────────


def test_ast_scan_catches_raw_select_outside_sample_aggregate(tmp_path):
    poisoned_module = tmp_path / "poisoned.py"
    poisoned_module.write_text(
        textwrap.dedent(
            """
            def leaky_helper(conn):
                # This is exactly the violation the gate must catch: a raw
                # cell-data SELECT outside sample_aggregate*.
                return conn.execute("SELECT \\"Name\\" FROM \\"Shared\\".\\"Patients\\"")
            """
        ),
        encoding="utf-8",
    )
    violations = scan_file_for_raw_select(poisoned_module)
    assert len(violations) >= 1
    assert all(v.check == "sole_data_path" for v in violations)


def test_ast_scan_allows_raw_select_inside_sample_aggregate(tmp_path):
    clean_module = tmp_path / "clean.py"
    clean_module.write_text(
        textwrap.dedent(
            """
            def sample_aggregate(self, table, columns, sample_rows):
                query = "SELECT \\"HeartRate\\" FROM \\"Shared\\".\\"MonitorMeasurements\\" LIMIT 5000"
                return query
            """
        ),
        encoding="utf-8",
    )
    violations = scan_file_for_raw_select(clean_module)
    assert violations == []


def test_ast_scan_allows_metadata_only_select_anywhere(tmp_path):
    clean_module = tmp_path / "metadata.py"
    clean_module.write_text(
        textwrap.dedent(
            """
            def list_tables(self, source_id, schema):
                query = "SELECT table_name FROM information_schema.tables WHERE table_schema = %s"
                return query
            """
        ),
        encoding="utf-8",
    )
    violations = scan_file_for_raw_select(clean_module)
    assert violations == []


def test_ast_scan_over_real_prep_package_passes():
    """The real prep package must itself pass this gate — sample_aggregate is
    genuinely the only data-touching path in the code this task wrote.
    """
    from prep.phi_gate import scan_package_for_raw_select

    violations = scan_package_for_raw_select(REPO_ROOT / "prep" / "prep")
    assert violations == [], [v.to_json() for v in violations]
