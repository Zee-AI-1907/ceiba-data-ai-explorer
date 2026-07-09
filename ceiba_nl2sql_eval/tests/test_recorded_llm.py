"""test_recorded_llm.py — ceiba_nl2sql_eval.recorded_llm.RecordedLlmClient
(docs/PYTHON_NL2SQL_SERVICE_PLAN.md §4.1, §5 Phase 5).
"""

from __future__ import annotations

import pytest

from ceiba_nl2sql.generation.prompt import USER_REQUEST_CLOSE, USER_REQUEST_OPEN
from ceiba_nl2sql_eval.recorded_llm import RECORDED_DRIVING_MODEL_ID, RecordedLlmClient, extract_question_from_prompt


def test_extract_question_from_prompt_recovers_delimited_text():
    prompt = f"preamble\n\n{USER_REQUEST_OPEN}\nheart rate > 120 in the last 3 hours\n{USER_REQUEST_CLOSE}\n\nmore"
    assert extract_question_from_prompt(prompt) == "heart rate > 120 in the last 3 hours"


def test_extract_question_from_prompt_returns_none_when_delimiters_absent():
    assert extract_question_from_prompt("no delimiters here") is None


async def test_complete_returns_recorded_sql_for_known_question():
    client = RecordedLlmClient()
    prompt = f"{USER_REQUEST_OPEN}\npatients admitted yesterday\n{USER_REQUEST_CLOSE}"
    completion = await client.complete(prompt)
    assert "VisitMock" in completion.text
    assert completion.usage.prompt_tokens > 0
    assert completion.usage.completion_tokens > 0


async def test_complete_raises_loudly_on_unrecorded_question():
    client = RecordedLlmClient()
    prompt = f"{USER_REQUEST_OPEN}\nsome never-recorded question\n{USER_REQUEST_CLOSE}"
    with pytest.raises(RuntimeError, match="no recorded completion"):
        await client.complete(prompt)


async def test_driving_model_id_decoupled_from_pricing_model():
    client = RecordedLlmClient()
    assert client.driving_model_id == RECORDED_DRIVING_MODEL_ID
    assert client.model == "gpt-4o-mini"

    prompt = f"{USER_REQUEST_OPEN}\npatients admitted yesterday\n{USER_REQUEST_CLOSE}"
    completion = await client.complete(prompt)
    assert completion.model == "gpt-4o-mini"
