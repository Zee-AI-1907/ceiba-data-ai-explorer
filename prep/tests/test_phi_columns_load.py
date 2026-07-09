"""test_phi_columns_load.py — PHI bridge drift guard (Python side, SPEC §2.5).

Loads config/phi_columns.json (generated from lib/phiScrubber.ts via `npm run
phi:sync`) and recomputes the sha256 hash the exact same way the generator does
(sorted, normalized column keys joined by ','). Asserts it equals the stored
`phiColumnsetHash`. If the checked-in JSON is stale relative to its own hash, this
fails — mirroring the TS bridge tests so the Python prep toolchain and the TS
runtime provably agree on one PHI column set.
"""

import hashlib
import json
from pathlib import Path

# prep/tests/ -> prep/ -> repo root
REPO_ROOT = Path(__file__).resolve().parents[2]
PHI_COLUMNS_JSON = REPO_ROOT / "config" / "phi_columns.json"


def _load() -> dict:
    assert PHI_COLUMNS_JSON.is_file(), (
        f"{PHI_COLUMNS_JSON} missing — run `npm run phi:sync` to generate it"
    )
    with PHI_COLUMNS_JSON.open("r", encoding="utf-8") as handle:
        return json.load(handle)


def _compute_hash(phi_columns: list[str]) -> str:
    normalized_sorted = sorted(phi_columns)
    return hashlib.sha256(",".join(normalized_sorted).encode("utf-8")).hexdigest()


def test_phi_columns_json_shape():
    data = _load()
    assert isinstance(data.get("phiColumns"), list) and data["phiColumns"], (
        "phiColumns must be a non-empty list"
    )
    assert isinstance(data.get("phiColumnsetHash"), str) and data["phiColumnsetHash"], (
        "phiColumnsetHash must be a non-empty string"
    )


def test_phi_columnset_hash_matches():
    data = _load()
    recomputed = _compute_hash(data["phiColumns"])
    assert recomputed == data["phiColumnsetHash"], (
        "phiColumnsetHash drift: config/phi_columns.json is stale. "
        "Regenerate with `npm run phi:sync`.\n"
        f"  stored:     {data['phiColumnsetHash']}\n"
        f"  recomputed: {recomputed}"
    )


def test_phi_columns_are_normalized_and_sorted():
    data = _load()
    columns = data["phiColumns"]
    # Normalized: lowercase, no whitespace/hyphens (mirrors phiScrubber.normalizeKey).
    for key in columns:
        assert key == key.lower(), f"{key!r} is not lowercase"
        assert " " not in key and "-" not in key, f"{key!r} contains raw whitespace/hyphen"
    assert columns == sorted(columns), "phiColumns must be sorted"
    assert len(columns) == len(set(columns)), "phiColumns must be deduplicated"
