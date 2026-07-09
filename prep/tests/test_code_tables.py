"""test_code_tables.py — prep.enrich.code_tables (SEMANTIC_HINTS.md §1, §2, §8.1).

Hermetic: every fixture below is an in-memory dict shaped like a real
catalog.json/joingraph.json/profiles.json/phi.json (no live DB). The
row-fetcher is a fake/injected callable returning canned `(id, label)` rows —
never a real DB connection — mirroring
`ceiba_nl2sql.compliance.aggregate_profile.sample_aggregate_from_rows`'s
injectable-reducer pattern.

Asserts:
  * A table shaped like `MonitorMeasurementTypes` (rowCount<=200, (id,name)
    shape, referenced by a bigger fact table, low-card non-PHI label)
    qualifies as a code table; a tiny UNREFERENCED table does not.
  * The row-fetcher-based extraction produces `HR -> 2`-shaped codes from a
    fake row_fetcher.
  * Curated-seed synonym matching -> autoSynonyms entries with
    confidence=1.0, provenance="curated"; an alias for a canonical name with
    NO matching mined code row is dropped (no hallucination).
  * `hostingTableId` is populated on autoSynonym maps (mined path) and on
    the hand-seeded `coded-measurement` glossary.py resolution path
    (derived-from-valueColumnId).
"""

from __future__ import annotations

from prep.enrich.code_tables import (
    build_auto_synonyms,
    build_code_table_hints,
    detect_code_tables,
    extract_code_table_rows,
    resolve_auto_synonym_columns,
)
from prep.enrich.glossary import build_glossary_json


def _measurement_type_column(name: str, **overrides) -> dict:
    base = {
        "columnId": f"staging.Shared.MonitorMeasurementTypes.{name}",
        "name": name,
        "quotedName": f'"{name}"',
        "dataType": "INTEGER" if name == "Id" else "TEXT",
        "nullable": False,
        "isPrimaryKey": name == "Id",
        "isTimeColumn": False,
        "isIndexed": name == "Id",
        "unit": None,
        "ordinalPosition": 1,
    }
    base.update(overrides)
    return base


def _fact_column(name: str, table: str, **overrides) -> dict:
    base = {
        "columnId": f"{table}.{name}",
        "name": name,
        "quotedName": f'"{name}"',
        "dataType": "INTEGER",
        "nullable": False,
        "isPrimaryKey": name == "Id",
        "isTimeColumn": name == "RecordedAt",
        "isIndexed": False,
        "unit": None,
        "ordinalPosition": 1,
    }
    if name == "RecordedAt":
        base["dataType"] = "TIMESTAMP"
    if name == "Value":
        base["dataType"] = "DOUBLE PRECISION"
    base.update(overrides)
    return base


def _base_catalog() -> dict:
    return {
        "tables": [
            {
                "tableId": "staging.Shared.MonitorMeasurementTypes",
                "sourceId": "staging",
                "schema": "Shared",
                "name": "MonitorMeasurementTypes",
                "quotedRef": '"Shared"."MonitorMeasurementTypes"',
                "grain": None,
                "columns": [
                    _measurement_type_column("Id"),
                    _measurement_type_column("Name"),
                ],
            },
            {
                "tableId": "staging.Shared.MonitorMeasurements",
                "sourceId": "staging",
                "schema": "Shared",
                "name": "MonitorMeasurements",
                "quotedRef": '"Shared"."MonitorMeasurements"',
                "grain": None,
                "columns": [
                    _fact_column("Id", "staging.Shared.MonitorMeasurements"),
                    _fact_column("DeviceId", "staging.Shared.MonitorMeasurements"),
                    _fact_column("MeasurementTypeId", "staging.Shared.MonitorMeasurements"),
                    _fact_column("Value", "staging.Shared.MonitorMeasurements"),
                    _fact_column("RecordedAt", "staging.Shared.MonitorMeasurements"),
                ],
            },
            {
                "tableId": "staging.Shared.UnreferencedTiny",
                "sourceId": "staging",
                "schema": "Shared",
                "name": "UnreferencedTiny",
                "quotedRef": '"Shared"."UnreferencedTiny"',
                "grain": None,
                "columns": [
                    {
                        "columnId": "staging.Shared.UnreferencedTiny.Id",
                        "name": "Id",
                        "quotedName": '"Id"',
                        "dataType": "INTEGER",
                        "nullable": False,
                        "isPrimaryKey": True,
                        "isTimeColumn": False,
                        "isIndexed": True,
                        "unit": None,
                        "ordinalPosition": 1,
                    },
                    {
                        "columnId": "staging.Shared.UnreferencedTiny.Name",
                        "name": "Name",
                        "quotedName": '"Name"',
                        "dataType": "TEXT",
                        "nullable": False,
                        "isPrimaryKey": False,
                        "isTimeColumn": False,
                        "isIndexed": False,
                        "unit": None,
                        "ordinalPosition": 2,
                    },
                ],
            },
        ]
    }


