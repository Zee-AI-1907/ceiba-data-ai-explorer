"""test_llm_enrich.py — P3 LLM enrichment pass (hermetic: StubLlmClient)."""

from __future__ import annotations

import asyncio
import json

from ceiba_nl2sql.generation.llm import StubLlmClient

from prep.enrich.llm_enrich import (
    LlmEnrichmentReport,
    apply_enrichment,
    build_enrichment_prompt,
    enrich_catalog_with_llm,
    parse_enrichment_response,
)


def _catalog() -> dict:
    return {
        "tables": [
            {
                "tableId": "src.public.Vitals",
                "grain": None,
                "description": None,
                "columns": [
                    {
                        "columnId": "src.public.Vitals.HeartRate",
                        "name": "HeartRate",
                        "dataType": "double precision",
                        "unit": None,
                        "description": None,
                        "isPrimaryKey": False,
                        "isTimeColumn": False,
                    },
                    {
                        "columnId": "src.public.Vitals.RecordedAt",
                        "name": "RecordedAt",
                        "dataType": "timestamptz",
                        "unit": None,
                        "description": "Existing comment from pg_description",
                        "isPrimaryKey": False,
                        "isTimeColumn": True,
                    },
                ],
            }
        ]
    }


def _completion(payload: dict) -> str:
    return json.dumps(payload)


_GOOD_PAYLOAD = {
    "tables": [
        {
            "tableId": "src.public.Vitals",
            "description": "Vital-sign readings captured from bedside devices.",
            "grain": "one row per vital-sign reading",
            "columns": [
                {"name": "HeartRate", "description": "Beats per minute reading", "unit": "bpm"},
                {"name": "RecordedAt", "description": "SHOULD NOT OVERWRITE", "unit": None},
                {"name": "NoSuchColumn", "description": "unknown ids are dropped", "unit": "x"},
            ],
        },
        {"tableId": "src.public.NoSuchTable", "description": "dropped", "grain": "dropped", "columns": []},
    ]
}


def test_prompt_carries_schema_metadata_only():
    prompt = build_enrichment_prompt(_catalog()["tables"])
    assert "src.public.Vitals" in prompt
    assert "HeartRate" in prompt
    assert "NEVER guess a unit" in prompt


def test_enrichment_fills_empty_slots_only():
    catalog = _catalog()
    llm = StubLlmClient([_completion(_GOOD_PAYLOAD)])
    report = asyncio.run(enrich_catalog_with_llm(catalog, llm))

    table = catalog["tables"][0]
    assert table["description"] == "Vital-sign readings captured from bedside devices."
    assert table["grain"] == "one row per vital-sign reading"
    hr = table["columns"][0]
    assert hr["description"] == "Beats per minute reading"
    assert hr["unit"] == "bpm"
    # The pg_description comment is NEVER overwritten.
    recorded = table["columns"][1]
    assert recorded["description"] == "Existing comment from pg_description"

    assert report.tables_enriched == 1
    assert report.units_filled == 1
    assert report.llm_calls == 1
    assert report.prompt_tokens > 0


def test_unknown_ids_and_garbage_are_dropped():
    catalog = _catalog()
    llm = StubLlmClient([_completion(_GOOD_PAYLOAD)])
    asyncio.run(enrich_catalog_with_llm(catalog, llm))
    names = {c["name"] for c in catalog["tables"][0]["columns"]}
    assert "NoSuchColumn" not in names
    assert len(catalog["tables"]) == 1  # NoSuchTable not added


def test_unparseable_response_is_fail_open():
    catalog = _catalog()
    llm = StubLlmClient(["this is not json at all"])
    report = asyncio.run(enrich_catalog_with_llm(catalog, llm))
    assert report.tables_enriched == 0
    assert catalog["tables"][0]["description"] is None


def test_fenced_json_response_parses():
    parsed = parse_enrichment_response("```json\n" + _completion(_GOOD_PAYLOAD) + "\n```")
    assert "src.public.Vitals" in parsed


def test_length_caps_applied():
    catalog = _catalog()
    payload = {
        "tables": [
            {
                "tableId": "src.public.Vitals",
                "description": "x" * 1000,
                "grain": None,
                "columns": [{"name": "HeartRate", "description": None, "unit": "y" * 100}],
            }
        ]
    }
    report = LlmEnrichmentReport()
    apply_enrichment(catalog, parse_enrichment_response(_completion(payload)), report)
    assert len(catalog["tables"][0]["description"]) == 300
    assert len(catalog["tables"][0]["columns"][0]["unit"]) == 16
