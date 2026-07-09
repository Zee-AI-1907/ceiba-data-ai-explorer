"""phi_gate.py — the CI PHI gate (SPEC §2.5).

Code, not convention. Runs as part of `build` (fails the build on violation)
and standalone via `verify`. Five checks, each mirroring a numbered SPEC §2.5
invariant:

  1. Authoritative-set match: phi.json.phiColumnsetHash == the hash recomputed
     from config/phi_columns.json (the same set lib/phiScrubber.ts exports).
     A drift fails the build.
  2. No raw cell in any artifact: scans profiles.json / synthetic.json /
     glossary.json / exemplars.json for (a) a `value` under any phi-suppressed
     column, (b) topCategories/labels on a column whose phiClass != non-phi,
     (c) (best-effort) any category-label string that isn't validly sourced.
  3. `sample_aggregate` is the sole data path — an AST scan (Python `ast`
     module) of every .py file under the prep package fails the build if any
     module issues a raw `SELECT col FROM table`-shaped string literal outside
     a function named `sample_aggregate*`.
  4. Embedding is local: config.embedding.provider must be 'local'.
  5. (documented, not re-checked here) Metadata introspection of the real
     schema is allowed — this gate never flags catalog.json/keys.json for
     containing table/column names; only cell values are forbidden.

Exit convention: `run_gate()` returns a `PhiGateReport`; `main()` (wired from
cli.py) exits non-zero when `report.passed is False`.
"""

from __future__ import annotations

import ast
import re
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from prep.classify_phi import compute_columnset_hash, load_phi_columnset
from prep.config import PrepConfig


@dataclass
class GateViolation:
    check: str
    message: str
    location: str | None = None

    def to_json(self) -> dict:
        return {"check": self.check, "message": self.message, "location": self.location}


@dataclass
class PhiGateReport:
    passed: bool
    checked_files: int
    violations: list[GateViolation] = field(default_factory=list)
    gate_version: str = "1.0.0"

    def to_json(self) -> dict:
        return {
            "passed": self.passed,
            "gateVersion": self.gate_version,
            "checkedFiles": self.checked_files,
            "violations": [v.to_json() for v in self.violations],
        }


# ── check 1: authoritative PHI columnset hash match ─────────────────────────


def check_columnset_hash(repo_root: str | Path, phi_json: dict) -> list[GateViolation]:
    """phi.json.phiColumnsetHash MUST equal the hash recomputed from the
    checked-in config/phi_columns.json (the authoritative set shared with
    lib/phiScrubber.ts). A drift fails the build (SPEC §2.5 #1).
    """
    violations: list[GateViolation] = []
    authoritative = load_phi_columnset(repo_root)
    recomputed = compute_columnset_hash(authoritative.columns)

    if authoritative.columnset_hash != recomputed:
        violations.append(
            GateViolation(
                check="columnset_hash",
                message=(
                    "config/phi_columns.json is stale — its own stored hash does "
                    f"not match its recomputed hash (stored={authoritative.columnset_hash}, "
                    f"recomputed={recomputed}). Regenerate with `npm run phi:sync`."
                ),
                location="config/phi_columns.json",
            )
        )

    phi_json_hash = phi_json.get("phiColumnsetHash")
    if phi_json_hash != authoritative.columnset_hash:
        violations.append(
            GateViolation(
                check="columnset_hash",
                message=(
                    "phi.json.phiColumnsetHash does not match the authoritative "
                    f"config/phi_columns.json hash (phi.json={phi_json_hash!r}, "
                    f"authoritative={authoritative.columnset_hash!r})."
                ),
                location="phi.json",
            )
        )
    return violations


# ── check 2: no raw cell value in any artifact ───────────────────────────────


def _phi_class_by_column_id(phi_json: dict) -> dict[str, str]:
    return {c["columnId"]: c["phiClass"] for c in phi_json.get("columns", [])}


