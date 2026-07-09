"""emit.py — stage [7] (partial); serialize catalog/keys/profiles/phi + hashes.

Full manifest.json / BUILD_REPORT.json / joingraph.json / glossary.json /
exemplars.json / vectors.duckdb emission is P3b (needs enrich/embed). This
module does the P3a-scoped partial emit: catalog.json, keys.json,
profiles.json, phi.json, and a per-file sha256 so P3b's manifest builder can
fold these hashes into `manifest.json.files` without re-reading the files.

Every artifact here is written with `json.dumps(..., sort_keys=True)` for
deterministic byte-for-byte output (rebuild determinism — SPEC §1.1).
"""

from __future__ import annotations

import hashlib
import json
from dataclasses import dataclass
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
