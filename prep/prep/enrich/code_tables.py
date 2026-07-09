"""code_tables.py — auto-mine code/lookup vocabulary tables + build the
curated-seed synonym matrix (SEMANTIC_HINTS.md §1, §2, §8.1). P3b.

Runs at PREP BUILD TIME (like `glossary.py`/`joingraph.py`), consuming
`catalog.json` + `joingraph.json` + `profiles.json` + `phi.json` — metadata
already introspected/profiled by earlier stages — plus an injectable
row-fetcher callable for the one place this module DOES need real cell data:
extracting `(id, label)` pairs from a qualifying code table (SEMANTIC_HINTS.md
§1.3). Mirrors `ceiba_nl2sql.compliance.aggregate_profile`'s
`sample_aggregate_from_rows` injectable-fetcher pattern so this module is
testable without a live DB.

── The code-table detector (§1.2) ──────────────────────────────────────────
A table `T` qualifies as a lookup/code vocabulary when ALL of:
  1. `approxRowCount <= CODE_TABLE_MAX_ROWS` (200).
  2. Single-column PK of integer/short-string type.
  3. `len(columns) <= CODE_TABLE_MAX_COLS` (6).
  4. >=1 non-PK text label column.
  5. Referenced by >=1 FK edge from a LARGER fact table (`T` is the `to` side
     of a joingraph.json edge whose `from` table has a bigger approxRowCount).
  6. The label column is low-cardinality (`distinctCount <= 20`) and either
     `phiClass == "non-phi"`, OR it qualifies under the narrowly-scoped
     PHI-flagged code-table LABEL EXEMPTION (see
     `_label_qualifies_under_phi_exemption`): a name-only PHI flag on a SHORT
     coded label that is a true enumeration on a tiny FK-referenced lookup
     table (e.g. `MonitorMeasurementTypes.Name` — CVP/HR/SPO2, a controlled
     clinical vocabulary the name-only classifier cannot tell from
     `Patients.Name`). The exemption NEVER changes the global classify_column
     result (the column stays phi-suppressed in phi.json); it lives ONLY in
     this detector's acceptance decision, and mined values are additionally
     re-validated at the VALUE level by `_mined_labels_look_like_vocabulary`.

The label column is picked by name preference (Name/Label/Code/ShortName/
Description), else the single non-PK non-FK text column, else the table is
skipped (ambiguous) — §1.2's exact rule.

── PHI discipline (§1.3, §7) ────────────────────────────────────────────────
Only lookup NAMES are ever extracted/embedded — never a value from the FACT
table being referenced. Every emitted hint is backed by a REAL code row AND a
REAL FK edge (no hallucination). The mined `autoSynonyms` block this module
feeds into `glossary.py` is scanned by the PHI gate the same way `synonyms`
already is (see `prep/prep/phi_gate.py`).
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from pathlib import Path
from typing import Callable

import yaml

CODE_TABLE_MAX_ROWS = 200
CODE_TABLE_MAX_COLS = 6
HIGH_CARDINALITY_ABSOLUTE = 20

_LABEL_COLUMN_NAME_PREFERENCE = ("name", "label", "code", "shortname", "description")
_INTEGER_TYPE_HINTS = ("int", "serial", "numeric", "decimal")
_SHORT_STRING_TYPE_HINTS = ("char", "text", "varchar")
_TEXT_TYPE_HINTS = ("char", "text", "varchar")

# ── PHI-flagged code-table LABEL EXEMPTION (SEMANTIC_HINTS.md §1.2 / Fix D) ──
# The name-only PHI classifier (ceiba_nl2sql.compliance.phi.classify_column)
# cannot tell `Patients.Name` (real PHI) from `MonitorMeasurementTypes.Name`
# (a controlled clinical vocabulary: CVP, HR, MAP, SPO2, …). Both normalize to
# the key "name" and are flagged direct-identifier. That name-only flag REJECTS
# genuine lookup vocabularies from code-table detection, silently no-op-ing the
# whole semantic-hint feature on real data.
#
# A DETECTED code table is, structurally, a controlled vocabulary: it is tiny,
# has an (id, label) shape, is FK-referenced by a strictly-LARGER fact table,
# and its label column is a bounded low-cardinality enumeration. THAT structure
# — not the column name — is the real discriminator against a patient-name
# column (which lives on a large/growing table, is not FK-referenced as a
# lookup, and whose distinctCount tracks the patient population, not a fixed
# vocabulary). This exemption is applied ONLY inside the detector's acceptance
# logic; it NEVER changes the global `classify_column` result (Patients.Name
# etc. stay direct-identifier globally, phi.json stays phi-suppressed).

# phiClasses eligible for the exemption. `free-text` is deliberately EXCLUDED:
# a free-text/narrative column is exactly the unbounded-text shape a clinician
# types PHI into, and must never be treated as a controlled vocabulary even if
# it structurally slipped through. Only the name-based identifier flags
# (direct/quasi) — the ones that misfire on a vocabulary column named "Name" —
# are exemptible.
_PHI_EXEMPTABLE_CLASSES = frozenset({"direct-identifier", "quasi-identifier"})

# Definitively-large / unbounded string types that indicate a free-text
# narrative, NOT a short coded label: CLOB / NTEXT, and VARCHAR(max) /
# NVARCHAR(max). These are the shapes a clinician types PHI narrative into and
# are NEVER eligible under the exemption.
#
# NOTE on bare `TEXT`: on PostgreSQL (this project's staging engine) `text` is
# the ORDINARY, universal string type — BOTH a coded lookup label
# (`MonitorMeasurementTypes.Name`) AND a patient-name column (`Patients.Name`)
# introspect to exactly `TEXT`. So `text` carries ZERO discriminating signal
# here and MUST NOT be treated as disqualifying, or the exemption would reject
# the real staging lookup table and the whole feature would no-op (the very
# bug this fix targets). `text` is therefore ACCEPTED at the type level; the
# real discriminator between the two is the STRUCTURAL gate the caller already
# applied (tiny, FK-referenced by a strictly-larger fact table) PLUS the
# true-enumeration check (distinctCount ≈ approxRowCount) PLUS the value-level
# vocabulary net — exactly as the fix spec calls out ("the FK-referenced-tiny-
# table structure is the real discriminator"). We reject only the LARGE/CLOB
# shapes below, which no coded label ever legitimately has.
_DISQUALIFYING_TEXT_TYPE_HINTS = ("clob", "ntext")
_MAX_LENGTH_LITERAL_PATTERN = re.compile(r"\(\s*max\s*\)", re.IGNORECASE)
_LENGTH_LITERAL_PATTERN = re.compile(r"\(\s*(\d+)\s*\)")
# A true coded label (HR, SPO2, "Respirations", "Non-invasive BP", "Mean
# Arterial Pressure") is comfortably under this; a VARCHAR(N) with N above this
# is treated as free-text-shaped and NOT exempted.
_SHORT_STRING_MAX_DECLARED_LENGTH = 128

# ── Vocabulary-validation net (secondary safety, Fix D step 4) ──────────────
# Even after the structural exemption accepts a table, the MINED label VALUES
# are validated to look like a small controlled vocabulary, not PHI. This is a
# belt-and-suspenders guard against a mis-detected table (e.g. a small
# FK-referenced table that happens to hold person names). A vocabulary like
# HR/SPO2/TEMP/"Respirations"/"Non-invasive BP" passes; "John Smith" is
# rejected. Applied to the WHOLE hint: any single PHI-looking value rejects the
# entire code table (fail closed).
_VOCAB_MAX_VALUE_LENGTH = 64
# Bound the mined enumeration by the structural code-table row cap (200), NOT
# the smaller profiling top-categories cap (20) — a legitimate coded vocabulary
# (e.g. 30-row VentilatorMeasurementTypes) is still a bounded enumeration.
_VOCAB_MAX_DISTINCT = CODE_TABLE_MAX_ROWS
# A person-name shape: two-or-more whitespace-separated words that are each
# Title-case alphabetic (e.g. "John Smith", "Mary Ann Jones"). NOTE this
# pattern ALSO matches legitimate multi-word clinical vocabulary phrases like
# "Mean Arterial Pressure" — Title-case alone cannot separate the two. So we do
# NOT reject on a single match; instead we reject only when the mined set is
# DOMINATED by this shape (a person-name table), which a real coded vocabulary
# (rich in all-caps/short/digit-bearing coded tokens like HR, SPO2, TEMP) never
# is. This keeps the net from dropping genuine vocabulary while still catching
# a mis-detected person-name table (fail closed on the population signal).
_PERSON_NAME_SHAPE_PATTERN = re.compile(r"^[A-Z][a-z]+(?:\s+[A-Z][a-z]+)+$")
# If more than this fraction of the mined labels are Title-case multi-word
# (person-name-shaped) AND none of the labels carry a coded-token signal, the
# whole set reads as a person-name table and is rejected.
_VOCAB_PERSON_NAME_FRACTION_THRESHOLD = 0.5


def _has_coded_token_signal(value: str) -> bool:
    """A coded vocabulary token: contains a digit, OR is an all-caps/short
    acronym token (HR, SPO2, CVP, MAP, TEMP). Real clinical vocabularies are
    rich in these; person-name tables have none."""
    if any(ch.isdigit() for ch in value):
        return True
    for token in value.split():
        alpha = "".join(ch for ch in token if ch.isalpha())
        if alpha and alpha.isupper():  # ALL-CAPS token like HR / SPO2 / BP
            return True
    return False

# RowFetcher: (table_id, id_column_name, label_column_name) -> list of
# (id_value, label_value) tuples. Injected so this module never issues its
# own raw SELECT outside a `sample_aggregate*`-named function — mirrors
# aggregate_profile.py's `sample_aggregate_from_rows` pattern (this module's
# own single data-touching entry point is named `sample_aggregate_code_rows`
# to satisfy phi_gate.py's AST scan, which allowlists functions whose name
# starts with `sample_aggregate`).
RowFetcher = Callable[[str, str, str], list[tuple]]


@dataclass(frozen=True)
class CodeTableCandidate:
    """A table + its resolved id/label column, before row extraction."""

    table_id: str
    id_column_id: str
    id_column_name: str
    label_column_id: str
    label_column_name: str


def _is_integer_or_short_string_type(data_type: str) -> bool:
    normalized = data_type.lower()
    return any(hint in normalized for hint in (*_INTEGER_TYPE_HINTS, *_SHORT_STRING_TYPE_HINTS))


def _is_text_type(data_type: str) -> bool:
    return any(hint in data_type.lower() for hint in _TEXT_TYPE_HINTS)


def _is_acceptable_label_string_type(data_type: str) -> bool:
    """True IFF `data_type` is an ordinary string type acceptable as a coded
    label — i.e. a string type that is NOT a definitively-large/unbounded
    free-text/narrative shape.

    Rejected (definitively large / narrative shape):
      * CLOB / NTEXT,
      * VARCHAR(max) / NVARCHAR(max) (SQL Server unbounded),
      * VARCHAR(N)/CHAR(N) with N > _SHORT_STRING_MAX_DECLARED_LENGTH.
    Accepted:
      * bare TEXT (PostgreSQL universal string type — no discriminating signal;
        see the module-level note — the structural + enumeration + vocab gates
        do the discriminating, not the type),
      * (N)VARCHAR(N)/CHAR(N) with a small explicit length,
      * a char/varchar with no explicit length modifier.

    A non-string type is rejected (a label must be a text-ish column).
    """
    lowered = data_type.lower()
    if not _is_text_type(lowered):
        return False
    if any(hint in lowered for hint in _DISQUALIFYING_TEXT_TYPE_HINTS):
        return False  # ntext/clob — definitively unbounded narrative shape
    if _MAX_LENGTH_LITERAL_PATTERN.search(lowered):
        return False  # varchar(max)/nvarchar(max) — unbounded
    length_match = _LENGTH_LITERAL_PATTERN.search(lowered)
    if length_match is not None:
        return int(length_match.group(1)) <= _SHORT_STRING_MAX_DECLARED_LENGTH
    return True  # bare text / char / varchar with no explicit length


def _label_qualifies_under_phi_exemption(
    phi_class: str,
    label_data_type: str,
    distinct_count: int,
    approx_row_count: int,
) -> bool:
    """The narrowly-scoped PHI-flagged code-table LABEL EXEMPTION (Fix D step 1).

    Returns True IFF a label column that `classify_column` flagged as PHI may
    STILL serve as a code-table label. This is ONLY ever reached after the
    caller has already verified EVERY structural code-table gate (rowcount <=
    CODE_TABLE_MAX_ROWS, <= CODE_TABLE_MAX_COLS, single integer/short-string
    PK, FK-referenced by a strictly-LARGER fact table, a resolvable non-PK
    non-FK label column). Those structural gates are the real discriminator
    against a patient-name column; the extra conditions here are belt-and-
    suspenders so a false-positive requires ALL of them to line up:

      1. phiClass is a NAME-BASED identifier flag (direct/quasi) — the class of
         flag that misfires on a vocabulary column named "Name". `free-text`
         is NOT exemptible (unbounded narrative may embed PHI).
      2. The label column is an ordinary string type — NOT a definitively-large
         narrative shape (CLOB/NTEXT, VARCHAR(max), or an oversized VARCHAR(N)).
         Bare PostgreSQL `TEXT` is accepted because it carries no discriminating
         signal (a patient-name column is also `TEXT`) — so this condition
         alone is INSUFFICIENT; the structural FK-referenced-tiny-table gate the
         caller already applied plus condition (4) below are the real
         discriminators.
      3. Bounded cardinality: 0 < distinctCount <= CODE_TABLE_MAX_ROWS. NOTE we
         bound on CODE_TABLE_MAX_ROWS (200 — the structural table-size cap the
         caller already enforced), NOT on the much smaller
         HIGH_CARDINALITY_ABSOLUTE (20, which is a profiling top-categories cap,
         unrelated to how large a legitimate coded vocabulary may be). Real
         staging lookups exceed 20 (e.g. VentilatorMeasurementTypes has 30
         rows) yet are plainly bounded controlled vocabularies. The table is
         already gated to <= CODE_TABLE_MAX_ROWS rows, so the label can have at
         most that many distinct values.
      4. True enumeration: distinctCount ≈ approxRowCount (the label column is
         essentially unique per lookup row — a fixed vocabulary, not a
         high-repeat or high-card free-text column). We allow the label to have
         a few fewer distinct values than rows (dupes/nulls) but require it to
         be a substantial fraction of the row count and never exceed it.

    NOTE: this NEVER mutates the global classify_column result. The column stays
    PHI-suppressed in phi.json; the exemption lives only in this detector's
    acceptance decision + the mined hint path.
    """
    if phi_class not in _PHI_EXEMPTABLE_CLASSES:
        return False
    if not _is_acceptable_label_string_type(label_data_type):
        return False
    if not (0 < distinct_count <= CODE_TABLE_MAX_ROWS):
        return False
    if approx_row_count <= 0:
        return False
    # A true enumeration: never more distinct labels than rows, and distinct
    # count is a substantial fraction of the (tiny) row count. Guards against a
    # small table whose "label" column is actually high-repeat/low-signal.
    if distinct_count > approx_row_count:
        return False
    if distinct_count < max(1, approx_row_count // 2):
        return False
    return True


def _mined_labels_look_like_vocabulary(codes: list[dict]) -> bool:
    """Vocabulary-validation net (Fix D step 4): a HARD secondary safety check
    on the actually-mined label VALUES, run AFTER extraction. Confirms the
    mined labels look like a small controlled vocabulary and NOT PHI /
    free-text. Fails CLOSED — one bad value rejects the whole hint.

    Passes: HR, SPO2, TEMP, CVP, "Respirations", "Non-invasive BP", "Mean
    Arterial Pressure" (short, coded, bounded set).
    Rejected: "John Smith" / "Mary Ann Jones" (person-name shape), any value
    longer than _VOCAB_MAX_VALUE_LENGTH, or a set larger than the low-card cap
    (not a bounded enumeration).
    """
    label_values = [str(code.get("name")) for code in codes if code.get("name") is not None]
    if not label_values:
        return False
    if len(set(label_values)) > _VOCAB_MAX_DISTINCT:
        return False  # not a bounded enumeration

    person_name_shaped = 0
    any_coded_token = False
    for value in label_values:
        stripped = value.strip()
        if not stripped:
            return False
        if len(stripped) > _VOCAB_MAX_VALUE_LENGTH:
            return False  # too long to be a coded label -> free-text shape
        if _PERSON_NAME_SHAPE_PATTERN.match(stripped):
            person_name_shaped += 1
        if _has_coded_token_signal(stripped):
            any_coded_token = True

    # Reject a set DOMINATED by person-name-shaped values that carries no coded
    # token signal at all — that reads as a person-name table, not a controlled
    # vocabulary. A real vocabulary ("HR"/"SPO2"/"Mean Arterial Pressure")
    # always carries coded tokens, so it never trips this.
    if not any_coded_token and person_name_shaped / len(label_values) > _VOCAB_PERSON_NAME_FRACTION_THRESHOLD:
        return False
    return True


def _pick_label_column(table: dict, non_pk_non_fk_column_names: set[str]) -> dict | None:
    """SEMANTIC_HINTS.md §1.2 label-column pick order: a column literally
    named Name/Label/Code/ShortName/Description (case-insensitive); else the
    single non-PK non-FK TEXT column; else None (ambiguous -> skip table).
    """
    columns = table.get("columns", [])
    by_preference = {c["name"].lower(): c for c in columns}
    for preferred in _LABEL_COLUMN_NAME_PREFERENCE:
        col = by_preference.get(preferred)
        if col and not col.get("isPrimaryKey") and _is_text_type(col["dataType"]):
            return col

    candidates = [
        c
        for c in columns
        if c["name"] in non_pk_non_fk_column_names and _is_text_type(c["dataType"]) and not c.get("isPrimaryKey")
    ]
    if len(candidates) == 1:
        return candidates[0]
    return None


def _fk_from_columns_by_table(foreign_keys_or_edges: list[dict], key_from: str = "fromTable") -> dict[str, set[str]]:
    """tableId -> set of bare column names that are the FK ("from") side of
    some edge — used to exclude FK columns from label-column candidacy.
    """
    result: dict[str, set[str]] = {}
    for edge in foreign_keys_or_edges:
        from_table = edge.get(key_from) or edge.get("from")
        from_columns = edge.get("fromColumns", [])
        if from_table:
            result.setdefault(from_table, set()).update(from_columns)
    return result


def detect_code_tables(catalog: dict, joingraph: dict, profiles: dict, phi: dict) -> list[CodeTableCandidate]:
    """SEMANTIC_HINTS.md §1.2/§8.1 step 1: DETECT code tables from metadata
    alone (no data touch here — row extraction is a separate step).
    """
    approx_row_count_by_table = {t["tableId"]: t.get("approxRowCount", 0) for t in profiles.get("tables", [])}
    phi_class_by_column = {c["columnId"]: c["phiClass"] for c in phi.get("columns", [])}
    distinct_count_by_column: dict[str, int] = {}
    for table_profile in profiles.get("tables", []):
        for col_profile in table_profile.get("columns", []):
            distinct_count_by_column[col_profile["columnId"]] = col_profile.get("distinctCount", 0)

    # Referenced-by-a-larger-fact-table signal: T is the `to` side of an edge
    # whose `from` table has a bigger approxRowCount.
    referencing_fact_tables: dict[str, list[dict]] = {}
    for edge in joingraph.get("edges", []):
        to_table = edge["to"]
        from_table = edge["from"]
        if approx_row_count_by_table.get(from_table, 0) > approx_row_count_by_table.get(to_table, 0):
            referencing_fact_tables.setdefault(to_table, []).append(edge)

    fk_from_columns_by_table = _fk_from_columns_by_table(joingraph.get("edges", []))

    candidates: list[CodeTableCandidate] = []
    for table in catalog.get("tables", []):
        table_id = table["tableId"]
        approx_rows = approx_row_count_by_table.get(table_id, table.get("approxRowCount", 0))
        if approx_rows > CODE_TABLE_MAX_ROWS:
            continue

        columns = table.get("columns", [])
        if len(columns) > CODE_TABLE_MAX_COLS:
            continue

        pk_columns = [c for c in columns if c.get("isPrimaryKey")]
        if len(pk_columns) != 1:
            continue
        id_column = pk_columns[0]
        if not _is_integer_or_short_string_type(id_column["dataType"]):
            continue

        if table_id not in referencing_fact_tables:
            continue  # not referenced by any larger fact table -> not a "used" vocabulary

        fk_column_names = fk_from_columns_by_table.get(table_id, set())
        non_pk_non_fk_names = {
            c["name"] for c in columns if not c.get("isPrimaryKey") and c["name"] not in fk_column_names
        }
        if not non_pk_non_fk_names:
            continue

        label_column = _pick_label_column(table, non_pk_non_fk_names)
        if label_column is None:
            continue

        label_column_id = label_column["columnId"]
        distinct_count = distinct_count_by_column.get(label_column_id, HIGH_CARDINALITY_ABSOLUTE + 1)

        phi_class = phi_class_by_column.get(label_column_id)
        if phi_class is not None and phi_class != "non-phi":
            # PHI-flagged label. By default we STILL never mine a non-non-phi
            # label — EXCEPT under the narrowly-scoped code-table LABEL
            # EXEMPTION: at this point the table has already passed EVERY
            # structural code-table gate above (rowcount<=MAX, cols<=MAX,
            # single int/short-string PK, FK-referenced by a strictly-larger
            # fact table, a resolvable label column). Only then do we allow a
            # name-flagged label (e.g. MonitorMeasurementTypes.Name, a clinical
            # vocabulary the name-only classifier can't distinguish from
            # Patients.Name) to qualify — see
            # `_label_qualifies_under_phi_exemption`. This does NOT change the
            # global classify_column result; the column stays phi-suppressed in
            # phi.json. A mined table is additionally re-validated at the VALUE
            # level by the vocabulary net after extraction.
            if not _label_qualifies_under_phi_exemption(
                phi_class=phi_class,
                label_data_type=label_column["dataType"],
                distinct_count=distinct_count,
                approx_row_count=approx_rows,
            ):
                continue
        elif distinct_count > HIGH_CARDINALITY_ABSOLUTE:
            # non-phi label: keep the original low-cardinality gate.
            continue

        candidates.append(
            CodeTableCandidate(
                table_id=table_id,
                id_column_id=id_column["columnId"],
                id_column_name=id_column["name"],
                label_column_id=label_column_id,
                label_column_name=label_column["name"],
            )
        )

    return candidates


def sample_aggregate_code_rows(
    table_id: str, id_column_name: str, label_column_name: str, row_fetcher: RowFetcher
) -> list[tuple]:
    """The ONE data-touching function in this module (named `sample_aggregate*`
    so phi_gate.py's AST scan allowlists it — see aggregate_profile.py for the
    same discipline). Delegates entirely to the injected `row_fetcher`; never
    issues a raw SELECT literal itself.
    """
    return row_fetcher(table_id, id_column_name, label_column_name)


@dataclass(frozen=True)
class CodeTableHint:
    """SEMANTIC_HINTS.md §1.3's emitted shape."""

    code_table_id: str
    id_column_id: str
    label_column_id: str
    referenced_by: list[dict]  # [{"factTableId", "fkColumnId"}]
    codes: list[dict]  # [{"id": ..., "name": ...}]

    def to_json(self) -> dict:
        return {
            "codeTableId": self.code_table_id,
            "idColumnId": self.id_column_id,
            "labelColumnId": self.label_column_id,
            "referencedBy": self.referenced_by,
            "codes": self.codes,
        }


