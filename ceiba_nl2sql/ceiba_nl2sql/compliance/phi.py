"""phi.py (formerly prep/prep/classify_phi.py) — stage [4]; reuses phiScrubber
PHI_COLUMNS (SPEC §2.5). Shared via ceiba_nl2sql
(docs/PYTHON_NL2SQL_SERVICE_PLAN.md §3.1/§3.2) so prep and the future NL->SQL
service call the exact same PHI classification code — one Python
implementation instead of a second copy in the service.

Loads the authoritative PHI set from config/phi_columns.json (generated from
lib/phiScrubber.ts via `npm run phi:sync`) so the prep toolchain and TS runtime
agree on one classification. Mirrors `normalizeKey` (lowercase, `[-\\s]`→`_`)
and the `isPhiColumn` semantics from lib/phiScrubber.ts EXACTLY — same
normalization, same set membership test — so a column classifies identically
in both languages.

Emits the `phi.json` shape (SPEC §1.7): each column gets a `phiClass` in
{direct-identifier, quasi-identifier, free-text, non-phi} and a derived
`egressPolicy` in {suppress, aggregate-only, allow} per the mapping table in
SPEC §1.7:
    direct-identifier | quasi-identifier -> suppress
    free-text                            -> suppress (free text may embed names)
    non-phi                              -> aggregate-only
"""

from __future__ import annotations

import hashlib
import json
import re
from dataclasses import dataclass
from pathlib import Path
from typing import Literal

PhiClass = Literal["direct-identifier", "quasi-identifier", "free-text", "non-phi"]
EgressPolicy = Literal["suppress", "aggregate-only", "allow"]

# ── normalizeKey mirror (lib/phiScrubber.ts) ────────────────────────────────
# TS: key.toLowerCase().replace(/[-\s]/g, '_')
_NORMALIZE_PATTERN = re.compile(r"[-\s]")


def normalize_key(key: str) -> str:
    """Mirror of lib/phiScrubber.ts `normalizeKey`: lowercase, `[-\\s]` -> `_`."""
    return _NORMALIZE_PATTERN.sub("_", key.lower())


# ── direct-identifier vs quasi-identifier sub-classification ───────────────
# The authoritative PHI_COLUMNS set (config/phi_columns.json) is flat — it does
# not itself distinguish "direct" from "quasi" identifiers. We refine that
# single set into the SPEC §1.7 four-way phiClass using column-name semantics
# that are stable, deterministic, and reviewable (no heuristics on data).
#
# Direct identifiers: uniquely and directly identify a person on their own
# (an ID number, a full name, contact info that routes to one person).
_DIRECT_IDENTIFIER_KEYS = frozenset(
    {
        "patientid",
        "patient_id",
        "mrn",
        "ssn",
        "nationalid",
        "national_id",
        "tc_kimlik",
        "tckimlik",
        "firstname",
        "lastname",
        "patient_first_name",
        "patient_last_name",
        "name",
        "patientfirstname",
        "patientlastname",
        "patient_name",
        "fullname",
        "full_name",
        "phone",
        "email",
    }
)

# Quasi-identifiers: not identifying alone, but identifying in combination
# (birth date, address) — HIPAA safe-harbor treats these as PHI requiring
# suppression too, just via a different rationale than a direct identifier.
_QUASI_IDENTIFIER_KEYS = frozenset(
    {
        "dob",
        "dateofbirth",
        "birthdate",
        "birth_date",
        "address",
    }
)

# Column-name patterns that indicate free text (notes/comments columns) which
# may embed a name or other identifier even though the column itself is not on
# the authoritative PHI_COLUMNS allowlist (SPEC §1.7 free-text rationale).
_FREE_TEXT_NAME_HINTS = (
    "note",
    "notes",
    "comment",
    "comments",
    "remark",
    "remarks",
    "freetext",
    "free_text",
    # Clinical narrative fields observed on the real staging schema
    # (Shared/KVC anamnesis-style tables — docs/DATA_SOURCES.md): unbounded
    # narrative text a clinician typed, which can embed a patient's name or
    # other identifying detail even though the column name itself is generic.
    "complaint",
    "story",
    "anamnesis",
    "history",
    "resume",
    "summary",
    "description",
    "physicalexamination",
    "examination",
    "diagnosis_text",
    "diagnosistext",
    "anomaly_text",
    "anomalytext",
    "drugsused",
    "drugused",
    "medication_text",
    "medicationtext",
)

