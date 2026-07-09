"""test_manifest_integrity.py — emit.py manifest/hash integrity (SPEC §1.2, §1.1). P3b.

Asserts:
  * Every file hash recorded in `manifest.json.files` matches the sha256 of
    the actual on-disk bytes (the `verify` command's integrity check).
  * `compute_short_manifest_hash` is deterministic given the same manifest
    BODY content, INCLUDING when nested wall-clock fields
    (`sources[].introspectedAt`) differ between two calls — the exact bug
    class this module's fix addresses (a naive top-level-only exclusion list
    would let a nested timestamp leak into the hash and break determinism).
  * `finalize_bundle_directory`'s two-pass version stem + short hash
    composition is stable: calling it twice with byte-identical
    `manifest_without_version` inputs (but different timestamp stems)
    produces the SAME short hash suffix.
  * `compute_schema_fingerprint` is deterministic given the same table/column/
    key shape and CHANGES when a column's type/nullability changes (drift
    detection actually detects drift).
  * An end-to-end `emit_partial_bundle` + `emit_full_bundle_files` +
    `build_manifest` round trip: every declared file hash verifies.
"""

from __future__ import annotations

import json
from pathlib import Path

from prep.emit import (
    build_manifest,
    compute_schema_fingerprint,
    compute_short_manifest_hash,
    emit_full_bundle_files,
    emit_partial_bundle,
    finalize_bundle_directory,
    new_bundle_version,
    sha256_file,
    SourceManifestEntry,
)


def _sample_manifest_body(introspected_at: str = "2026-07-09T11:00:00Z") -> dict:
    return {
        "bundleFormatVersion": "1.0.0",
        "bundleVersion": "vPLACEHOLDER",
        "createdAt": "2026-07-09T11:00:05Z",
        "builder": {"name": "ceiba-nl2sql-prep", "version": "0.1.0", "gitSha": "abc1234"},
        "embeddingModel": {"id": "bge-small-en-v1.5", "dimension": 384, "normalization": "l2", "revision": "sha256:x"},
        "sources": [
            {
                "sourceId": "mock",
                "engine": "postgres",
                "engineVersion": "16.0",
                "database": "mock",
                "schemaFingerprint": "sha256:abc",
                "introspectedAt": introspected_at,
                "readOnly": True,
            }
        ],
        "counts": {"schemas": 1, "tables": 6, "columns": 25},
        "files": {"catalog.json": "sha256:deadbeef"},
        "phiGate": {"passed": True, "gateVersion": "1.0.0", "checkedFiles": 5, "violations": []},
    }


# ── per-file hash integrity ─────────────────────────────────────────────────


def test_emitted_file_hashes_match_on_disk_bytes(tmp_path):
    catalog = {"schemas": [], "tables": []}
    keys = {"primaryKeys": [], "foreignKeys": []}
    profiles = {"tables": []}
    phi = {"phiColumnsetHash": "sha256:x", "columns": []}

    result = emit_partial_bundle(tmp_path, catalog=catalog, keys=keys, profiles=profiles, phi=phi)

    for filename, recorded_hash in result.file_hashes.items():
        actual_hash = sha256_file(tmp_path / filename)
        assert actual_hash == recorded_hash, f"{filename} hash mismatch"


def test_full_bundle_files_hashes_match_on_disk_bytes(tmp_path):
    joingraph = {"nodes": ["mock.public.A"], "edges": []}
    glossary = {"synonyms": [], "abbreviations": {}, "codeSystems": [], "units": [], "temporal": []}
    exemplars = {"exemplars": []}

    hashes = emit_full_bundle_files(tmp_path, joingraph=joingraph, glossary=glossary, exemplars=exemplars)

    for filename, recorded_hash in hashes.items():
        actual_hash = sha256_file(tmp_path / filename)
        assert actual_hash == recorded_hash


def test_manifest_files_field_verifies_against_disk(tmp_path):
    catalog = {"schemas": [], "tables": []}
    keys = {"primaryKeys": [], "foreignKeys": []}
    profiles = {"tables": []}
    phi = {"phiColumnsetHash": "sha256:x", "columns": []}
    joingraph = {"nodes": [], "edges": []}
    glossary = {"synonyms": [], "abbreviations": {}, "codeSystems": [], "units": [], "temporal": []}
    exemplars = {"exemplars": []}

    partial = emit_partial_bundle(tmp_path, catalog=catalog, keys=keys, profiles=profiles, phi=phi)
    full = emit_full_bundle_files(tmp_path, joingraph=joingraph, glossary=glossary, exemplars=exemplars)
    all_hashes = {**partial.file_hashes, **full}

    manifest = build_manifest(
        bundle_version="vTEST",
        created_at="2026-07-09T11:00:00Z",
        builder_version="0.1.0",
        git_sha="abc1234",
        embedding_model_summary={"id": "bge-small-en-v1.5", "dim": 384, "lib": "fastembed", "revision": "sha256:x"},
        sources=[
            SourceManifestEntry(
                source_id="mock",
                engine="postgres",
                engine_version="16.0",
                database="mock",
                schema_fingerprint="sha256:abc",
                introspected_at="2026-07-09T11:00:00Z",
            )
        ],
        counts={"schemas": 0, "tables": 0, "columns": 0},
        file_hashes=all_hashes,
        phi_gate_result={"passed": True, "gateVersion": "1.0.0", "checkedFiles": 5, "violations": []},
    )

    for filename, recorded_hash in manifest["files"].items():
        actual_hash = sha256_file(tmp_path / filename)
        assert actual_hash == recorded_hash, f"{filename} hash in manifest.json does not match disk"


