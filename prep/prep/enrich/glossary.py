"""glossary.py — glossary/synonym/code/unit/temporal build (SPEC §1.9). P3b.

Generalizes `lib/clinicalContext.ts` (`CLINICAL_ABBREVIATIONS`, `TIME_RANGE_HINTS`,
`extractTimeRangeHint`) from hardcoded TypeScript into versioned, DB-agnostic
DATA: `config/glossary.seed.yaml` is the hand-authored seed (extended by this
module), and this module resolves every seed reference against the ACTUAL
introspected catalog for the current build, then emits `glossary.json` (SPEC
§1.9).

Key generalization vs. `clinicalContext.ts`'s `TIME_RANGE_HINTS`: every legacy
TS hint hardcoded `AcceptanceDate` as the filter column regardless of what the
phrase was actually about (`"today"`, `"this week"`, etc. all silently
resolved to `AcceptanceDate >= ...`). Here, a temporal phrase's `kind` is
either:

  - `relative-to-now`: the window is anchored to wall-clock "now" at query
    time, independent of any specific column — the caller picks the actual
    time column from the FACT being filtered (e.g. "heart rate in the last 3
    hours" resolves the "heart rate" synonym's own `timeColumnId`, not a
    fixed admission-date column).
  - `relative-to-event`: the window anchors to a NAMED event column
    (`eventColumnId`), e.g. "within 24h of admission" -> `Acceptances.AcceptanceDate`.

This is exactly the SPEC §1.9 callout: *"the generator picks the time column
by the fact being filtered ... not on AcceptanceDate (the bug generalized
away from TIME_RANGE_HINTS)"*.

Reference resolution discipline: every seed entry names a BARE table/column
reference (`schema.table` or `schema.table.column`, no `sourceId` prefix,
since the seed is written once and must work whether staging/mock/both are
introspected). This module resolves each bare reference against every
`sourceId` present in the current build's catalog and emits ONE `maps[]`
entry per source that actually has a matching table/column — never a
fabricated node (same discipline as `joingraph.py`'s curated cross-source
correlations, so a `--only mock` build emits only the mock-side resolutions).
"""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path
from typing import Any

import yaml


# ── catalog resolution index ────────────────────────────────────────────────


@dataclass(frozen=True)
class CatalogIndex:
    """A fast lookup index over catalog.json's `tables` (SPEC §1.3), built
    once per build and reused for every seed entry's resolution pass.
    """

    # bare "schema.table" (any sourceId) -> list of fully-qualified tableIds
    tables_by_bare_ref: dict[str, list[str]]
    # bare "schema.table.column" -> list of fully-qualified columnIds
    columns_by_bare_ref: dict[str, list[str]]
    # tableId -> its time column's columnId, if it has exactly one obvious one
    time_column_by_table: dict[str, str]
    # columnId -> the column's `unit` field from catalog.json, if any
    unit_by_column: dict[str, str]

    def tables_for(self, bare_ref: str) -> list[str]:
        return self.tables_by_bare_ref.get(bare_ref, [])

    def columns_for(self, bare_ref: str) -> list[str]:
        return self.columns_by_bare_ref.get(bare_ref, [])


def _bare_table_ref(table_id: str) -> str:
    """tableId is `<sourceId>.<schema>.<table>` (SPEC §1.3) -> strip sourceId."""
    parts = table_id.split(".")
    return ".".join(parts[1:]) if len(parts) >= 3 else table_id


def _bare_column_ref(column_id: str) -> str:
    """columnId is `<sourceId>.<schema>.<table>.<column>` -> strip sourceId."""
    parts = column_id.split(".")
    return ".".join(parts[1:]) if len(parts) >= 4 else column_id


