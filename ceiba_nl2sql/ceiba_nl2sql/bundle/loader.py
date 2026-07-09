"""loader.py — read-only artifact bundle loader (NEW; ports lib/rag/BundleLoader.ts's
semantics into Python, docs/PYTHON_NL2SQL_SERVICE_PLAN.md §1.1, §3.1, §3.2).

The bundle (SPEC §1) is the compliance seam between the Python `prep` toolchain
(which WRITES it — see `prep.emit`) and any READER of it — today `prep verify`,
tomorrow the NL->SQL FastAPI service. This module is the shared READ side:

  1. Read `manifest.json` FIRST (SPEC §1.2 "the runtime reads this first").
  2. Validate `bundleFormatVersion`'s MAJOR component against the major this
     loader is pinned to — a minor/patch bump is forward-compatible, a major
     bump is refused (SPEC §1.2 "runtime pins a compatible major").
  3. REFUSE to load if `manifest.embeddingModel.id` differs from the expected
     embedding model id (SPEC §1.2, §4 Retriever.load() contract: "vectors are
     never mixed across models"). Hard error, not a warning.
  4. Verify the sha256 of every sibling file against `manifest.files` (SPEC
     §1.2 integrity) — a tampered/partially-written bundle is refused before
     any JSON is trusted.
  5. Expose typed accessors over catalog/keys/joingraph/profiles/phi/glossary/
     exemplars — mirrors `lib/rag/BundleLoader.ts`'s accessor surface so a
     Python caller (prep's own `verify`, or later the service) reads the
     bundle identically to the TS runtime today.

This is intentionally the READ side only — `prep.emit` remains the sole
WRITER. Sharing this loader (rather than each reader re-parsing JSON ad hoc)
is what the plan calls out as reducing "bundle write/read schema desync risk"
(§3.2): a field rename in emit.py and a field rename here can be checked
against the same fixtures.
"""

from __future__ import annotations

import hashlib
import json
from dataclasses import dataclass
from pathlib import Path
from typing import Any

# The embedding model id this loader is pinned to by default (SPEC §0a decision #2).
EXPECTED_EMBEDDING_MODEL_ID = "bge-small-en-v1.5"

# Mirrors prep.embed.local_embedder.DeterministicHashEmbedder.MODEL_ID — the
# TEST-ONLY fallback id, never a real bundle's embeddingModel.id.
TEST_FALLBACK_EMBEDDING_MODEL_ID = "test-deterministic-hash-v1"

# Compatible major version of the bundle format this loader understands (SPEC §1.2).
SUPPORTED_BUNDLE_FORMAT_MAJOR = 1

_BUNDLE_JSON_FILES = (
    "catalog.json",
    "keys.json",
    "joingraph.json",
    "profiles.json",
    "phi.json",
    "glossary.json",
    "exemplars.json",
)


class BundleLoadError(RuntimeError):
    """Base error for any bundle load failure. Mirrors lib/rag/BundleLoader.ts's
    `BundleLoadError`.
    """


class EmbeddingModelMismatchError(BundleLoadError):
    """Raised when `manifest.embeddingModel.id` does not match what this loader
    (or an explicit override) expects. Mirrors
    lib/rag/BundleLoader.ts `EmbeddingModelMismatchError`.
    """

    def __init__(self, expected: str, actual: str) -> None:
        super().__init__(
            f'BundleLoader: manifest.embeddingModel.id="{actual}" does not match the '
            f'expected embedding model id="{expected}". Refusing to load — vectors are '
            "never mixed across models (NL2SQL_SPEC.md §1.2, §4)."
        )
        self.expected = expected
        self.actual = actual


class BundleIntegrityError(BundleLoadError):
    """Raised when one or more sibling files' sha256 does not match
    `manifest.files`. Mirrors lib/rag/BundleLoader.ts `BundleIntegrityError`.
    """


def sha256_of_file(path: str | Path) -> str:
    """Compute the sha256 hex digest of an on-disk file (streamed, not loaded
    fully into memory).
    """
    digest = hashlib.sha256()
    with Path(path).open("rb") as handle:
        for chunk in iter(lambda: handle.read(1 << 16), b""):
            digest.update(chunk)
    return digest.hexdigest()


def _read_json(bundle_dir: Path, filename: str) -> Any:
    with (bundle_dir / filename).open("r", encoding="utf-8") as handle:
        return json.load(handle)


