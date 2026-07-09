"""emit.py — stage [7]; serialize the full §1 bundle + manifest + hashes.

P3a scope (unchanged, still owned by that phase's contract): the partial emit
— catalog.json, keys.json, profiles.json, phi.json, and a per-file sha256 —
via `emit_partial_bundle`.

P3b extension (this task): the REMAINING §1 files (joingraph.json,
glossary.json, exemplars.json — `emit_full_bundle_files`; vectors.duckdb is
written directly by `prep.embed.vss_index.write_vector_index`, not here) plus
the two files that tie the whole bundle together: `manifest.json` (§1.2:
bundleFormatVersion, per-source schemaFingerprint, builder version,
embeddingModel, counts, per-file sha256, phiGate result — `build_manifest`)
and `BUILD_REPORT.json` (§1.12 provenance — `build_build_report`), plus the
`latest` symlink maintenance (`update_latest_symlink`).

Every artifact here is written with `json.dumps(..., sort_keys=True)` for
deterministic byte-for-byte output (rebuild determinism — SPEC §1.1).
"""

from __future__ import annotations

import hashlib
import json
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any


def _write_json(path: Path, data: Any) -> str:
    """Write `data` as deterministic, sorted-key JSON and return its sha256 hex digest."""
    path.parent.mkdir(parents=True, exist_ok=True)
    payload = json.dumps(data, indent=2, sort_keys=True, ensure_ascii=False) + "\n"
    path.write_text(payload, encoding="utf-8")
    digest = hashlib.sha256(payload.encode("utf-8")).hexdigest()
    return digest


@dataclass(frozen=True)
class PartialEmitResult:
    """File paths + sha256 hashes for the P3a-scoped artifact subset. P3b's
    emit.py extension folds these into manifest.json.files verbatim.
    """

    out_dir: Path
    file_hashes: dict[str, str]

    def to_json(self) -> dict:
        return {
            "outDir": str(self.out_dir),
            "files": self.file_hashes,
        }


def emit_partial_bundle(
    out_dir: str | Path,
    catalog: dict,
    keys: dict,
    profiles: dict,
    phi: dict,
) -> PartialEmitResult:
    """Serialize the four P3a-owned artifact files into `out_dir` and return
    their sha256 hashes, keyed by filename (matches manifest.json.files keys
    — SPEC §1.2).

    `out_dir` is typically `artifacts/bundles/<version>/` but P3a itself does
    not decide bundle versioning (that's the manifest builder's job in P3b);
    it just writes to whatever directory it is given.
    """
    out_dir = Path(out_dir)
    file_hashes: dict[str, str] = {}

    file_hashes["catalog.json"] = _write_json(out_dir / "catalog.json", catalog)
    file_hashes["keys.json"] = _write_json(out_dir / "keys.json", keys)
    file_hashes["profiles.json"] = _write_json(out_dir / "profiles.json", profiles)
    file_hashes["phi.json"] = _write_json(out_dir / "phi.json", phi)

    return PartialEmitResult(out_dir=out_dir, file_hashes=file_hashes)


def emit_synthetic(out_dir: str | Path, synthetic: dict) -> tuple[Path, str]:
    """Serialize synthetic.json (generator DESCRIPTORS only, never raw values —
    SPEC §1.8). Kept as a separate entry point from `emit_partial_bundle`
    because synthetic.json is derived from profiles.json but is conceptually
    its own artifact with its own PHI-gate scan target.
    """
    out_dir = Path(out_dir)
    path = out_dir / "synthetic.json"
    digest = _write_json(path, synthetic)
    return path, digest


def sha256_file(path: str | Path) -> str:
    """Compute the sha256 of an already-written file (used by phi_gate.py /
    verify to check integrity against a previously recorded hash).
    """
    path = Path(path)
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(65536), b""):
            digest.update(chunk)
    return digest.hexdigest()


# =============================================================================
# P3b extension — stage [7] EMIT, full bundle (SPEC §1.1, §1.2, §1.12).
#
# Everything below builds on `emit_partial_bundle`'s output (catalog/keys/
# profiles/phi + their hashes) plus the P3b-owned enrich/embed/exemplar
# artifacts to emit the REMAINING §1 files (joingraph/glossary/exemplars/
# vectors.duckdb) and the two files that tie the whole bundle together:
# manifest.json (§1.2) and BUILD_REPORT.json (§1.12).
# =============================================================================


@dataclass(frozen=True)
class BuildStage:
    """One BUILD_REPORT.json `stages[]` entry (SPEC §1.12)."""

    stage: str
    ok: bool
    duration_ms: int
    extra: dict = None  # type: ignore[assignment]

    def to_json(self) -> dict:
        out = {"stage": self.stage, "durationMs": self.duration_ms, "ok": self.ok}
        if self.extra:
            out.update(self.extra)
        return out


