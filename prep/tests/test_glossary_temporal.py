"""test_glossary_temporal.py — glossary.py temporal + synonym resolution (SPEC §1.9). P3b.

Asserts:
  * "last 3 hours" -> intervalIso PT3H, kind relative-to-now (generalizes
    lib/clinicalContext.ts TIME_RANGE_HINTS into data-driven resolution).
  * "heart rate" resolves to a value column + its time column + unit, via
    both the plain-column pattern (staging-shaped) and the coded-measurement
    pattern (mock-shaped MeasurementsMock.Value discriminated by
    MeasurementTypeRef).
  * A seed reference to a table/column NOT present in the current build's
    catalog resolves to an EMPTY maps[] rather than a fabricated node (the
    same discipline as joingraph.py's curated cross-source correlations) —
    exercised via a mock-only catalog where the staging-shaped seed entry
    for "heart rate" has no partner.
  * `expand_abbreviations` / `extract_temporal_phrase` behave like the
    legacy `clinicalContext.ts` functions they generalize, but driven by
    glossary data instead of a hardcoded TS Record.
  * A `relative-to-event` phrase ("within 24h of admission") resolves its
    `eventColumnId` against the catalog and is DROPPED (not fabricated) when
    that event column's table isn't in the current build.
"""

from __future__ import annotations

from pathlib import Path

import pytest

from prep.enrich.glossary import (
    build_catalog_index,
    build_glossary_json,
    expand_abbreviations,
    extract_temporal_phrase,
    load_glossary_seed,
    resolve_temporal,
)

REPO_ROOT = Path(__file__).resolve().parents[2]
SEED_PATH = REPO_ROOT / "config" / "glossary.seed.yaml"


def _mock_catalog() -> dict:
    """A catalog shaped like the real `--only mock` build's catalog.json
    (SPEC §1.3): MeasurementsMock (Value/RecordedAt/MeasurementTypeId),
    MeasurementTypeRef, VisitMock (admittedAt/dischargedAt). No staging.* —
    exercises the "seed entry has no partner in this catalog" path.
    """
    return {
        "tables": [
            {
                "tableId": "mock.public.MeasurementsMock",
                "columns": [
                    {"columnId": "mock.public.MeasurementsMock.Id", "name": "Id", "isTimeColumn": False, "unit": None},
                    {
                        "columnId": "mock.public.MeasurementsMock.MeasurementTypeId",
                        "name": "MeasurementTypeId",
                        "isTimeColumn": False,
                        "unit": None,
                    },
                    {"columnId": "mock.public.MeasurementsMock.Value", "name": "Value", "isTimeColumn": False, "unit": None},
                    {
                        "columnId": "mock.public.MeasurementsMock.RecordedAt",
                        "name": "RecordedAt",
                        "isTimeColumn": True,
                        "unit": None,
                    },
                ],
            },
            {
                "tableId": "mock.public.MeasurementTypeRef",
                "columns": [
                    {
                        "columnId": "mock.public.MeasurementTypeRef.MeasurementTypeId",
                        "name": "MeasurementTypeId",
                        "isTimeColumn": False,
                        "unit": None,
                    },
                    {"columnId": "mock.public.MeasurementTypeRef.unit", "name": "unit", "isTimeColumn": False, "unit": None},
                ],
            },
            {
                "tableId": "mock.public.VisitMock",
                "columns": [
                    {"columnId": "mock.public.VisitMock.visitRef", "name": "visitRef", "isTimeColumn": False, "unit": None},
                    {
                        "columnId": "mock.public.VisitMock.admittedAt",
                        "name": "admittedAt",
                        "isTimeColumn": True,
                        "unit": None,
                    },
                    {
                        "columnId": "mock.public.VisitMock.dischargedAt",
                        "name": "dischargedAt",
                        "isTimeColumn": True,
                        "unit": None,
                    },
                ],
            },
        ]
    }