def _base_joingraph() -> dict:
    return {
        "nodes": [
            "staging.Shared.MonitorMeasurementTypes",
            "staging.Shared.MonitorMeasurements",
            "staging.Shared.UnreferencedTiny",
        ],
        "edges": [
            {
                "from": "staging.Shared.MonitorMeasurements",
                "fromColumns": ["MeasurementTypeId"],
                "to": "staging.Shared.MonitorMeasurementTypes",
                "toColumns": ["Id"],
                "joinCardinality": "many-to-one",
                "crossSource": False,
                "origin": "declared",
                "confidence": 1.0,
            }
        ],
    }


def _base_profiles() -> dict:
    return {
        "tables": [
            {
                "tableId": "staging.Shared.MonitorMeasurementTypes",
                "approxRowCount": 12,
                "rowCountSource": "pg_class.reltuples",
                "columns": [
                    {"columnId": "staging.Shared.MonitorMeasurementTypes.Id", "distinctCount": 12, "kind": "numeric"},
                    {
                        "columnId": "staging.Shared.MonitorMeasurementTypes.Name",
                        "distinctCount": 12,
                        "kind": "categorical",
                    },
                ],
            },
            {
                "tableId": "staging.Shared.MonitorMeasurements",
                "approxRowCount": 337_000_000,
                "rowCountSource": "pg_class.reltuples",
                "columns": [],
            },
            {
                "tableId": "staging.Shared.UnreferencedTiny",
                "approxRowCount": 5,
                "rowCountSource": "pg_class.reltuples",
                "columns": [
                    {"columnId": "staging.Shared.UnreferencedTiny.Id", "distinctCount": 5, "kind": "numeric"},
                    {"columnId": "staging.Shared.UnreferencedTiny.Name", "distinctCount": 5, "kind": "categorical"},
                ],
            },
        ]
    }


def _base_phi() -> dict:
    return {
        "phiColumnsetHash": "test",
        "columns": [
            {"columnId": "staging.Shared.MonitorMeasurementTypes.Id", "phiClass": "non-phi"},
            {"columnId": "staging.Shared.MonitorMeasurementTypes.Name", "phiClass": "non-phi"},
            {"columnId": "staging.Shared.MonitorMeasurements.Id", "phiClass": "non-phi"},
            {"columnId": "staging.Shared.MonitorMeasurements.DeviceId", "phiClass": "non-phi"},
            {"columnId": "staging.Shared.MonitorMeasurements.MeasurementTypeId", "phiClass": "non-phi"},
            {"columnId": "staging.Shared.MonitorMeasurements.Value", "phiClass": "non-phi"},
            {"columnId": "staging.Shared.MonitorMeasurements.RecordedAt", "phiClass": "non-phi"},
            {"columnId": "staging.Shared.UnreferencedTiny.Id", "phiClass": "non-phi"},
            {"columnId": "staging.Shared.UnreferencedTiny.Name", "phiClass": "non-phi"},
        ],
    }


# ── detector ──────────────────────────────────────────────────────────────


def test_measurement_types_shaped_table_detected_as_code_table():
    candidates = detect_code_tables(_base_catalog(), _base_joingraph(), _base_profiles(), _base_phi())
    table_ids = {c.table_id for c in candidates}
    assert "staging.Shared.MonitorMeasurementTypes" in table_ids
    candidate = next(c for c in candidates if c.table_id == "staging.Shared.MonitorMeasurementTypes")
    assert candidate.id_column_name == "Id"
    assert candidate.label_column_name == "Name"