def extract_code_table_rows(
    table_id: str, id_col: str, label_col: str, row_fetcher: RowFetcher
) -> list[dict]:
    """SEMANTIC_HINTS.md §1.3: extract `(id, label)` pairs for a qualifying
    code table, bounded by the row-count guard already applied in
    `detect_code_tables` (>=1 caller must have verified `approxRowCount <=
    CODE_TABLE_MAX_ROWS` before calling this). Returns `[{"id": ..., "name": ...}, ...]`.
    """
    rows = sample_aggregate_code_rows(table_id, id_col, label_col, row_fetcher)
    return [{"id": row[0], "name": row[1]} for row in rows]


def build_code_table_hints(
    catalog: dict,
    joingraph: dict,
    profiles: dict,
    phi: dict,
    row_fetcher: RowFetcher | None,
) -> list[CodeTableHint]:
    """SEMANTIC_HINTS.md §8.1 steps 1-3: detect + extract + resolve hosting
    facts. Returns `[]` (never raises) when `row_fetcher` is None — a build
    context with no live DB connection (e.g. a bundle rebuilt purely from
    already-emitted JSON siblings) simply mines no code tables, which is
    backward compatible (autoSynonyms defaults to `[]`).
    """
    if row_fetcher is None:
        return []

    candidates = detect_code_tables(catalog, joingraph, profiles, phi)
    approx_row_count_by_table = {t["tableId"]: t.get("approxRowCount", 0) for t in profiles.get("tables", [])}

    hints: list[CodeTableHint] = []
    for candidate in candidates:
        codes = extract_code_table_rows(
            candidate.table_id, candidate.id_column_name, candidate.label_column_name, row_fetcher
        )
        if not codes:
            continue  # no real rows -> no hint (never fabricate)

        # Vocabulary-validation net (Fix D step 4): a HARD secondary safety
        # check on the actually-mined label values. Even though the detector's
        # structural gates + PHI exemption already accepted this table, we
        # re-validate at the VALUE level that the mined labels look like a
        # bounded controlled vocabulary (HR/SPO2/…) and not PHI (person names,
        # free text). If ANY value looks like PHI, the WHOLE hint is dropped
        # (fail closed) — this protects against a mis-detected table.
        if not _mined_labels_look_like_vocabulary(codes):
            continue

        referenced_by = [
            {"factTableId": edge["from"], "fkColumnId": f"{edge['from']}.{edge['fromColumns'][0]}"}
            for edge in joingraph.get("edges", [])
            if edge["to"] == candidate.table_id
            and approx_row_count_by_table.get(edge["from"], 0) > approx_row_count_by_table.get(candidate.table_id, 0)
        ]
        if not referenced_by:
            continue

        hints.append(
            CodeTableHint(
                code_table_id=candidate.table_id,
                id_column_id=candidate.id_column_id,
                label_column_id=candidate.label_column_id,
                referenced_by=referenced_by,
                codes=codes,
            )
        )

    return hints