def build_catalog_index(catalog: dict) -> CatalogIndex:
    tables_by_bare_ref: dict[str, list[str]] = {}
    columns_by_bare_ref: dict[str, list[str]] = {}
    time_column_by_table: dict[str, str] = {}
    unit_by_column: dict[str, str] = {}

    for table in catalog.get("tables", []):
        table_id = table["tableId"]
        bare_table = _bare_table_ref(table_id)
        tables_by_bare_ref.setdefault(bare_table, []).append(table_id)

        time_columns = []
        for col in table.get("columns", []):
            column_id = col["columnId"]
            bare_column = _bare_column_ref(column_id)
            columns_by_bare_ref.setdefault(bare_column, []).append(column_id)
            if col.get("unit"):
                unit_by_column[column_id] = col["unit"]
            if col.get("isTimeColumn"):
                time_columns.append(column_id)

        if len(time_columns) == 1:
            time_column_by_table[table_id] = time_columns[0]
        elif time_columns:
            # Multiple time columns: prefer one whose bare name suggests the
            # "recorded at" / primary event timestamp over an incidental one
            # (e.g. RecordedAt over CreatedAt/UpdatedAt).
            preferred = next(
                (c for c in time_columns if _bare_column_ref(c).split(".")[-1].lower() in ("recordedat", "acceptancedate", "admittedat")),
                time_columns[0],
            )
            time_column_by_table[table_id] = preferred

    return CatalogIndex(
        tables_by_bare_ref=tables_by_bare_ref,
        columns_by_bare_ref=columns_by_bare_ref,
        time_column_by_table=time_column_by_table,
        unit_by_column=unit_by_column,
    )


# ── seed loading ─────────────────────────────────────────────────────────────


def load_glossary_seed(path: str | Path) -> dict:
    """Load config/glossary.seed.yaml (SPEC §2.2 `enrich.glossary`). An empty
    or missing seed is valid (P3a's placeholder shape) -> returns the empty
    shape rather than raising, so a build with a not-yet-authored seed still
    succeeds (glossary.json is simply empty in that case).
    """
    path = Path(path)
    if not path.is_file():
        return {"synonyms": [], "abbreviations": {}, "codeSystems": [], "units": [], "temporal": []}
    with path.open("r", encoding="utf-8") as handle:
        raw = yaml.safe_load(handle) or {}
    return {
        "synonyms": raw.get("synonyms") or [],
        "abbreviations": raw.get("abbreviations") or {},
        "codeSystems": raw.get("codeSystems") or [],
        "units": raw.get("units") or [],
        "temporal": raw.get("temporal") or [],
    }


# ── synonym resolution ───────────────────────────────────────────────────────