@dataclass(frozen=True)
class SourceManifestEntry:
    """One manifest.json `sources[]` entry (SPEC §1.2)."""

    source_id: str
    engine: str
    engine_version: str
    database: str
    schema_fingerprint: str
    introspected_at: str
    read_only: bool = True

    def to_json(self) -> dict:
        return {
            "sourceId": self.source_id,
            "engine": self.engine,
            "engineVersion": self.engine_version,
            "database": self.database,
            "schemaFingerprint": self.schema_fingerprint,
            "introspectedAt": self.introspected_at,
            "readOnly": self.read_only,
        }


def compute_schema_fingerprint(catalog_tables_for_source: list[dict], keys_for_source: dict) -> str:
    """Deterministic per-source `schemaFingerprint` (SPEC §1.2: "hash of the
    introspected DDL", "drift detection"). Computed from a sorted,
    deterministic JSON projection of the source's own tables/columns/keys —
    NOT the whole multi-source catalog — so a change to `mock`'s schema
    doesn't spuriously bump `staging`'s fingerprint or vice versa.

    Deterministic given the same introspected shape: sorted-key JSON dump of
    a stable projection (tableId, column names+types+nullability, PK/FK
    shapes) — deliberately excludes anything non-deterministic across runs
    (row counts, timestamps, importanceScore) since those belong to
    `profiles.json`/`catalog.json`'s OTHER fields, not schema DDL identity.
    """
    projection = {
        "tables": sorted(
            (
                {
                    "tableId": t["tableId"],
                    "columns": sorted(
                        (c["name"], c["dataType"], c["nullable"], c["isPrimaryKey"])
                        for c in t.get("columns", [])
                    ),
                }
                for t in catalog_tables_for_source
            ),
            key=lambda t: t["tableId"],
        ),
        "primaryKeys": sorted(
            (pk["tableId"], tuple(pk["columns"])) for pk in keys_for_source.get("primaryKeys", [])
        ),
        "foreignKeys": sorted(
            (fk["fkId"] for fk in keys_for_source.get("foreignKeys", []))
        ),
    }
    payload = json.dumps(projection, sort_keys=True, default=list).encode("utf-8")
    return "sha256:" + hashlib.sha256(payload).hexdigest()


def new_bundle_version(now: datetime | None = None) -> str:
    """The `<buildTimestamp>_<shortManifestHash>` version stem's TIMESTAMP
    half (SPEC §1.1). The short-manifest-hash suffix is appended by
    `finalize_bundle_version` once the manifest body is known (the hash is
    computed FROM the manifest, so it cannot be part of the manifest's own
    `bundleVersion` field before that field is filled in — see
    `build_manifest`'s two-pass construction below).
    """
    now = now or datetime.now(timezone.utc)
    return f"v{now.strftime('%Y%m%dT%H%M%SZ')}"


def emit_full_bundle_files(
    out_dir: str | Path,
    joingraph: dict,
    glossary: dict,
    exemplars: dict,
) -> dict[str, str]:
    """Serialize the P3b-owned JSON artifacts (joingraph.json, glossary.json,
    exemplars.json — SPEC §1.5, §1.9, §1.10) alongside P3a's partial bundle.
    Returns their sha256 hashes keyed by filename, same convention as
    `emit_partial_bundle`.
    """
    out_dir = Path(out_dir)
    file_hashes: dict[str, str] = {}
    file_hashes["joingraph.json"] = _write_json(out_dir / "joingraph.json", joingraph)
    file_hashes["glossary.json"] = _write_json(out_dir / "glossary.json", glossary)
    file_hashes["exemplars.json"] = _write_json(out_dir / "exemplars.json", exemplars)
    return file_hashes


def build_manifest(
    *,
    bundle_version: str,
    created_at: str,
    builder_version: str,
    git_sha: str | None,
    embedding_model_summary: dict,
    sources: list[SourceManifestEntry],
    counts: dict,
    file_hashes: dict[str, str],
    phi_gate_result: dict,
) -> dict:
    """Build the full manifest.json document (SPEC §1.2). `embedding_model_summary`
    is `EmbeddingModelFingerprint.to_json()`'s shape (id/dimension/normalization/
    revision) — the manifest.json shape SPEC §1.2 shows uses `dimension`
    (spelled out), distinct from SPEC §0a decision #2's compact
    `{id,dim,lib,revision}` note; both carry the same information, this
    function emits the full §1.2 shape since manifest.json IS the §1.2
    artifact.
    """
    return {
        "bundleFormatVersion": "1.0.0",
        "bundleVersion": bundle_version,
        "createdAt": created_at,
        "builder": {
            "name": "ceiba-nl2sql-prep",
            "version": builder_version,
            "gitSha": git_sha,
        },
        "embeddingModel": embedding_model_summary,
        "sources": [s.to_json() for s in sources],
        "counts": counts,
        "files": dict(sorted(file_hashes.items())),
        "phiGate": phi_gate_result,
    }


