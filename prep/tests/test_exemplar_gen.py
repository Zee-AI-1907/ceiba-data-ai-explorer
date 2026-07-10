"""test_exemplar_gen.py — TDD for exemplar candidate generation (Task 6, the
generation half of the W3 LLM exemplar-generation enrichment stage).

Hermetic: StubLlmClient only, no network. Covers the happy path, fenced-JSON
tolerance (reusing `llm_enrich.parse_enrichment_response`'s regex approach),
fail-open on malformed JSON, and dropping entries missing `question`/`sql`.
"""

from __future__ import annotations

import asyncio
import json

from ceiba_nl2sql.generation.llm import StubLlmClient

from prep.enrich.exemplar_gen import generate_candidates
from prep.enrich.exemplar_gen_config import Category

_SCHEMA_TEXT = "tableId: src.public.Vitals\ncolumns:\n  - HeartRate (double precision)"
_JOIN_HINTS_TEXT = "src.public.Vitals.PatientId -> src.public.Patients.PatientId"
_CATEGORY = Category(id="vitals", intent="Questions about vital-sign readings over time.")
_SEEDS = ["heart rate > 120 in the last 3 hours"]


def _completion(payload: dict) -> str:
    return json.dumps(payload)


_GOOD_PAYLOAD = {
    "exemplars": [
        {"question": "q1", "sql": "SELECT 1"},
        {"question": "q2", "sql": "SELECT 2"},
    ]
}


def test_generate_candidates_parses_canned_json():
    llm = StubLlmClient([_completion(_GOOD_PAYLOAD)])

    result = asyncio.run(
        generate_candidates(_SCHEMA_TEXT, _JOIN_HINTS_TEXT, _CATEGORY, _SEEDS, 2, llm)
    )

    assert result == [
        {"question": "q1", "sql": "SELECT 1"},
        {"question": "q2", "sql": "SELECT 2"},
    ]


def test_generate_candidates_tolerates_fenced_json_block():
    fenced = "```json\n" + _completion(_GOOD_PAYLOAD) + "\n```"
    llm = StubLlmClient([fenced])

    result = asyncio.run(
        generate_candidates(_SCHEMA_TEXT, _JOIN_HINTS_TEXT, _CATEGORY, _SEEDS, 2, llm)
    )

    assert result == [
        {"question": "q1", "sql": "SELECT 1"},
        {"question": "q2", "sql": "SELECT 2"},
    ]


def test_generate_candidates_fails_open_on_malformed_json():
    llm = StubLlmClient(["this is not json at all"])

    result = asyncio.run(
        generate_candidates(_SCHEMA_TEXT, _JOIN_HINTS_TEXT, _CATEGORY, _SEEDS, 2, llm)
    )

    assert result == []


def test_generate_candidates_drops_entries_missing_sql():
    payload = {
        "exemplars": [
            {"question": "q1", "sql": "SELECT 1"},
            {"question": "q2 missing sql"},
        ]
    }
    llm = StubLlmClient([_completion(payload)])

    result = asyncio.run(
        generate_candidates(_SCHEMA_TEXT, _JOIN_HINTS_TEXT, _CATEGORY, _SEEDS, 2, llm)
    )

    assert result == [{"question": "q1", "sql": "SELECT 1"}]