# Person-role / direct-&-quasi-identifier NAME tokens that must NEVER be
# rescued as a coded vocabulary, at ANY cardinality. Each denotes a person
# (father/mother/relative/doctor/nurse/…) or a direct identifier stored as
# low-distinct text (a national ID, passport, phone, e-mail). On the real
# staging schema these are exactly the columns the P2 low-cardinality rescue
# was leaking: low distinct only because they are mostly NULL (sparsity), not
# because the value space is closed. Matched as SUBSTRINGS of the normalized
# key so compound names are covered (`MotherName`, `RequestingDoctor`,
# `ConsentPersonnelTcNo`, `FamilyDoctorPhoneNumber`). Deliberately does NOT
# include a bare "name" — `DeviceName`/`DiseaseName`/`RoleName` are genuine
# coded vocabularies that must survive. Turkish spellings included: the staging
# schema is bilingual (hekim=doctor, hemşire=nurse, doğumyeri=birthplace,
# pasaport=passport, kimlik=identity, imza=signature).
_PHI_NAME_HINTS = (
    "father",
    "mother",
    "parent",
    "relative",
    "spouse",
    "guardian",
    "caregiver",
    "requester",
    "requesting",
    "physician",
    "doctor",
    "hekim",
    "nurse",
    "hemsire",
    "birthplace",
    "birth_place",
    "dogumyeri",
    "passport",
    "pasaport",
    "tckn",
    "tcno",
    "tc_kimlik",
    "tckimlik",
    "kimlik",
    "national_id",
    "nationalid",
    "contactno",
    "contact_no",
    "phone",
    "telefon",
    "gsm",
    "fax",
    "faks",
    "email",
    "eposta",
    "consent",
    "signature",
    "imza",
    "sicil",
)

# Unbounded string SQL types that MUST default to free-text suppression unless
# the column name is explicitly known-safe (see `_KNOWN_SAFE_TEXT_NAME_HINTS`)
# — a `text`/`varchar` column is exactly the shape a clinician's free-text
# narrative lives in, so absent a positive non-phi signal we suppress rather
# than silently trust the name-based allowlist alone (SPEC §1.7 free-text
# rationale: "free text may embed names").
_UNBOUNDED_TEXT_TYPE_HINTS = ("text", "varchar", "character varying", "clob", "ntext")

# Column-name patterns that positively identify a bounded, coded, or
# structural string column — safe to profile even though its SQL type is
# text/varchar (e.g. a status code, a unit label, a type discriminator).
# Only consulted when `data_type` indicates an unbounded string type; a name
# NOT matching one of these (and not matching a PHI/free-text hint) still
# falls through to non-phi, since narrowing further would require a
# denylist-shaped judgment call the prep tool should not make silently.
_KNOWN_SAFE_TEXT_NAME_HINTS = (
    "status",
    "code",
    "type",
    "category",
    "kind",
    "unit",
    "state",
    "flag",
    "gender",
    "bloodgroup",
    "language",
)


@dataclass(frozen=True)
class PhiColumnSet:
    """The authoritative PHI column set loaded from config/phi_columns.json."""

    columns: frozenset[str]
    columnset_hash: str


def load_phi_columnset(repo_root: str | Path) -> PhiColumnSet:
    """Load config/phi_columns.json — the single authoritative PHI set shared
    with lib/phiScrubber.ts. Raises FileNotFoundError if missing (the file is
    generated by `npm run phi:sync` and checked in by P0).
    """
    path = Path(repo_root) / "config" / "phi_columns.json"
    if not path.is_file():
        raise FileNotFoundError(
            f"{path} missing — run `npm run phi:sync` to generate it from lib/phiScrubber.ts"
        )
    with path.open("r", encoding="utf-8") as handle:
        data = json.load(handle)
    columns = frozenset(data["phiColumns"])
    return PhiColumnSet(columns=columns, columnset_hash=data["phiColumnsetHash"])


def compute_columnset_hash(columns: frozenset[str] | list[str]) -> str:
    """Recompute the columnset hash the same way scripts/gen-phi-columns.mjs does:
    sha256 of the sorted, comma-joined normalized column keys. Used by the PHI
    gate (phi_gate.py) to detect drift between phi.json and the checked-in
    config/phi_columns.json.
    """
    normalized_sorted = sorted(columns)
    return hashlib.sha256(",".join(normalized_sorted).encode("utf-8")).hexdigest()


def is_phi_column(key: str, phi_columns: frozenset[str]) -> bool:
    """Mirror of lib/phiScrubber.ts `isPhiColumn`: normalize then set-membership."""
    return normalize_key(key) in phi_columns


def _looks_like_free_text(normalized_key: str) -> bool:
    return any(hint in normalized_key for hint in _FREE_TEXT_NAME_HINTS)


def _looks_like_phi_name(normalized_key: str) -> bool:
    """True if the column name denotes a person or a direct identifier that must
    never be treated as a coded vocabulary (see `_PHI_NAME_HINTS`)."""
    return any(hint in normalized_key for hint in _PHI_NAME_HINTS)