def _resolve_synonym_map_entry(entry: dict, index: CatalogIndex) -> list[dict]:
    """Resolve one seed `synonyms[].maps[]` entry against the catalog,
    returning zero or more glossary.json-shaped map entries (SPEC §1.9). Zero
    when the referenced table/column doesn't exist in this build's catalog —
    never fabricated.
    """
    kind = entry.get("kind")
    resolved: list[dict] = []

    if kind == "table":
        table_ref = entry["tableRef"]
        for table_id in index.tables_for(table_ref):
            resolved.append({"tableId": table_id, "kind": "table"})

    elif kind == "column":
        column_ref = entry["columnRef"]
        time_column_ref = entry.get("timeColumnRef")
        unit = entry.get("unit")
        for column_id in index.columns_for(column_ref):
            table_id = ".".join(column_id.split(".")[:-1])
            map_entry: dict[str, Any] = {"columnId": column_id, "kind": "column"}
            if unit:
                map_entry["unit"] = unit
            if time_column_ref:
                for time_column_id in index.columns_for(time_column_ref):
                    if time_column_id.startswith(table_id + "."):
                        map_entry["timeColumnId"] = time_column_id
                        break
            elif table_id in index.time_column_by_table:
                map_entry["timeColumnId"] = index.time_column_by_table[table_id]
            resolved.append(map_entry)

    elif kind == "temporal-column":
        column_ref = entry["columnRef"]
        for column_id in index.columns_for(column_ref):
            resolved.append({"columnId": column_id, "kind": "temporal-column"})

    elif kind == "code-system":
        column_ref = entry["columnRef"]
        for column_id in index.columns_for(column_ref):
            resolved.append({"columnId": column_id, "kind": "code-system"})

    elif kind == "derived":
        from_ref = entry.get("fromColumnRef")
        to_ref = entry.get("toColumnRef")
        from_ids = index.columns_for(from_ref) if from_ref else []
        to_ids = index.columns_for(to_ref) if to_ref else []
        for from_id in from_ids:
            table_id = ".".join(from_id.split(".")[:-1])
            matching_to = [t for t in to_ids if t.startswith(table_id + ".")]
            if matching_to:
                resolved.append(
                    {
                        "kind": "derived",
                        "fromColumnId": from_id,
                        "toColumnId": matching_to[0],
                    }
                )

    elif kind == "coded-measurement":
        # A measurement identified not by its own column name but by a
        # discriminator code row (SPEC §1.9 generalization for mock's
        # MeasurementsMock.Value + MeasurementTypeRef pattern — the same
        # pattern the real staging schema likely repeats for many vitals
        # tables keyed by a *MeasurementTypes reference table).
        value_column_ref = entry["valueColumn"]
        time_column_ref = entry.get("timeColumn")
        code_column_ref = entry.get("codeColumn")
        code_ref_table_ref = entry.get("codeRefTable")
        code_ref_column_ref = entry.get("codeRefColumn")
        code_value = entry.get("codeValue")
        unit = entry.get("unit")

        for value_column_id in index.columns_for(value_column_ref):
            table_id = ".".join(value_column_id.split(".")[:-1])
            map_entry: dict[str, Any] = {
                "kind": "coded-measurement",
                "valueColumnId": value_column_id,
            }
            if unit:
                map_entry["unit"] = unit
            if code_value:
                map_entry["codeValue"] = code_value
            if time_column_ref:
                for time_column_id in index.columns_for(time_column_ref):
                    if time_column_id.startswith(table_id + "."):
                        map_entry["timeColumnId"] = time_column_id
                        break
            if code_column_ref:
                for code_column_id in index.columns_for(code_column_ref):
                    if code_column_id.startswith(table_id + "."):
                        map_entry["codeColumnId"] = code_column_id
                        break
            if code_ref_table_ref:
                ref_tables = index.tables_for(code_ref_table_ref)
                if ref_tables:
                    map_entry["codeRefTableId"] = ref_tables[0]
            if code_ref_column_ref:
                ref_columns = index.columns_for(code_ref_column_ref)
                if ref_columns:
                    map_entry["codeRefColumnId"] = ref_columns[0]
            resolved.append(map_entry)

    return resolved


def resolve_synonyms(seed_synonyms: list[dict], index: CatalogIndex) -> list[dict]:
    resolved_synonyms: list[dict] = []
    for syn in seed_synonyms:
        maps: list[dict] = []
        for entry in syn.get("maps", []):
            maps.extend(_resolve_synonym_map_entry(entry, index))
        # A synonym with zero resolved maps in THIS build's catalog is still
        # kept (aliases/abbreviation-expansion value is source-independent),
        # but with an empty maps[] rather than dropped entirely — matches SPEC
        # §1.9 shape (maps is always present, may be empty for a build that
        # doesn't introspect the relevant source).
        resolved_synonyms.append(
            {
                "term": syn["term"],
                "aliases": list(syn.get("aliases", [])),
                "maps": maps,
            }
        )
    return resolved_synonyms


def resolve_code_systems(seed_code_systems: list[dict], index: CatalogIndex) -> list[dict]:
    resolved: list[dict] = []
    for cs in seed_code_systems:
        column_ref = cs.get("columnRef")
        column_ids = index.columns_for(column_ref) if column_ref else []
        if not column_ids:
            continue
        for column_id in column_ids:
            resolved.append(
                {
                    "system": cs["system"],
                    "columnId": column_id,
                    "conceptMap": list(cs.get("conceptMap", [])),
                }
            )
    return resolved