def compute_short_manifest_hash(manifest_body: dict, length: int = 6) -> str:
    """Short hash suffix for the bundle directory name (SPEC §1.1
    `<buildTimestamp>_<shortManifestHash>`). Hashes a deterministic,
    sorted-key JSON dump of the manifest body EXCLUDING every wall-clock
    field: top-level `bundleVersion` itself (which is what we're computing a
    component of — self-reference would be circular), top-level `createdAt`,
    AND each `sources[].introspectedAt` (nested — easy to miss, and the
    field that actually varies run-to-run since `cmd_build` stamps it with
    `datetime.now()` per source). Determinism (SPEC §1.1 "rebuild is
    deterministic given the same sources + builder + embedding-model id")
    requires excluding EVERY wall-clock field from the content that seeds
    the version stem, not just the top-level ones — a single missed nested
    timestamp silently defeats reproducibility (caught by
    `prep/tests/test_manifest_integrity.py`'s determinism assertion).
    """
    stable = {k: v for k, v in manifest_body.items() if k not in ("bundleVersion", "createdAt")}
    if "sources" in stable:
        stable["sources"] = [
            {k: v for k, v in source.items() if k != "introspectedAt"} for source in stable["sources"]
        ]
    payload = json.dumps(stable, sort_keys=True, default=list).encode("utf-8")
    return hashlib.sha256(payload).hexdigest()[:length]


def build_build_report(
    bundle_version: str,
    stages: list[BuildStage],
    phi_gate_result: dict,
) -> dict:
    """Build BUILD_REPORT.json (SPEC §1.12). Non-load-bearing at runtime;
    retained for audit + reproducibility.
    """
    return {
        "bundleVersion": bundle_version,
        "stages": [s.to_json() for s in stages],
        "phiGate": {
            "passed": phi_gate_result["passed"],
            "checkedFiles": phi_gate_result["checkedFiles"],
            "violations": phi_gate_result["violations"],
        },
    }


def write_manifest_and_report(
    out_dir: str | Path,
    manifest: dict,
    build_report: dict,
) -> tuple[str, str]:
    """Write manifest.json + BUILD_REPORT.json; returns (manifest_sha256,
    build_report_sha256). manifest.json's OWN hash is not included in
    `manifest.json.files` (a file cannot hash itself), but IS returned here
    so `verify`/tests can independently confirm manifest.json's on-disk bytes
    match what was reported at build time (a lightweight self-integrity check
    layered on top of the SPEC §1.2 per-sibling-file hash set).
    """
    out_dir = Path(out_dir)
    manifest_hash = _write_json(out_dir / "manifest.json", manifest)
    report_hash = _write_json(out_dir / "BUILD_REPORT.json", build_report)
    return manifest_hash, report_hash


def update_latest_symlink(bundles_root: str | Path, bundle_dir_name: str) -> Path:
    """Point `bundles_root/latest` at `bundle_dir_name` (SPEC §1.1: "runtime
    resolves when no explicit version pinned"). Atomically replaces any
    existing symlink (or, defensively, a stray non-symlink `latest` path) so
    concurrent readers never observe a half-updated link — the traditional
    symlink-then-rename swap.
    """
    bundles_root = Path(bundles_root)
    link_path = bundles_root / "latest"
    tmp_link_path = bundles_root / ".latest.tmp"

    if tmp_link_path.exists() or tmp_link_path.is_symlink():
        tmp_link_path.unlink()

    tmp_link_path.symlink_to(bundle_dir_name, target_is_directory=True)
    tmp_link_path.replace(link_path)
    return link_path


def finalize_bundle_directory(
    parent_out_dir: str | Path,
    timestamp_stem: str,
    manifest_without_version: dict,
) -> tuple[Path, dict]:
    """Two-pass bundle version finalization (SPEC §1.1
    `<buildTimestamp>_<shortManifestHash>`):

      1. The manifest body is built with a PLACEHOLDER `bundleVersion` (the
         timestamp stem alone) — everything else (files/counts/embeddingModel/
         sources/phiGate) is already final at this point, since it's derived
         from already-written sibling files.
      2. The short hash is computed FROM that body (excluding the
         placeholder version + createdAt, see `compute_short_manifest_hash`),
         then the manifest's `bundleVersion` is updated to the final
         `<timestamp>_<hash>` form.

    This function does NOT move the bundle directory (the directory is
    created ONCE, already named with the final version, by the caller who
    calls `compute_short_manifest_hash` before creating any directory at all
    — see cli.py's `cmd_build_full` for the actual call order). It exists as
    a pure, side-effect-free helper so the two-pass logic is unit-testable in
    isolation from filesystem layout decisions.
    """
    short_hash = compute_short_manifest_hash(manifest_without_version)
    final_version = f"{timestamp_stem}_{short_hash}"
    finalized_manifest = dict(manifest_without_version)
    finalized_manifest["bundleVersion"] = final_version
    bundle_dir = Path(parent_out_dir) / final_version
    return bundle_dir, finalized_manifest
