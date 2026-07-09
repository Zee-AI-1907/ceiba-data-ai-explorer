"""vectors_phi_scan.py — PHI-gate extension covering vectors.duckdb (SPEC §2.5
invariant 2c). P3b-owned helper; does NOT modify `prep/prep/phi_gate.py`'s
existing signatures (P3a-owned) — `run_gate_including_vectors` below wraps
`prep.phi_gate.run_gate` and adds one more check on top, so callers that only
need the P3a-scope checks keep using `phi_gate.run_gate` unchanged.

SPEC §2.5 invariant 2: *"The gate scans profiles.json, synthetic.json,
glossary.json, exemplars.json, AND vectors.duckdb.documents.text"* for a
suppressed-column value substring. P3a's `phi_gate.py` already covers the
four JSON files (`check_no_suppressed_value_substring` exists there, generic
over any text-blob list); this module supplies the vectors.duckdb-specific
half: reading `documents.text` and running the SAME substring check, plus a
structural check that no `doc_kind='column'` document exists for a
suppressed columnId in the first place (defense in depth ahead of the
substring check — see `embed/vss_index.py`'s `build_column_document`, which
already refuses to build such a document, so this is a second, independent
guard rather than the only one).
"""

from __future__ import annotations

from dataclasses import dataclass, field
from pathlib import Path

from prep.embed.vss_index import read_all_document_texts
from prep.phi_gate import GateViolation, PhiGateReport, check_no_suppressed_value_substring, run_gate


def check_vectors_duckdb_no_suppressed_column_docs(
    documents: list[dict],
    phi_class_by_column_id: dict[str, str],
) -> list[GateViolation]:
    """Structural check: no `doc_kind='column'` document's `ref_id` names a
    column whose phiClass != non-phi. Each `documents` dict entry has at
    least `doc_kind` and `ref_id` (matching the `documents` table schema in
    vss_index.py, SPEC §1.11).
    """
    violations: list[GateViolation] = []
    for doc in documents:
        if doc.get("doc_kind") != "column":
            continue
        ref_id = doc.get("ref_id", "<unknown>")
        phi_class = phi_class_by_column_id.get(ref_id)
        if phi_class is not None and phi_class != "non-phi":
            violations.append(
                GateViolation(
                    check="no_raw_cell_value",
                    message=(
                        f"vectors.duckdb documents contains a doc_kind='column' entry "
                        f"for suppressed column {ref_id} (phiClass={phi_class!r})"
                    ),
                    location="vectors.duckdb:documents",
                )
            )
    return violations


def check_vectors_duckdb_no_suppressed_value_substring(
    duckdb_path: str | Path,
    suppressed_sample_values: list[str],
) -> list[GateViolation]:
    """SPEC §2.5 invariant 2c applied to vectors.duckdb specifically: no
    `documents.text` value contains a substring from a `suppress` column's
    sampled values. Delegates to phi_gate.py's generic
    `check_no_suppressed_value_substring` (P3a-owned, reused not
    reimplemented) after reading `text` out of the DuckDB file (read-only).
    """
    texts = read_all_document_texts(duckdb_path)
    return check_no_suppressed_value_substring(
        doc_texts=texts,
        suppressed_sample_values=suppressed_sample_values,
        location="vectors.duckdb:documents.text",
    )


@dataclass
class VectorsPhiGateReport:
    """Combines the P3a-scope `PhiGateReport` with the additional
    vectors.duckdb-specific violations, so callers get ONE report to check
    without re-deriving `passed` themselves.
    """

    base: PhiGateReport
    vectors_violations: list[GateViolation] = field(default_factory=list)

    @property
    def passed(self) -> bool:
        return self.base.passed and len(self.vectors_violations) == 0

    @property
    def all_violations(self) -> list[GateViolation]:
        return list(self.base.violations) + list(self.vectors_violations)

    def to_json(self) -> dict:
        return {
            "passed": self.passed,
            "gateVersion": self.base.gate_version,
            "checkedFiles": self.base.checked_files + 1,  # +1 for vectors.duckdb
            "violations": [v.to_json() for v in self.all_violations],
        }


def run_gate_including_vectors(
    *,
    repo_root: str | Path,
    config,
    phi_json: dict,
    profiles_json: dict,
    duckdb_path: str | Path,
    vectors_documents: list[dict],
    suppressed_sample_values: list[str] | None = None,
    synthetic_json: dict | None = None,
    glossary_json: dict | None = None,
    exemplars_json: dict | None = None,
    prep_package_dir: str | Path | None = None,
    catalog_json: dict | None = None,
) -> VectorsPhiGateReport:
    """Run the full P3a gate (`prep.phi_gate.run_gate`, unmodified) PLUS the
    vectors.duckdb-specific checks this module owns. This is the entry point
    `cli.py`'s `build` command wires for the full P3b bundle (SPEC §2.4 stage
    [7] EMIT: "run PHI gate" — the P3b build must gate over the EMBEDDED
    documents too, per this task's explicit requirement).
    """
    base_report = run_gate(
        repo_root=repo_root,
        config=config,
        phi_json=phi_json,
        profiles_json=profiles_json,
        synthetic_json=synthetic_json,
        glossary_json=glossary_json,
        exemplars_json=exemplars_json,
        prep_package_dir=prep_package_dir,
        catalog_json=catalog_json,
    )

    phi_class_by_column_id = {c["columnId"]: c["phiClass"] for c in phi_json.get("columns", [])}

    vectors_violations = check_vectors_duckdb_no_suppressed_column_docs(
        vectors_documents, phi_class_by_column_id
    )
    vectors_violations.extend(
        check_vectors_duckdb_no_suppressed_value_substring(
            duckdb_path, suppressed_sample_values or []
        )
    )

    return VectorsPhiGateReport(base=base_report, vectors_violations=vectors_violations)