def resolve_units(seed_units: list[dict], index: CatalogIndex) -> list[dict]:
    resolved: list[dict] = []
    for u in seed_units:
        column_ref = u.get("columnRef")
        column_ids = index.columns_for(column_ref) if column_ref else []
        for column_id in column_ids:
            resolved.append({"columnId": column_id, "unit": u["unit"]})
    return resolved


def resolve_temporal(seed_temporal: list[dict], index: CatalogIndex) -> list[dict]:
    """Resolve temporal phrases (SPEC §1.9). `relative-to-now` phrases need no
    resolution (they name no column). `relative-to-event` phrases resolve
    `eventColumnRef` against the catalog; dropped (per-source) if that event
    column doesn't exist in the current build.
    """
    resolved: list[dict] = []
    for phrase_entry in seed_temporal:
        kind = phrase_entry["kind"]
        base = {
            "phrase": phrase_entry["phrase"],
            "kind": kind,
            "intervalIso": phrase_entry.get("intervalIso"),
        }
        if "anchor" in phrase_entry:
            base["anchor"] = phrase_entry["anchor"]

        if kind == "relative-to-now":
            resolved.append(base)
        elif kind == "relative-to-event":
            event_ref = phrase_entry.get("eventColumnRef")
            event_ids = index.columns_for(event_ref) if event_ref else []
            for event_id in event_ids:
                entry = dict(base)
                entry["eventColumnId"] = event_id
                resolved.append(entry)
    return resolved


# ── abbreviation expansion (generalizes clinicalContext.ts) ────────────────


def expand_abbreviations(text: str, abbreviations: dict[str, str]) -> str:
    """Generalized port of `lib/clinicalContext.ts` `expandClinicalAbbreviations`:
    lowercase + whole-word regex replace of every abbreviation with its
    expansion, now driven by DATA (glossary.json.abbreviations) instead of a
    hardcoded TS `Record`. Behavior-identical: same lowercasing, same
    word-boundary regex semantics.
    """
    import re

    expanded = text.lower()
    for abbr, full in abbreviations.items():
        expanded = re.sub(rf"\b{re.escape(abbr)}\b", full, expanded, flags=re.IGNORECASE)
    return expanded


def extract_temporal_phrase(text: str, temporal_entries: list[dict]) -> dict | None:
    """Generalized port of `lib/clinicalContext.ts` `extractTimeRangeHint`:
    finds the first matching temporal phrase substring in `text` and returns
    its resolved glossary.json entry (kind/intervalIso/eventColumnId), rather
    than a hardcoded SQL fragment always anchored to `AcceptanceDate`. Runtime
    (lib/rag/Retriever.ts, SPEC §4) is responsible for picking the actual
    filter column: `relative-to-event` entries carry the event column
    explicitly; `relative-to-now` entries defer to the fact-specific time
    column resolved via the synonym that matched the rest of the question
    (SPEC §1.9 note).
    """
    lower = text.lower()
    for entry in temporal_entries:
        if entry["phrase"] in lower:
            return entry
    return None


# ── top-level build ──────────────────────────────────────────────────────────


def build_glossary_json(catalog: dict, seed: dict) -> dict:
    """Build the full glossary.json document (SPEC §1.9) from an already-loaded
    seed dict (see `load_glossary_seed`) and the current build's catalog.json.
    """
    index = build_catalog_index(catalog)
    return {
        "synonyms": resolve_synonyms(seed.get("synonyms", []), index),
        "abbreviations": dict(seed.get("abbreviations", {})),
        "codeSystems": resolve_code_systems(seed.get("codeSystems", []), index),
        "units": resolve_units(seed.get("units", []), index),
        "temporal": resolve_temporal(seed.get("temporal", []), index),
    }


def build_glossary_from_seed_file(catalog: dict, seed_path: str | Path) -> dict:
    """Convenience wrapper: load the seed file then build glossary.json."""
    seed = load_glossary_seed(seed_path)
    return build_glossary_json(catalog, seed)