@dataclass(frozen=True)
class LoadedBundle:
    """The result of a successful `BundleLoader.load()` — an immutable snapshot
    of every parsed §1 JSON file plus the resolved bundle directory. Mirrors
    the accessor surface of `lib/rag/BundleLoader.ts`'s `BundleLoader` class,
    but as a plain immutable value (Pythonic; no `ensureLoaded()` guard needed
    since a `LoadedBundle` only ever exists fully loaded).
    """

    bundle_dir: Path
    manifest: dict
    catalog: dict
    keys: dict
    join_graph: dict
    profiles: dict
    phi: dict
    glossary: dict
    exemplars: dict

    @property
    def vectors_duckdb_path(self) -> Path:
        """Absolute path to this bundle's vectors.duckdb (SPEC §1.11).
        Existence is not verified here — a vss reader opens it lazily, mirroring
        `lib/rag/BundleLoader.ts`'s `vectorsDuckdbPath` accessor.
        """
        return self.bundle_dir / "vectors.duckdb"

    def get_table(self, table_id: str) -> dict | None:
        """Convenience: table lookup by tableId (mirrors BundleLoader.ts `getTable`)."""
        return next((t for t in self.catalog.get("tables", []) if t.get("tableId") == table_id), None)

    def get_table_profile(self, table_id: str) -> dict | None:
        """Convenience: profile lookup by tableId (mirrors BundleLoader.ts `getTableProfile`)."""
        return next((t for t in self.profiles.get("tables", []) if t.get("tableId") == table_id), None)

    def get_column_phi(self, column_id: str) -> dict | None:
        """Convenience: PHI classification lookup by columnId (mirrors
        BundleLoader.ts `getColumnPhi`).
        """
        return next((c for c in self.phi.get("columns", []) if c.get("columnId") == column_id), None)


def load_bundle(
    bundle_dir: str | Path,
    *,
    expected_embedding_model_id: str = EXPECTED_EMBEDDING_MODEL_ID,
    skip_integrity_check: bool = False,
) -> LoadedBundle:
    """Load + validate the bundle at `bundle_dir` (SPEC §4 `Retriever.load()`
    contract: "validates the embedding-model id against the manifest").

    Order: read manifest -> check bundleFormatVersion major -> check
    embeddingModel.id -> verify file hashes -> parse the remaining JSON files.
    Any failure raises a `BundleLoadError` subclass; nothing partial is
    returned (this function either returns a fully-populated `LoadedBundle`
    or raises).

    `skip_integrity_check=True` is intended only for tooling that
    intentionally inspects a partially-built bundle (mirrors the TS loader's
    `skipIntegrityCheck` option) — production retrieval/generation paths must
    never set this.
    """
    bundle_dir = Path(bundle_dir)
    manifest = _read_json(bundle_dir, "manifest.json")

    format_version = str(manifest.get("bundleFormatVersion", ""))
    major_str = format_version.split(".")[0] if format_version else ""
    try:
        major = int(major_str)
    except ValueError:
        major = None
    if major != SUPPORTED_BUNDLE_FORMAT_MAJOR:
        raise BundleLoadError(
            f'BundleLoader: bundle at "{bundle_dir}" has bundleFormatVersion='
            f'"{format_version}" (major={major}); this loader only supports major '
            f"version {SUPPORTED_BUNDLE_FORMAT_MAJOR}."
        )

    actual_model_id = manifest.get("embeddingModel", {}).get("id")
    if actual_model_id != expected_embedding_model_id:
        raise EmbeddingModelMismatchError(expected_embedding_model_id, actual_model_id)

    if not skip_integrity_check:
        _verify_file_hashes(bundle_dir, manifest)

    parsed = {name: _read_json(bundle_dir, name) for name in _BUNDLE_JSON_FILES}

    return LoadedBundle(
        bundle_dir=bundle_dir,
        manifest=manifest,
        catalog=parsed["catalog.json"],
        keys=parsed["keys.json"],
        join_graph=parsed["joingraph.json"],
        profiles=parsed["profiles.json"],
        phi=parsed["phi.json"],
        glossary=parsed["glossary.json"],
        exemplars=parsed["exemplars.json"],
    )


def _verify_file_hashes(bundle_dir: Path, manifest: dict) -> None:
    mismatches: list[str] = []
    for filename, expected_hash in manifest.get("files", {}).items():
        file_path = bundle_dir / filename
        if not file_path.is_file():
            mismatches.append(f"{filename}: missing")
            continue
        actual_hash = sha256_of_file(file_path)
        if actual_hash != expected_hash:
            mismatches.append(f"{filename}: expected sha256={expected_hash}, got sha256={actual_hash}")
    if mismatches:
        joined = "\n".join(mismatches)
        raise BundleIntegrityError(
            f'BundleLoader: sha256 mismatch for bundle at "{bundle_dir}" — refusing to '
            f"load a tampered/corrupted/partially-written bundle. Mismatches:\n{joined}"
        )