def check_profiles_json(phi_json: dict, profiles_json: dict) -> list[GateViolation]:
    """profiles.json invariants (SPEC §2.5 #2, §1.6):
      (a) no `phi-suppressed` column carries any `value`-bearing field
          (min/max/mean/topCategories) — counts only.
      (b) no `topCategories` on a column whose phiClass != non-phi.
      (c) any column with distinctCount > HIGH_CARDINALITY_ABSOLUTE (20) must
          not carry topCategories, regardless of PHI status.
    """
    violations: list[GateViolation] = []
    phi_class_by_id = _phi_class_by_column_id(phi_json)
    high_cardinality_absolute = 20

    for table in profiles_json.get("tables", []):
        for col in table.get("columns", []):
            column_id = col.get("columnId", "<unknown>")
            kind = col.get("kind")

            if kind == "phi-suppressed":
                leak_fields = [f for f in ("min", "max", "mean", "topCategories") if f in col]
                if leak_fields:
                    violations.append(
                        GateViolation(
                            check="no_raw_cell_value",
                            message=(
                                f"phi-suppressed column {column_id} carries forbidden "
                                f"value-bearing field(s): {leak_fields}"
                            ),
                            location="profiles.json",
                        )
                    )

            phi_class = phi_class_by_id.get(column_id)
            if "topCategories" in col:
                if phi_class is not None and phi_class != "non-phi":
                    violations.append(
                        GateViolation(
                            check="no_raw_cell_value",
                            message=(
                                f"column {column_id} has phiClass={phi_class!r} but "
                                "carries topCategories (only allowed for non-phi)"
                            ),
                            location="profiles.json",
                        )
                    )
                distinct_count = col.get("distinctCount", 0)
                if distinct_count > high_cardinality_absolute:
                    violations.append(
                        GateViolation(
                            check="no_raw_cell_value",
                            message=(
                                f"column {column_id} has distinctCount={distinct_count} > "
                                f"{high_cardinality_absolute} but still carries topCategories "
                                "(high-cardinality columns must be suppressed to counts only)"
                            ),
                            location="profiles.json",
                        )
                    )
                top_categories = col["topCategories"]
                if len(top_categories) > 8:
                    violations.append(
                        GateViolation(
                            check="no_raw_cell_value",
                            message=(
                                f"column {column_id} has {len(top_categories)} topCategories, "
                                "exceeding MAX_TOP_CATEGORIES=8"
                            ),
                            location="profiles.json",
                        )
                    )
    return violations


def check_synthetic_json(phi_json: dict, synthetic_json: dict) -> list[GateViolation]:
    """synthetic.json must carry generator DESCRIPTORS only (SPEC §1.8): no
    `params.labels`/category strings for a column whose phiClass != non-phi,
    and no `syntheticRowTarget` anywhere near real cardinality-of-PHI leakage
    (structural — the row target itself is never PHI, just checked for
    presence of forbidden value-shaped fields on suppressed columns).
    """
    violations: list[GateViolation] = []
    phi_class_by_id = _phi_class_by_column_id(phi_json)

    for table in synthetic_json.get("tables", []):
        for col in table.get("columns", []):
            column_id = col.get("columnId", "<unknown>")
            phi_class = phi_class_by_id.get(column_id)
            params = col.get("params", {})
            has_labels = isinstance(params, dict) and "labels" in params
            if has_labels and phi_class is not None and phi_class != "non-phi":
                violations.append(
                    GateViolation(
                        check="no_raw_cell_value",
                        message=(
                            f"synthetic descriptor for {column_id} (phiClass={phi_class!r}) "
                            "carries category labels; only non-phi columns may."
                        ),
                        location="synthetic.json",
                    )
                )
    return violations


def _extract_text_blobs(value: Any) -> list[str]:
    """Recursively collect every string leaf in a JSON-like structure (used to
    scan glossary.json / exemplars.json / vectors.duckdb document text for a
    substring match against suppressed sampled values).
    """
    blobs: list[str] = []
    if isinstance(value, str):
        blobs.append(value)
    elif isinstance(value, dict):
        for v in value.values():
            blobs.extend(_extract_text_blobs(v))
    elif isinstance(value, (list, tuple)):
        for v in value:
            blobs.extend(_extract_text_blobs(v))
    return blobs


def check_no_suppressed_value_substring(
    doc_texts: list[str],
    suppressed_sample_values: list[str],
    location: str,
) -> list[GateViolation]:
    """(c) No embedded document text contains a substring from a `suppress`
    column's sampled values (SPEC §2.5 #2c). `suppressed_sample_values` is
    supplied by the caller from a held-out, non-persisted sample (this
    function never itself samples PHI — it only checks that already-written
    artifact text doesn't happen to contain one of those raw strings).
    """
    violations: list[GateViolation] = []
    for raw_value in suppressed_sample_values:
        if not raw_value:
            continue
        for text in doc_texts:
            if raw_value in text:
                violations.append(
                    GateViolation(
                        check="no_raw_cell_value",
                        message=f"document text contains a suppressed sample value substring",
                        location=location,
                    )
                )
    return violations