# ── determinism: short manifest hash ignores wall-clock fields ─────────────


def test_short_manifest_hash_stable_despite_top_level_timestamp_diff():
    body1 = _sample_manifest_body()
    body2 = dict(_sample_manifest_body())
    body2["createdAt"] = "2099-01-01T00:00:00Z"  # wildly different wall clock
    assert compute_short_manifest_hash(body1) == compute_short_manifest_hash(body2)


def test_short_manifest_hash_stable_despite_nested_introspected_at_diff():
    """The specific bug this task's fix addresses: `sources[].introspectedAt`
    is NESTED, not top-level — a naive exclusion list that only strips
    top-level `createdAt`/`bundleVersion` would let this leak into the hash
    and break determinism across two builds run a moment apart.
    """
    body1 = _sample_manifest_body(introspected_at="2026-07-09T11:00:00Z")
    body2 = _sample_manifest_body(introspected_at="2026-07-09T11:05:33Z")
    assert compute_short_manifest_hash(body1) == compute_short_manifest_hash(body2)


def test_short_manifest_hash_changes_when_real_content_changes():
    body1 = _sample_manifest_body()
    body2 = dict(_sample_manifest_body())
    body2["counts"] = {"schemas": 1, "tables": 999, "columns": 25}  # genuine content change
    assert compute_short_manifest_hash(body1) != compute_short_manifest_hash(body2)


def test_finalize_bundle_directory_stable_across_different_timestamp_stems():
    body = _sample_manifest_body()
    dir1, manifest1 = finalize_bundle_directory("/tmp/bundles", "v20260709T110000Z", body)
    dir2, manifest2 = finalize_bundle_directory("/tmp/bundles", "v20260709T110533Z", body)

    hash1 = manifest1["bundleVersion"].split("_", 1)[1]
    hash2 = manifest2["bundleVersion"].split("_", 1)[1]
    assert hash1 == hash2
    assert dir1.name != dir2.name  # different timestamp stems -> different dir names
    assert dir1.name.endswith(hash1)
    assert dir2.name.endswith(hash2)


def test_new_bundle_version_format():
    from datetime import datetime, timezone

    stem = new_bundle_version(datetime(2026, 7, 9, 12, 0, 0, tzinfo=timezone.utc))
    assert stem == "v20260709T120000Z"


# ── schema fingerprint drift detection ──────────────────────────────────────


def _sample_catalog_tables() -> list[dict]:
    return [
        {
            "tableId": "mock.public.HospitalRef",
            "columns": [
                {"name": "HospitalId", "dataType": "integer", "nullable": False, "isPrimaryKey": True},
                {"name": "name", "dataType": "text", "nullable": False, "isPrimaryKey": False},
            ],
        }
    ]


def _sample_keys() -> dict:
    return {"primaryKeys": [{"tableId": "mock.public.HospitalRef", "columns": ["HospitalId"]}], "foreignKeys": []}


def test_schema_fingerprint_deterministic_given_same_shape():
    fp1 = compute_schema_fingerprint(_sample_catalog_tables(), _sample_keys())
    fp2 = compute_schema_fingerprint(_sample_catalog_tables(), _sample_keys())
    assert fp1 == fp2
    assert fp1.startswith("sha256:")


def test_schema_fingerprint_changes_on_column_type_drift():
    original = compute_schema_fingerprint(_sample_catalog_tables(), _sample_keys())

    drifted_tables = _sample_catalog_tables()
    drifted_tables[0]["columns"][0]["dataType"] = "bigint"  # int -> bigint drift
    drifted = compute_schema_fingerprint(drifted_tables, _sample_keys())

    assert original != drifted


def test_schema_fingerprint_unaffected_by_table_order():
    tables = _sample_catalog_tables() + [
        {
            "tableId": "mock.public.WardRef",
            "columns": [{"name": "WardId", "dataType": "integer", "nullable": False, "isPrimaryKey": True}],
        }
    ]
    keys = _sample_keys()

    fp_original_order = compute_schema_fingerprint(tables, keys)
    fp_reversed_order = compute_schema_fingerprint(list(reversed(tables)), keys)
    assert fp_original_order == fp_reversed_order