def _staging_plus_mock_catalog() -> dict:
    catalog = _mock_catalog()
    catalog["tables"].append(
        {
            "tableId": "staging.Shared.MonitorMeasurements",
            "columns": [
                {
                    "columnId": "staging.Shared.MonitorMeasurements.HeartRate",
                    "name": "HeartRate",
                    "isTimeColumn": False,
                    "unit": "bpm",
                },
                {
                    "columnId": "staging.Shared.MonitorMeasurements.RecordedAt",
                    "name": "RecordedAt",
                    "isTimeColumn": True,
                    "unit": None,
                },
            ],
        }
    )
    catalog["tables"].append(
        {
            "tableId": "staging.Shared.Acceptances",
            "columns": [
                {
                    "columnId": "staging.Shared.Acceptances.AcceptanceDate",
                    "name": "AcceptanceDate",
                    "isTimeColumn": True,
                    "unit": None,
                }
            ],
        }
    )
    return catalog


@pytest.fixture(scope="module")
def seed() -> dict:
    return load_glossary_seed(SEED_PATH)


# ── temporal: "last 3 hours" -> PT3H ────────────────────────────────────────


def test_last_3_hours_resolves_to_pt3h(seed):
    index = build_catalog_index(_mock_catalog())
    resolved = resolve_temporal(seed["temporal"], index)
    entry = next(t for t in resolved if t["phrase"] == "last 3 hours")
    assert entry["intervalIso"] == "PT3H"
    assert entry["kind"] == "relative-to-now"


def test_yesterday_resolves_to_p1d_relative_to_now(seed):
    index = build_catalog_index(_mock_catalog())
    resolved = resolve_temporal(seed["temporal"], index)
    entry = next(t for t in resolved if t["phrase"] == "yesterday")
    assert entry["intervalIso"] == "P1D"
    assert entry["kind"] == "relative-to-now"


def test_extract_temporal_phrase_finds_last_3_hours_in_question(seed):
    index = build_catalog_index(_mock_catalog())
    resolved = resolve_temporal(seed["temporal"], index)
    hit = extract_temporal_phrase("heart rate > 120 in the last 3 hours", resolved)
    assert hit is not None
    assert hit["intervalIso"] == "PT3H"


def test_relative_to_event_resolves_event_column_when_present(seed):
    """within 24h of admission" -> eventColumnId resolves to
    staging.Shared.Acceptances.AcceptanceDate ONLY when staging is in the
    catalog.
    """
    index = build_catalog_index(_staging_plus_mock_catalog())
    resolved = resolve_temporal(seed["temporal"], index)
    hits = [t for t in resolved if t["phrase"] == "within 24h of admission"]
    assert len(hits) >= 1
    assert hits[0]["kind"] == "relative-to-event"
    assert hits[0]["eventColumnId"] == "staging.Shared.Acceptances.AcceptanceDate"
    assert hits[0]["intervalIso"] == "PT24H"


def test_relative_to_event_dropped_when_event_column_not_in_catalog(seed):
    """A `--only mock` build's catalog never contains
    staging.Shared.Acceptances -> the "within 24h of admission" phrase
    referencing it must be DROPPED, not fabricated with a phantom columnId.
    """
    index = build_catalog_index(_mock_catalog())
    resolved = resolve_temporal(seed["temporal"], index)
    hits = [t for t in resolved if t["phrase"] == "within 24h of admission"]
    assert hits == []


# ── synonyms: "heart rate" -> value column + time column + unit ────────────


def test_heart_rate_resolves_coded_measurement_on_mock_catalog(seed):
    """On a mock-only catalog, "heart rate" must resolve via the
    coded-measurement pattern to MeasurementsMock.Value + its RecordedAt time
    column + unit bpm — NOT to a fabricated dedicated HeartRate column (mock
    has no such column; it's the discriminator pattern).
    """
    glossary = build_glossary_json(_mock_catalog(), seed)
    heart_rate = next(s for s in glossary["synonyms"] if s["term"] == "heart rate")
    assert len(heart_rate["maps"]) == 1
    entry = heart_rate["maps"][0]
    assert entry["kind"] == "coded-measurement"
    assert entry["valueColumnId"] == "mock.public.MeasurementsMock.Value"
    assert entry["timeColumnId"] == "mock.public.MeasurementsMock.RecordedAt"
    assert entry["unit"] == "bpm"
    assert entry["codeValue"] == "Heart Rate"