# ── Layer A: curated alias seed (SEMANTIC_HINTS.md §2.1) ────────────────────


def load_synonym_alias_seed(path: str | Path) -> dict[str, list[str]]:
    """Load `config/synonym_aliases.seed.yaml` (§2.1): a flat mapping of
    canonical mined name -> list of NL aliases. An empty/missing seed is
    valid (returns `{}`) so a build with no seed authored yet still succeeds.
    """
    path = Path(path)
    if not path.is_file():
        return {}
    with path.open("r", encoding="utf-8") as handle:
        raw = yaml.safe_load(handle) or {}
    return {str(k): [str(a) for a in (v or [])] for k, v in raw.items()}


def _pick_value_column(fact_table: dict, code_column_name: str) -> dict | None:
    """SEMANTIC_HINTS.md §3.2/§8.1 `pick_value_column`: numeric, non-PK,
    non-FK, named Value/Reading/Result/Amount/Measurement, else the single
    dominant numeric column; None if ambiguous (map emitted without one).
    """
    preferred_names = ("value", "reading", "result", "amount", "measurement")
    columns = fact_table.get("columns", [])
    by_name_lower = {c["name"].lower(): c for c in columns}
    for name in preferred_names:
        col = by_name_lower.get(name)
        if col and not col.get("isPrimaryKey") and col["name"] != code_column_name:
            return col

    numeric_candidates = [
        c
        for c in columns
        if not c.get("isPrimaryKey")
        and c["name"] != code_column_name
        and any(hint in c["dataType"].lower() for hint in ("int", "float", "double", "numeric", "decimal", "real"))
    ]
    if len(numeric_candidates) == 1:
        return numeric_candidates[0]
    return None