def test_unreferenced_tiny_table_not_detected_as_code_table():
    """Even though `UnreferencedTiny` has the (id, name) shape and is small,
    it is NOT referenced by any FK edge from a larger fact table -> not a
    code table (SEMANTIC_HINTS.md §1.2's discriminating signal).
    """
    candidates = detect_code_tables(_base_catalog(), _base_joingraph(), _base_profiles(), _base_phi())
    table_ids = {c.table_id for c in candidates}
    assert "staging.Shared.UnreferencedTiny" not in table_ids


def test_phi_label_column_excludes_table_from_detection():
    phi = _base_phi()
    for col in phi["columns"]:
        if col["columnId"] == "staging.Shared.MonitorMeasurementTypes.Name":
            col["phiClass"] = "direct-identifier"
    candidates = detect_code_tables(_base_catalog(), _base_joingraph(), _base_profiles(), phi)
    assert "staging.Shared.MonitorMeasurementTypes" not in {c.table_id for c in candidates}


def test_high_cardinality_label_excludes_table_from_detection():
    profiles = _base_profiles()
    for t in profiles["tables"]:
        if t["tableId"] == "staging.Shared.MonitorMeasurementTypes":
            for col in t["columns"]:
                if col["columnId"].endswith(".Name"):
                    col["distinctCount"] = 500
    candidates = detect_code_tables(_base_catalog(), _base_joingraph(), profiles, _base_phi())
    assert "staging.Shared.MonitorMeasurementTypes" not in {c.table_id for c in candidates}


# ── row extraction (fake row_fetcher — no real DB) ─────────────────────────


def _fake_row_fetcher(table_id: str, id_col: str, label_col: str) -> list[tuple]:
    assert table_id == "staging.Shared.MonitorMeasurementTypes"
    assert id_col == "Id"
    assert label_col == "Name"
    return [(1, "TEMP"), (2, "HR"), (12, "SPO2")]


def test_extract_code_table_rows_produces_hr_shaped_codes():
    rows = extract_code_table_rows(
        "staging.Shared.MonitorMeasurementTypes", "Id", "Name", _fake_row_fetcher
    )
    by_name = {r["name"]: r["id"] for r in rows}
    assert by_name["HR"] == 2
    assert by_name["SPO2"] == 12


def test_build_code_table_hints_end_to_end_with_fake_fetcher():
    hints = build_code_table_hints(
        _base_catalog(), _base_joingraph(), _base_profiles(), _base_phi(), row_fetcher=_fake_row_fetcher
    )
    assert len(hints) == 1
    hint = hints[0]
    assert hint.code_table_id == "staging.Shared.MonitorMeasurementTypes"
    assert hint.referenced_by == [
        {
            "factTableId": "staging.Shared.MonitorMeasurements",
            "fkColumnId": "staging.Shared.MonitorMeasurements.MeasurementTypeId",
        }
    ]
    codes_by_name = {c["name"]: c["id"] for c in hint.codes}
    assert codes_by_name["HR"] == 2


def test_build_code_table_hints_returns_empty_without_row_fetcher():
    """Backward-compatible default: no live DB row-fetcher available in this
    build context -> mines nothing, never crashes.
    """
    hints = build_code_table_hints(_base_catalog(), _base_joingraph(), _base_profiles(), _base_phi(), row_fetcher=None)
    assert hints == []


# ── curated-seed synonym matching (Layer A) ────────────────────────────────


def _hints_fixture():
    return build_code_table_hints(
        _base_catalog(), _base_joingraph(), _base_profiles(), _base_phi(), row_fetcher=_fake_row_fetcher
    )


def test_curated_seed_produces_confidence_one_curated_autosynonym():
    hints = _hints_fixture()
    alias_seed = {"HR": ["heart rate", "pulse"]}
    autosyns = build_auto_synonyms(_base_catalog(), _base_joingraph(), _base_profiles(), _base_phi(), hints, alias_seed)
    assert len(autosyns) == 1
    hr = autosyns[0]
    assert hr.term == "hr"
    assert hr.provenance == "curated"
    assert hr.confidence == 1.0
    assert hr.aliases == ["heart rate", "pulse"]
    assert hr.maps[0].code_value == 2
    assert hr.maps[0].hosting_table_id == "staging.Shared.MonitorMeasurements"