def _looks_like_known_safe_text(normalized_key: str) -> bool:
    return any(hint in normalized_key for hint in _KNOWN_SAFE_TEXT_NAME_HINTS)


def _is_unbounded_text_type(data_type: str | None) -> bool:
    if not data_type:
        return False
    lowered = data_type.lower()
    return any(hint in lowered for hint in _UNBOUNDED_TEXT_TYPE_HINTS)


# P2 categorical rescue: a text-typed column with NO name-based PHI/free-text
# signal whose WHOLE-TABLE distinct count (pg_stats, not a sample) is at or
# under this bound is a closed coded vocabulary (status/type/code), not
# narrative free text — narrative text is unbounded by nature. Only the
# TYPE-based heuristic is ever rescued; the authoritative PHI set and the
# name-based free-text hints always win.
LOW_CARDINALITY_CODED_TEXT_MAX = 50

# A rescue's entire purpose is to EMIT example values; a mostly-null column has
# almost none to emit AND its low distinct count is a sparsity artifact, not a
# closed vocabulary. Above this whole-table null fraction the low-cardinality
# rescue is refused — this is what stops the sparse-identifier leaks (e.g.
# `IcuMonitoringRecords.RelativeTcNo` at 99.99% null, `Patients.FatherName` at
# 98.5% null) even for names the denylist does not enumerate. `null_frac=None`
# (no evidence) does not by itself block a rescue that otherwise has positive
# distinct evidence — fail-closed still comes from the name/type checks above.
RESCUE_MAX_NULL_FRACTION = 0.5


def classify_column(
    column_name: str,
    phi_columns: frozenset[str],
    data_type: str | None = None,
    *,
    distinct_count_estimate: int | None = None,
    null_frac: float | None = None,
) -> tuple[PhiClass, str | None]:
    """Classify a single column name (+ optional declared SQL type) into a
    SPEC §1.7 `phiClass`.

    Returns (phi_class, matched_rule). `matched_rule` mirrors the phi.json
    shape's `"PHI_COLUMNS:<normalizedKey>"` marker when the authoritative set
    matched, or a free-text heuristic tag, or None for non-phi.

    `data_type` is optional (name-only classification still works, matching
    lib/phiScrubber.ts which never sees a SQL type) but STRONGLY recommended
    for the prep toolchain: an unbounded `text`/`varchar` column is exactly
    the shape a clinician's free-text narrative lives in (e.g.
    `KVC.Anamneses.Complaint`, `.Story`, `.FamilyHistory` on the real staging
    schema — none of which match a name-based "notes" hint). Absent a
    positive known-safe-text name signal, an unbounded string column defaults
    to `free-text` rather than silently trusting the name alone.

    `distinct_count_estimate` (P2 categorical rescue) is WHOLE-TABLE evidence
    (pg_stats n_distinct — never a bounded sample, which can make a
    high-cardinality column look small). On Postgres every string column is
    `text`, so the type heuristic alone suppresses the entire coded
    vocabulary of the schema (status/type/code columns) unless its name
    happens to be on the known-safe list. A column whose whole-table distinct
    count is a small closed set (<= LOW_CARDINALITY_CODED_TEXT_MAX) is a
    coded vocabulary, not narrative — narrative text is unbounded by nature.
    The rescue applies ONLY to the type-based branch: the authoritative PHI
    set and the name-based free-text hints always suppress regardless of
    cardinality (a `Gender` or `Notes` column stays suppressed at any
    distinct count).

    Three additional guards keep the rescue from leaking identifiers whose low
    distinct count is a SPARSITY artifact rather than a closed vocabulary
    (validated against the real staging schema, which the mock fixtures do not
    exercise): (1) a person/direct-identifier NAME denylist (`_PHI_NAME_HINTS`
    — father/mother/doctor/tcno/passport/phone/…) suppresses before the rescue
    at any cardinality; (2) a `*Text` suffix (`OtherText`, `DirectCoombsText`)
    is treated as "other, specify" free text; (3) `null_frac` (whole-table,
    pg_stats) above `RESCUE_MAX_NULL_FRACTION` refuses the rescue — a
    mostly-null column has almost no values to emit and its low distinct is an
    artifact of the NULLs. `null_frac=None` leaves the rescue to the
    name/type/cardinality checks (still fail-closed).
    """
    normalized = normalize_key(column_name)

    if normalized in phi_columns:
        if normalized in _DIRECT_IDENTIFIER_KEYS:
            return "direct-identifier", f"PHI_COLUMNS:{normalized}"
        if normalized in _QUASI_IDENTIFIER_KEYS:
            return "quasi-identifier", f"PHI_COLUMNS:{normalized}"
        # In the authoritative set but not in either curated sub-list (e.g. a
        # future addition to phi_columns.json) — default conservatively to
        # direct-identifier so it is suppressed, never silently downgraded.
        return "direct-identifier", f"PHI_COLUMNS:{normalized}"

    if _looks_like_free_text(normalized):
        return "free-text", f"heuristic:free-text:{normalized}"

    # A person-role / direct-identifier name (father/mother/doctor/tcno/phone/…)
    # can never be a coded vocabulary — suppress it BEFORE the low-cardinality
    # rescue can fire, at any cardinality. Closes the confirmed staging leak
    # (MotherName+MotherIdNumber, RelativeTcNo, FamilyDoctorPhoneNumber, …)
    # that the flat authoritative set misses. See `_PHI_NAME_HINTS`.
    if _looks_like_phi_name(normalized):
        return "quasi-identifier", f"heuristic:phi-name:{normalized}"

    # "Other, specify" free-text: a `*Text` column (OtherText, ChestTubeText,
    # DirectCoombsText) is an unbounded clinician entry that happens to be
    # sparsely used, not a coded set — treat as free-text regardless of type.
    if normalized.endswith("text"):
        return "free-text", f"heuristic:specify-text:{normalized}"

    if _is_unbounded_text_type(data_type) and not _looks_like_known_safe_text(normalized):
        if (
            distinct_count_estimate is not None
            and 0 < distinct_count_estimate <= LOW_CARDINALITY_CODED_TEXT_MAX
            and (null_frac is None or null_frac <= RESCUE_MAX_NULL_FRACTION)
        ):
            return "non-phi", f"heuristic:low-cardinality-coded-text:{normalized}"
        return "free-text", f"heuristic:unbounded-text-type:{normalized}"

    return "non-phi", None