def test_heart_rate_resolves_plain_column_on_staging_shaped_catalog(seed):
    """On a catalog that DOES have staging's dedicated HeartRate column,
    "heart rate" must ALSO resolve the plain-column pattern with its own
    timeColumnId + unit — both mappings coexist (SPEC §1.9 lets a synonym map
    to multiple targets).
    """
    glossary = build_glossary_json(_staging_plus_mock_catalog(), seed)
    heart_rate = next(s for s in glossary["synonyms"] if s["term"] == "heart rate")
    kinds = {m["kind"] for m in heart_rate["maps"]}
    assert "coded-measurement" in kinds
    assert "column" in kinds

    column_map = next(m for m in heart_rate["maps"] if m["kind"] == "column")
    assert column_map["columnId"] == "staging.Shared.MonitorMeasurements.HeartRate"
    assert column_map["timeColumnId"] == "staging.Shared.MonitorMeasurements.RecordedAt"
    assert column_map["unit"] == "bpm"


def test_vitals_table_synonym_empty_maps_when_table_absent(seed):
    """"vitals" maps to Shared.VitalSigns, which exists in neither test
    catalog above -> the synonym is KEPT (aliases still useful) but with an
    EMPTY maps[], never a fabricated tableId.
    """
    glossary = build_glossary_json(_mock_catalog(), seed)
    vitals = next(s for s in glossary["synonyms"] if s["term"] == "vitals")
    assert vitals["maps"] == []
    assert "obs" in vitals["aliases"]


def test_admitted_resolves_to_visitmock_temporal_column_on_mock_catalog(seed):
    glossary = build_glossary_json(_mock_catalog(), seed)
    admitted = next(s for s in glossary["synonyms"] if s["term"] == "admitted")
    assert any(
        m["kind"] == "temporal-column" and m["columnId"] == "mock.public.VisitMock.admittedAt"
        for m in admitted["maps"]
    )


# ── abbreviation expansion (generalizes clinicalContext.ts) ────────────────


def test_expand_abbreviations_matches_legacy_ts_semantics(seed):
    abbreviations = seed["abbreviations"]
    expanded = expand_abbreviations("HR > 120 for ICU pts", abbreviations)
    assert "heart rate" in expanded
    assert "intensive care unit" in expanded
    assert "patients" in expanded


def test_expand_abbreviations_is_whole_word_only(seed):
    abbreviations = seed["abbreviations"]
    # "hr" as a standalone word DOES expand...
    assert expand_abbreviations("hr 130", abbreviations) == "heart rate 130"
    # ...but "hr" embedded inside a larger word (no word boundary) must NOT
    # expand — "heartratehr" has no standalone "hr" token, so it must pass
    # through completely unchanged (mirrors clinicalContext.ts's `\b`-bounded
    # regex semantics).
    assert expand_abbreviations("heartratehr monitor", abbreviations) == "heartratehr monitor"


# ── build_catalog_index low-level behavior ──────────────────────────────────


def test_catalog_index_prefers_recordedat_when_multiple_time_columns():
    catalog = {
        "tables": [
            {
                "tableId": "mock.public.VisitMock",
                "columns": [
                    {"columnId": "mock.public.VisitMock.admittedAt", "name": "admittedAt", "isTimeColumn": True, "unit": None},
                    {"columnId": "mock.public.VisitMock.dischargedAt", "name": "dischargedAt", "isTimeColumn": True, "unit": None},
                ],
            }
        ]
    }
    index = build_catalog_index(catalog)
    # admittedAt matches the preferred-name hint list; dischargedAt does not.
    assert index.time_column_by_table["mock.public.VisitMock"] == "mock.public.VisitMock.admittedAt"