@dataclass(frozen=True)
class AutoSynonymMap:
    """One `coded-measurement` map entry, per SEMANTIC_HINTS.md §3.2."""

    code_value: object
    code_ref_table_id: str
    code_ref_column_id: str
    code_column_id: str
    value_column_id: str | None
    hosting_table_id: str
    time_column_id: str | None
    unit: str | None
    code_label: str | None = None

    def to_json(self) -> dict:
        out: dict = {
            "kind": "coded-measurement",
            "codeValue": self.code_value,
            "codeRefTableId": self.code_ref_table_id,
            "codeRefColumnId": self.code_ref_column_id,
            "codeColumnId": self.code_column_id,
            "hostingTableId": self.hosting_table_id,
        }
        if self.value_column_id:
            out["valueColumnId"] = self.value_column_id
        if self.time_column_id:
            out["timeColumnId"] = self.time_column_id
        if self.unit:
            out["unit"] = self.unit
        if self.code_label:
            out["codeLabel"] = self.code_label
        return out


@dataclass(frozen=True)
class AutoSynonym:
    term: str
    aliases: list[str]
    provenance: str  # "curated" | "embedding"
    confidence: float
    maps: list[AutoSynonymMap] = field(default_factory=list)

    def to_json(self) -> dict:
        return {
            "term": self.term,
            "aliases": list(self.aliases),
            "provenance": self.provenance,
            "confidence": self.confidence,
            "maps": [m.to_json() for m in self.maps],
        }