_PHI_CLASS_TO_EGRESS_POLICY: dict[PhiClass, EgressPolicy] = {
    "direct-identifier": "suppress",
    "quasi-identifier": "suppress",
    "free-text": "suppress",
    "non-phi": "aggregate-only",
}


def egress_policy_for(phi_class: PhiClass) -> EgressPolicy:
    """SPEC §1.7 phiClass -> egressPolicy mapping."""
    return _PHI_CLASS_TO_EGRESS_POLICY[phi_class]


@dataclass(frozen=True)
class ColumnPhiClassification:
    column_id: str
    normalized_key: str
    phi_class: PhiClass
    matched_rule: str | None
    egress_policy: EgressPolicy

    def to_json(self) -> dict:
        return {
            "columnId": self.column_id,
            "normalizedKey": self.normalized_key,
            "phiClass": self.phi_class,
            "matchedRule": self.matched_rule,
            "egressPolicy": self.egress_policy,
        }


def classify_columns(
    column_ids_and_names: list[tuple],
    phi_columns: frozenset[str],
) -> list[ColumnPhiClassification]:
    """Classify a batch of (columnId, columnName[, dataType[,
    distinctCountEstimate[, nullFrac]]]) tuples.

    `columnId` is the canonical bundle key (e.g.
    "staging.Shared.Patients.IdentificationNumber"); `columnName` is the bare
    column name used for PHI-set matching (matching is name-based, not
    path-based, mirroring lib/phiScrubber.ts which only ever sees a column
    key). An optional third element, `dataType`, sharpens the free-text
    heuristic for unbounded string columns; an optional fourth,
    `distinctCountEstimate` (whole-table, pg_stats), enables the P2
    low-cardinality coded-text rescue; an optional fifth, `nullFrac`
    (whole-table, pg_stats), refuses that rescue for mostly-null columns
    whose low distinct is a sparsity artifact (see `classify_column`).
    """
    results: list[ColumnPhiClassification] = []
    for entry in column_ids_and_names:
        column_id, column_name = entry[0], entry[1]
        data_type = entry[2] if len(entry) > 2 else None
        distinct_estimate = entry[3] if len(entry) > 3 else None
        null_frac = entry[4] if len(entry) > 4 else None
        phi_class, matched_rule = classify_column(
            column_name,
            phi_columns,
            data_type,
            distinct_count_estimate=distinct_estimate,
            null_frac=null_frac,
        )
        results.append(
            ColumnPhiClassification(
                column_id=column_id,
                normalized_key=normalize_key(column_name),
                phi_class=phi_class,
                matched_rule=matched_rule,
                egress_policy=egress_policy_for(phi_class),
            )
        )
    return results


def build_phi_json(
    column_ids_and_names: list[tuple],
    phi_columns: frozenset[str],
    phi_columnset_hash: str,
) -> dict:
    """Build the full phi.json document (SPEC §1.7)."""
    classifications = classify_columns(column_ids_and_names, phi_columns)
    return {
        "phiColumnsetHash": phi_columnset_hash,
        "columns": [c.to_json() for c in classifications],
    }
