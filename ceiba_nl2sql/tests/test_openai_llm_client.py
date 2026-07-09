"""test_openai_llm_client.py — OpenAiLlmClient request-shaping (R3 structured
outputs + the model-family param branches), exercised against a FAKE AsyncOpenAI
client injected onto the instance. No network, no real key.
"""

from __future__ import annotations

from types import SimpleNamespace

import pytest

from ceiba_nl2sql.generation.llm import (
    LLM_MAX_COMPLETION_TOKENS_REASONING,
    LLM_MAX_TOKENS,
    SQL_GENERATION_RESPONSE_FORMAT,
    LlmUpstreamError,
    OpenAiLlmClient,
)


def _fake_response(text: str = '{"sql": "SELECT 1", "description": "one"}', model: str = "gpt-4o-mini-2024-07-18"):
    return SimpleNamespace(
        choices=[SimpleNamespace(message=SimpleNamespace(content=text))],
        usage=SimpleNamespace(
            prompt_tokens=10,
            completion_tokens=5,
            total_tokens=15,
            prompt_tokens_details=SimpleNamespace(cached_tokens=4),
        ),
        model=model,
    )


class _FakeCompletions:
    def __init__(self, responses: list | None = None, error: Exception | None = None, error_once: bool = False):
        self.calls: list[dict] = []
        self._responses = responses or [_fake_response()]
        self._error = error
        self._error_once = error_once

    async def create(self, **params):
        self.calls.append(params)
        if self._error is not None:
            err = self._error
            if self._error_once:
                self._error = None
            raise err
        return self._responses[min(len(self.calls) - 1, len(self._responses) - 1)]


def _client_with(fake: _FakeCompletions, **kwargs) -> OpenAiLlmClient:
    client = OpenAiLlmClient(api_key="test-key", **kwargs)
    client._client = SimpleNamespace(chat=SimpleNamespace(completions=fake))
    return client


async def test_structured_output_sent_by_default():
    fake = _FakeCompletions()
    client = _client_with(fake, model="gpt-4o-mini")
    completion = await client.complete("prompt")
    assert fake.calls[0]["response_format"] == SQL_GENERATION_RESPONSE_FORMAT
    assert fake.calls[0]["max_tokens"] == LLM_MAX_TOKENS
    assert completion.usage.cached_prompt_tokens == 4


async def test_structured_output_can_be_disabled():
    fake = _FakeCompletions()
    client = _client_with(fake, model="gpt-4o-mini", use_structured_output=False)
    await client.complete("prompt")
    assert "response_format" not in fake.calls[0]


async def test_reasoning_model_params_with_structured_output():
    fake = _FakeCompletions()
    client = _client_with(fake, model="gpt-5.4-mini")
    await client.complete("prompt")
    params = fake.calls[0]
    assert params["max_completion_tokens"] == LLM_MAX_COMPLETION_TOKENS_REASONING
    assert "temperature" not in params
    assert params["response_format"] == SQL_GENERATION_RESPONSE_FORMAT


async def test_response_format_rejection_falls_back_once_and_permanently():
    fake = _FakeCompletions(
        error=RuntimeError("Invalid parameter: 'response_format' is not supported by this model."),
        error_once=True,
    )
    client = _client_with(fake, model="gpt-4o-mini")
    completion = await client.complete("prompt")
    # First call carried response_format and failed; retry dropped it.
    assert "response_format" in fake.calls[0]
    assert "response_format" not in fake.calls[1]
    assert completion.text
    # Subsequent calls never send it again (no extra round trips).
    await client.complete("prompt 2")
    assert "response_format" not in fake.calls[2]


async def test_non_response_format_errors_still_raise_scrubbed():
    fake = _FakeCompletions(error=RuntimeError("rate limit exceeded"))
    client = _client_with(fake, model="gpt-4o-mini")
    with pytest.raises(LlmUpstreamError) as excinfo:
        await client.complete("prompt")
    assert "rate limit" not in str(excinfo.value)  # H20: raw upstream detail never surfaces


async def test_build_llm_client_threads_structured_output_flag():
    """P3 enrichment regression: build_llm_client must let a caller turn OFF the
    R3 {sql,description} response_format so a different JSON contract (the
    enrichment {tables:[...]}) is not overwritten. Default stays ON for SQL gen.
    """
    from ceiba_nl2sql.generation.llm import build_llm_client

    default_client = build_llm_client(api_key="test-key", model="gpt-4o-mini")
    off_client = build_llm_client(
        api_key="test-key", model="gpt-4o-mini", use_structured_output=False
    )
    for client, expect in ((default_client, True), (off_client, False)):
        fake = _FakeCompletions()
        client._client = SimpleNamespace(chat=SimpleNamespace(completions=fake))
        await client.complete("prompt")
        assert ("response_format" in fake.calls[0]) is expect