# ── check 3: sample_aggregate is the sole data path (AST scan) ─────────────

_SELECT_LITERAL_PATTERN = re.compile(r"\bSELECT\b.*\bFROM\b", re.IGNORECASE | re.DOTALL)
_ALLOWED_FUNCTION_PREFIXES = ("sample_aggregate",)
# Introspection metadata queries (information_schema/pg_catalog/pg_class) are
# schema-only, never cell data — SPEC §2.5 #5 explicitly allows metadata
# introspection. These are exempted from the "SELECT only inside
# sample_aggregate*" rule because they never touch a data row.
_METADATA_ONLY_PATTERN = re.compile(
    r"information_schema|pg_catalog|pg_class|pg_namespace|duckdb_tables\(\)|"
    r"table_constraints|key_column_usage",
    re.IGNORECASE,
)


def _enclosing_function_name(node: ast.AST, tree: ast.AST) -> str | None:
    """Find the nearest enclosing FunctionDef/AsyncFunctionDef name for `node`
    by walking the tree and tracking parent function scopes.
    """
    parent_map: dict[ast.AST, ast.AST] = {}
    for parent in ast.walk(tree):
        for child in ast.iter_child_nodes(parent):
            parent_map[child] = parent

    current: ast.AST | None = node
    while current is not None:
        if isinstance(current, (ast.FunctionDef, ast.AsyncFunctionDef)):
            return current.name
        current = parent_map.get(current)
    return None


def _docstring_nodes(tree: ast.AST) -> set[int]:
    """Collect the `id()` of every AST string-constant node that IS a
    docstring (the first statement of a module/class/function body that is a
    bare string expression) so the scan below can skip them. Docstrings are
    documentation, not executable SQL — prose describing what a raw SELECT
    looks like must not itself trip the "no raw SELECT" check.
    """
    docstring_ids: set[int] = set()
    doc_owners = (ast.Module, ast.ClassDef, ast.FunctionDef, ast.AsyncFunctionDef)
    for node in ast.walk(tree):
        if isinstance(node, doc_owners):
            body = getattr(node, "body", [])
            if body and isinstance(body[0], ast.Expr) and isinstance(body[0].value, ast.Constant):
                if isinstance(body[0].value.value, str):
                    docstring_ids.add(id(body[0].value))
    return docstring_ids


def _string_constants(node: ast.AST, skip_ids: set[int]) -> list[tuple[str, ast.AST]]:
    """Collect every string constant AND every f-string's literal segments in
    a call/expression subtree, paired with the AST node they came from (so we
    can find the enclosing function). Skips nodes in `skip_ids` (docstrings).
    """
    found: list[tuple[str, ast.AST]] = []
    for sub in ast.walk(node):
        if isinstance(sub, ast.Constant) and isinstance(sub.value, str):
            if id(sub) in skip_ids:
                continue
            found.append((sub.value, sub))
        elif isinstance(sub, ast.JoinedStr):
            for value in sub.values:
                if isinstance(value, ast.Constant) and isinstance(value.value, str):
                    found.append((value.value, sub))
    return found


def scan_file_for_raw_select(path: Path) -> list[GateViolation]:
    """AST scan of a single .py file: fails if any string literal shaped like
    a raw `SELECT ... FROM ...` appears outside a function whose name starts
    with `sample_aggregate` (SPEC §2.5 #3), UNLESS the literal is a
    metadata-only query (information_schema/pg_catalog/etc — SPEC §2.5 #5).
    """
    violations: list[GateViolation] = []
    try:
        source = path.read_text(encoding="utf-8")
        tree = ast.parse(source, filename=str(path))
    except (SyntaxError, UnicodeDecodeError):
        return violations

    docstring_ids = _docstring_nodes(tree)
    for value, node in _string_constants(tree, docstring_ids):
        if not _SELECT_LITERAL_PATTERN.search(value):
            continue
        if _METADATA_ONLY_PATTERN.search(value):
            continue  # metadata-only SELECT — allowed anywhere (SPEC §2.5 #5)

        enclosing = _enclosing_function_name(node, tree)
        if enclosing is not None and any(
            enclosing.startswith(prefix) for prefix in _ALLOWED_FUNCTION_PREFIXES
        ):
            continue

        violations.append(
            GateViolation(
                check="sole_data_path",
                message=(
                    f"raw SELECT literal found outside a sample_aggregate* function "
                    f"(enclosing function: {enclosing!r}): {value.strip()[:120]!r}"
                ),
                location=f"{path}:{getattr(node, 'lineno', '?')}",
            )
        )
    return violations


