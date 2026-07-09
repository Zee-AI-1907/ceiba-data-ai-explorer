"""test_bundle_loader.py — ceiba_nl2sql.bundle.loader (NEW module, Phase 1;
docs/PYTHON_NL2SQL_SERVICE_PLAN.md §1.1, §3.1, §3.2). Ports the essential
assertions of lib/rag/__tests__/bundleLoader.test.ts to Python so the shared
READ side of the bundle is proven correct independent of the TS runtime.

Builds a minimal, self-consistent bundle directory on disk (manifest.json +
the 7 required sibling JSON files, correctly hashed) using only the stdlib —
no dependency on a real prep build — then exercises `load_bundle` against it:
  * happy path: loads, accessors work.
  * bundleFormatVersion major mismatch -> BundleLoadError.
  * embeddingModel.id mismatch -> EmbeddingModelMismatchError.
  * tampered sibling file (hash mismatch) -> BundleIntegrityError.
  * `skip_integrity_check=True` bypasses the hash check.
"""

from __future__ import annotations

import hashlib
import json
from pathlib import Path

import pytest

from ceiba_nl2sql.bundle.loader import (
    BundleIntegrityError,
    BundleLoadError,
    EmbeddingModelMismatchError,
    load_bundle,
)

_SIBLING_FILES = (
    "catalog.json",
    "keys.json",
    "joingraph.json",
    "profiles.json",
    "phi.json",
    "glossary.json",
    "exemplars.json",
)


def _write_json(path: Path, data: dict) -> str:
    payload = json.dumps(data, indent=2, sort_keys=True) + "\n"
    path.write_text(payload, encoding="utf-8")
    return hashlib.sha256(payload.encode("utf-8")).hexdigest()


def _build_minimal_bundle(bundle_dir: Path, *, embedding_model_id: str = "bge-small-en-v1.5") -> None:
    bundle_dir.mkdir(parents=True, exist_ok=True)

    contents = {
        "catalog.json": {
            "schemas": [{"sourceId": "mock", "schema": "public", "domain": None, "tableCount": 1}],
            "tables": [
                {
                    "tableId": "mock.public.T",
                    "sourceId": "mock",
                    "schema": "public",
                    "name": "T",
                    "quotedRef": '"public"."T"',
                    "grain": None,
                    "domain": None,
                    "isLargeTimeSeries": False,
                    "importanceScore": None,
                    "columns": [],
                    "indexes": [],
                }
            ],
        },
        "keys.json": {"primaryKeys": [], "foreignKeys": []},
        "joingraph.json": {"nodes": [], "edges": []},
        "profiles.json": {
            "tables": [{"tableId": "mock.public.T", "approxRowCount": 0, "rowCountSource": "test", "columns": []}]
        },
        "phi.json": {"phiColumnsetHash": "test-hash", "columns": []},
        "glossary.json": {"synonyms": [], "abbreviations": {}, "codeSystems": [], "units": [], "temporal": []},
        "exemplars.json": {"exemplars": []},
    }

    file_hashes = {name: _write_json(bundle_dir / name, data) for name, data in contents.items()}

    manifest = {
        "bundleFormatVersion": "1.0.0",
        "bundleVersion": "vTEST_000000",
        "createdAt": "2026-01-01T00:00:00Z",
        "builder": {"name": "test", "version": "0.0.0", "gitSha": None},
        "embeddingModel": {"id": embedding_model_id, "dimension": 384, "normalization": "l2", "revision": "sha256:test"},
        "sources": [],
        "counts": {
            "schemas": 1,
            "tables": 1,
            "columns": 0,
            "foreignKeys": 0,
            "inferredJoinEdges": 0,
            "glossaryTerms": 0,
            "exemplars": 0,
            "vectors": 0,
        },
        "files": file_hashes,
        "phiGate": {"passed": True},
    }
    _write_json(bundle_dir / "manifest.json", manifest)


