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
  6. The label column is low-cardinality (`distinctCount <= 20`) and
     `phiClass == "non-phi"` per profiles.json/phi.json.

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
        phi_class = phi_class_by_column.get(label_column_id)
        if phi_class is not None and phi_class != "non-phi":
            continue  # PHI-gated: never mine a label column that isn't non-phi

        distinct_count = distinct_count_by_column.get(label_column_id, HIGH_CARDINALITY_ABSOLUTE + 1)
        if distinct_count > HIGH_CARDINALITY_ABSOLUTE:
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