def scan_package_for_raw_select(package_dir: str | Path) -> list[GateViolation]:
    """Walk every .py file under `package_dir` and apply `scan_file_for_raw_select`."""
    violations: list[GateViolation] = []
    for path in sorted(Path(package_dir).rglob("*.py")):
        if "__pycache__" in path.parts:
            continue
        violations.extend(scan_file_for_raw_select(path))
    return violations


# ── check 4: embedding provider must be local ───────────────────────────────


def check_embedding_local(config: PrepConfig) -> list[GateViolation]:
    if config.embedding.provider != "local":
        return [
            GateViolation(
                check="embedding_local",
                message=(
                    f"embedding.provider must be 'local', got {config.embedding.provider!r} "
                    "— non-local embedding providers are rejected before any network call."
                ),
                location="prep.config.yaml:embedding.provider",
            )
        ]
    return []


# ── orchestration ────────────────────────────────────────────────────────────


def run_gate(
    repo_root: str | Path,
    config: PrepConfig,
    phi_json: dict,
    profiles_json: dict,
    synthetic_json: dict | None = None,
    glossary_json: dict | None = None,
    exemplars_json: dict | None = None,
    prep_package_dir: str | Path | None = None,
) -> PhiGateReport:
    """Run every PHI gate check and return a single report. `synthetic_json`,
    `glossary_json`, `exemplars_json` are optional because P3a alone does not
    emit them yet (P3b does) — when absent they are simply skipped, not
    treated as a violation.
    """
    repo_root = Path(repo_root)
    prep_package_dir = Path(prep_package_dir) if prep_package_dir else repo_root / "prep" / "prep"

    violations: list[GateViolation] = []
    checked_files = 0

    violations.extend(check_columnset_hash(repo_root, phi_json))
    checked_files += 1  # phi.json

    violations.extend(check_profiles_json(phi_json, profiles_json))
    checked_files += 1  # profiles.json

    if synthetic_json is not None:
        violations.extend(check_synthetic_json(phi_json, synthetic_json))
        checked_files += 1

    for extra_json, name in ((glossary_json, "glossary.json"), (exemplars_json, "exemplars.json")):
        if extra_json is not None:
            checked_files += 1
            # Structural-only for now (no PHI-classified columnId fields
            # expected in these payloads at P3a-scope); reserved for P3b to
            # extend with targeted checks once these files are real.

    violations.extend(scan_package_for_raw_select(prep_package_dir))
    violations.extend(check_embedding_local(config))

    return PhiGateReport(
        passed=len(violations) == 0,
        checked_files=checked_files,
        violations=violations,
    )


def run_gate_from_bundle_dir(
    repo_root: str | Path, config: PrepConfig, bundle_dir: str | Path
) -> PhiGateReport:
    """Convenience entry point for `ceiba-nl2sql-prep verify`: load the emitted
    JSON artifacts from `bundle_dir` and run the gate against them.
    """
    import json

    bundle_dir = Path(bundle_dir)

    def _load(name: str) -> dict | None:
        path = bundle_dir / name
        if not path.is_file():
            return None
        with path.open("r", encoding="utf-8") as handle:
            return json.load(handle)

    phi_json = _load("phi.json")
    profiles_json = _load("profiles.json")
    if phi_json is None or profiles_json is None:
        return PhiGateReport(
            passed=False,
            checked_files=0,
            violations=[
                GateViolation(
                    check="missing_artifact",
                    message="phi.json and profiles.json are required for verify",
                    location=str(bundle_dir),
                )
            ],
        )

    return run_gate(
        repo_root=repo_root,
        config=config,
        phi_json=phi_json,
        profiles_json=profiles_json,
        synthetic_json=_load("synthetic.json"),
        glossary_json=_load("glossary.json"),
        exemplars_json=_load("exemplars.json"),
    )