def test_load_bundle_happy_path(tmp_path: Path):
    bundle_dir = tmp_path / "bundle"
    _build_minimal_bundle(bundle_dir)

    loaded = load_bundle(bundle_dir)

    assert loaded.manifest["bundleVersion"] == "vTEST_000000"
    assert loaded.catalog["tables"][0]["tableId"] == "mock.public.T"
    assert loaded.vectors_duckdb_path == bundle_dir / "vectors.duckdb"


def test_get_table_get_table_profile_get_column_phi(tmp_path: Path):
    bundle_dir = tmp_path / "bundle"
    _build_minimal_bundle(bundle_dir)
    loaded = load_bundle(bundle_dir)

    assert loaded.get_table("mock.public.T") is not None
    assert loaded.get_table("does.not.exist") is None
    assert loaded.get_table_profile("mock.public.T") is not None
    assert loaded.get_column_phi("mock.public.T.X") is None


def test_bundle_format_major_mismatch_rejected(tmp_path: Path):
    bundle_dir = tmp_path / "bundle"
    _build_minimal_bundle(bundle_dir)

    manifest_path = bundle_dir / "manifest.json"
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    manifest["bundleFormatVersion"] = "2.0.0"
    manifest_path.write_text(json.dumps(manifest, indent=2, sort_keys=True) + "\n", encoding="utf-8")

    with pytest.raises(BundleLoadError):
        load_bundle(bundle_dir)


def test_embedding_model_mismatch_rejected(tmp_path: Path):
    bundle_dir = tmp_path / "bundle"
    _build_minimal_bundle(bundle_dir, embedding_model_id="some-other-model")

    with pytest.raises(EmbeddingModelMismatchError):
        load_bundle(bundle_dir)


def test_embedding_model_mismatch_allows_explicit_override(tmp_path: Path):
    bundle_dir = tmp_path / "bundle"
    _build_minimal_bundle(bundle_dir, embedding_model_id="test-deterministic-hash-v1")

    loaded = load_bundle(bundle_dir, expected_embedding_model_id="test-deterministic-hash-v1")
    assert loaded.manifest["embeddingModel"]["id"] == "test-deterministic-hash-v1"


def test_tampered_sibling_file_rejected(tmp_path: Path):
    bundle_dir = tmp_path / "bundle"
    _build_minimal_bundle(bundle_dir)

    # Tamper with catalog.json AFTER its hash was recorded in manifest.json.
    catalog_path = bundle_dir / "catalog.json"
    tampered = json.loads(catalog_path.read_text(encoding="utf-8"))
    tampered["tables"][0]["tableId"] = "tampered.public.T"
    catalog_path.write_text(json.dumps(tampered, indent=2, sort_keys=True) + "\n", encoding="utf-8")

    with pytest.raises(BundleIntegrityError):
        load_bundle(bundle_dir)


def test_missing_sibling_file_rejected(tmp_path: Path):
    bundle_dir = tmp_path / "bundle"
    _build_minimal_bundle(bundle_dir)
    (bundle_dir / "exemplars.json").unlink()

    with pytest.raises(BundleIntegrityError):
        load_bundle(bundle_dir)


def test_skip_integrity_check_bypasses_hash_verification(tmp_path: Path):
    bundle_dir = tmp_path / "bundle"
    _build_minimal_bundle(bundle_dir)

    catalog_path = bundle_dir / "catalog.json"
    tampered = json.loads(catalog_path.read_text(encoding="utf-8"))
    tampered["tables"][0]["tableId"] = "tampered.public.T"
    catalog_path.write_text(json.dumps(tampered, indent=2, sort_keys=True) + "\n", encoding="utf-8")

    loaded = load_bundle(bundle_dir, skip_integrity_check=True)
    assert loaded.catalog["tables"][0]["tableId"] == "tampered.public.T"


def test_sha256_of_file_matches_hashlib(tmp_path: Path):
    from ceiba_nl2sql.bundle.loader import sha256_of_file

    path = tmp_path / "f.txt"
    path.write_bytes(b"hello world")
    assert sha256_of_file(path) == hashlib.sha256(b"hello world").hexdigest()