def test_seed_alias_with_no_matching_mined_code_row_is_dropped():
    """An alias entry for a canonical name with NO matching code row in ANY
    mined code table is silently dropped — never hallucinated.
    """
    hints = _hints_fixture()
    alias_seed = {"HR": ["heart rate"], "NOTAREALCODE": ["not a real vital"]}
    autosyns = build_auto_synonyms(_base_catalog(), _base_joingraph(), _base_profiles(), _base_phi(), hints, alias_seed)
    terms = {s.term for s in autosyns}
    assert "hr" in terms
    assert "notarealcode" not in terms
    assert len(autosyns) == 1


def test_resolve_auto_synonym_columns_populates_value_and_time_column():
    hints = _hints_fixture()
    alias_seed = {"HR": ["heart rate", "pulse"]}
    autosyns = build_auto_synonyms(_base_catalog(), _base_joingraph(), _base_profiles(), _base_phi(), hints, alias_seed)
    resolved = resolve_auto_synonym_columns(autosyns, _base_catalog())
    m = resolved[0].maps[0]
    assert m.value_column_id == "staging.Shared.MonitorMeasurements.Value"
    assert m.time_column_id == "staging.Shared.MonitorMeasurements.RecordedAt"
    assert m.hosting_table_id == "staging.Shared.MonitorMeasurements"


def test_autosynonym_json_shape_matches_semantic_hints_spec():
    hints = _hints_fixture()
    alias_seed = {"HR": ["heart rate", "pulse"]}
    autosyns = build_auto_synonyms(_base_catalog(), _base_joingraph(), _base_profiles(), _base_phi(), hints, alias_seed)
    resolved = resolve_auto_synonym_columns(autosyns, _base_catalog())
    doc = resolved[0].to_json()
    assert doc["term"] == "hr"
    assert doc["provenance"] == "curated"
    assert doc["confidence"] == 1.0
    m = doc["maps"][0]
    assert m["kind"] == "coded-measurement"
    assert m["codeValue"] == 2
    assert m["codeRefTableId"] == "staging.Shared.MonitorMeasurementTypes"
    assert m["hostingTableId"] == "staging.Shared.MonitorMeasurements"
    assert m["codeColumnId"] == "staging.Shared.MonitorMeasurements.MeasurementTypeId"
    assert m["valueColumnId"] == "staging.Shared.MonitorMeasurements.Value"


# ── glossary.py integration: autoSynonyms wiring + backward compat ─────────


def test_build_glossary_json_defaults_autosynonyms_to_empty_list():
    doc = build_glossary_json(_base_catalog(), seed={})
    assert doc["autoSynonyms"] == []


def test_build_glossary_json_carries_provided_autosynonyms():
    hints = _hints_fixture()
    alias_seed = {"HR": ["heart rate", "pulse"]}
    autosyns = build_auto_synonyms(_base_catalog(), _base_joingraph(), _base_profiles(), _base_phi(), hints, alias_seed)
    resolved = resolve_auto_synonym_columns(autosyns, _base_catalog())
    doc = build_glossary_json(_base_catalog(), seed={}, auto_synonyms=[s.to_json() for s in resolved])
    assert len(doc["autoSynonyms"]) == 1
    assert doc["autoSynonyms"][0]["term"] == "hr"


def test_hand_seeded_coded_measurement_gets_hosting_table_id():
    """Fix D §3.3: hostingTableId is derived from valueColumnId's table for
    the EXISTING hand-seeded coded-measurement resolution path too (backward
    compatible — no seed-file change required).
    """
    seed = {
        "synonyms": [
            {
                "term": "heart rate",
                "aliases": ["hr"],
                "maps": [
                    {
                        "kind": "coded-measurement",
                        "valueColumn": "Shared.MonitorMeasurements.Value",
                        "timeColumn": "Shared.MonitorMeasurements.RecordedAt",
                        "codeColumn": "Shared.MonitorMeasurements.MeasurementTypeId",
                        "codeRefTable": "Shared.MonitorMeasurementTypes",
                        "codeRefColumn": "Shared.MonitorMeasurementTypes.Id",
                        "codeValue": 2,
                        "unit": "bpm",
                    }
                ],
            }
        ],
        "abbreviations": {},
        "codeSystems": [],
        "units": [],
        "temporal": [],
    }
    doc = build_glossary_json(_base_catalog(), seed=seed)
    hr = next(s for s in doc["synonyms"] if s["term"] == "heart rate")
    assert hr["maps"][0]["hostingTableId"] == "staging.Shared.MonitorMeasurements"