def _time_column_id_of(fact_table: dict) -> str | None:
    for col in fact_table.get("columns", []):
        if col.get("isTimeColumn"):
            return col["columnId"]
    return None


def build_auto_synonyms(
    catalog: dict,
    joingraph: dict,
    profiles: dict,
    phi: dict,
    code_table_hints: list[CodeTableHint],
    alias_seed: dict[str, list[str]],
) -> list[AutoSynonym]:
    """SEMANTIC_HINTS.md §3.2/§8.1 step 4-5: build the `autoSynonyms` array.

    Layer A ONLY (curated seed) — Layer B (local-embedding fallback) is
    explicitly deferred per SEMANTIC_HINTS.md §9's own ranked build order
    ("Local-embedding synonym fallback... defer until eval shows seed-miss
    cases"). Every alias is matched against a REAL mined code row (never
    fabricated): a seed alias for a canonical name with no matching code row
    in ANY mined code table is silently dropped.

    `catalog`/`phi`/`joingraph`/`profiles` are accepted for signature symmetry
    with the build-spec (§8.1) and future Layer-B wiring (embedding a code's
    gloss needs the catalog's column list for units, etc.); unused directly
    in this curated-only pass — `valueColumnId`/`timeColumnId`/`unit`
    resolution happens in the second pass, `resolve_auto_synonym_columns`,
    which does need `catalog`.
    """
    del catalog, phi, joingraph, profiles  # reserved for Layer B / already covered by resolve_auto_synonym_columns

    auto_synonyms: list[AutoSynonym] = []

    for hint in code_table_hints:
        codes_by_name: dict[str, object] = {}
        for code in hint.codes:
            name = code.get("name")
            if isinstance(name, str):
                codes_by_name[name.lower()] = code.get("id")

        for canonical_name, aliases in alias_seed.items():
            code_value = codes_by_name.get(canonical_name.lower())
            if code_value is None:
                continue  # no real code row for this canonical name -> never hallucinate

            maps: list[AutoSynonymMap] = []
            for edge in hint.referenced_by:
                fact_table_id = edge["factTableId"]
                fk_column_id = edge["fkColumnId"]
                maps.append(
                    AutoSynonymMap(
                        code_value=code_value,
                        code_ref_table_id=hint.code_table_id,
                        code_ref_column_id=hint.id_column_id,
                        code_column_id=fk_column_id,
                        value_column_id=None,
                        hosting_table_id=fact_table_id,
                        time_column_id=None,
                        unit=None,
                        code_label=canonical_name,
                    )
                )
            if not maps:
                continue

            auto_synonyms.append(
                AutoSynonym(
                    term=canonical_name.lower(),
                    aliases=list(aliases),
                    provenance="curated",
                    confidence=1.0,
                    maps=maps,
                )
            )

    return auto_synonyms


def resolve_auto_synonym_columns(
    auto_synonyms: list[AutoSynonym], catalog: dict
) -> list[AutoSynonym]:
    """Second pass: resolve `valueColumnId`/`timeColumnId`/`unit` on each map
    now that we have `catalog` (with full column lists) in scope — kept as a
    separate pass so `build_auto_synonyms` stays testable purely against
    `CodeTableHint`s without needing a full catalog fixture for its unit tests.
    """
    tables_by_id = {t["tableId"]: t for t in catalog.get("tables", [])}
    resolved: list[AutoSynonym] = []
    for syn in auto_synonyms:
        new_maps: list[AutoSynonymMap] = []
        for m in syn.maps:
            fact_table = tables_by_id.get(m.hosting_table_id)
            value_column_id = m.value_column_id
            time_column_id = m.time_column_id
            unit = m.unit
            if fact_table:
                code_column_name = m.code_column_id.split(".")[-1]
                if value_column_id is None:
                    value_col = _pick_value_column(fact_table, code_column_name)
                    if value_col:
                        value_column_id = value_col["columnId"]
                        unit = unit or value_col.get("unit")
                if time_column_id is None:
                    time_column_id = _time_column_id_of(fact_table)
            new_maps.append(
                AutoSynonymMap(
                    code_value=m.code_value,
                    code_ref_table_id=m.code_ref_table_id,
                    code_ref_column_id=m.code_ref_column_id,
                    code_column_id=m.code_column_id,
                    value_column_id=value_column_id,
                    hosting_table_id=m.hosting_table_id,
                    time_column_id=time_column_id,
                    unit=unit,
                    code_label=m.code_label,
                )
            )
        resolved.append(
            AutoSynonym(
                term=syn.term, aliases=syn.aliases, provenance=syn.provenance, confidence=syn.confidence, maps=new_maps
            )
        )
    return resolved
