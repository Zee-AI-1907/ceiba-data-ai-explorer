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
    LlmTurn,
    LlmUpstreamError,
    OpenAiLlmClient,
    StubLlmClient,
    ToolCall,
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


# ── P1 T2: tool-enabled surface (complete_messages / ToolCall / LlmTurn) ──────


def _tc(call_id: str, name: str, arguments: str):
    return SimpleNamespace(id=call_id, type="function", function=SimpleNamespace(name=name, arguments=arguments))


def _turn_response(*, content=None, tool_calls=None, finish_reason="stop", model="gpt-5.4-mini"):
    return SimpleNamespace(
        choices=[SimpleNamespace(message=SimpleNamespace(content=content, tool_calls=tool_calls), finish_reason=finish_reason)],
        usage=SimpleNamespace(
            prompt_tokens=10, completion_tokens=5, total_tokens=15,
            prompt_tokens_details=SimpleNamespace(cached_tokens=2),
        ),
        model=model,
    )


async def test_complete_messages_tool_call_turn_null_content_ok():
    # A tool-call turn has content=None + populated tool_calls; must NOT raise.
    fake = _FakeCompletions(responses=[
        _turn_response(tool_calls=[_tc("c1", "get_join_subgraph", '{"tables": ["Patients"]}')], finish_reason="tool_calls")
    ])
    client = _client_with(fake, model="gpt-5.4-mini")
    turn = await client.complete_messages([{"role": "user", "content": "q"}], tools=[{"type": "function"}])
    assert isinstance(turn, LlmTurn)
    assert turn.text is None
    assert turn.tool_calls == [ToolCall(id="c1", name="get_join_subgraph", arguments='{"tables": ["Patients"]}')]
    assert turn.finish_reason == "tool_calls"
    assert turn.usage.prompt_tokens == 10 and turn.usage.cached_prompt_tokens == 2


async def test_complete_messages_final_content_turn():
    fake = _FakeCompletions(responses=[_turn_response(content='{"sql": "SELECT 1"}', finish_reason="stop")])
    client = _client_with(fake, model="gpt-5.4-mini")
    turn = await client.complete_messages([{"role": "user", "content": "q"}])
    assert turn.text == '{"sql": "SELECT 1"}'
    assert turn.tool_calls == []


async def test_complete_messages_empty_raises_only_when_no_tools_and_no_content():
    fake = _FakeCompletions(responses=[_turn_response(content=None, tool_calls=None)])
    client = _client_with(fake, model="gpt-5.4-mini")
    with pytest.raises(LlmUpstreamError):
        await client.complete_messages([{"role": "user", "content": "q"}])


async def test_build_tool_params_reasoning_model_omits_temperature_and_response_format():
    client = _client_with(_FakeCompletions(), model="gpt-5.4-mini")
    params = client._build_tool_params(
        [{"role": "user", "content": "q"}], tools=[{"type": "function"}], tool_choice="auto", response_format=None
    )
    assert params["max_completion_tokens"] == LLM_MAX_COMPLETION_TOKENS_REASONING
    assert "temperature" not in params
    assert params["tools"] == [{"type": "function"}]
    assert params["tool_choice"] == "auto"
    assert "response_format" not in params  # omitted on a planning turn


async def test_build_tool_params_non_reasoning_model_uses_max_tokens_and_attaches_response_format():
    client = _client_with(_FakeCompletions(), model="gpt-4o-mini")
    params = client._build_tool_params(
        [{"role": "user", "content": "q"}], tools=None, tool_choice="auto", response_format=SQL_GENERATION_RESPONSE_FORMAT
    )
    assert params["max_tokens"] == LLM_MAX_TOKENS
    assert "temperature" in params
    assert "tools" not in params  # omitted when None
    assert params["response_format"] == SQL_GENERATION_RESPONSE_FORMAT


async def test_build_tool_params_reasoning_model_sets_effort_none_with_tools():
    # gpt-5.x rejects function tools with a non-none reasoning_effort on
    # chat.completions; the plan/tool turn is a routing decision -> effort none.
    client = _client_with(_FakeCompletions(), model="gpt-5.6-luna")
    params = client._build_tool_params(
        [{"role": "user", "content": "q"}], tools=[{"type": "function"}], tool_choice="auto", response_format=None
    )
    assert params.get("reasoning_effort") == "none"


async def test_build_tool_params_reasoning_model_no_effort_override_without_tools():
    # A generation turn (no tools) must keep full reasoning — no effort override.
    client = _client_with(_FakeCompletions(), model="gpt-5.6-luna")
    params = client._build_tool_params(
        [{"role": "user", "content": "q"}], tools=None, tool_choice="auto", response_format=SQL_GENERATION_RESPONSE_FORMAT
    )
    assert "reasoning_effort" not in params


async def test_build_tool_params_non_reasoning_model_no_reasoning_effort():
    client = _client_with(_FakeCompletions(), model="gpt-4o-mini")
    params = client._build_tool_params(
        [{"role": "user", "content": "q"}], tools=[{"type": "function"}], tool_choice="auto", response_format=None
    )
    assert "reasoning_effort" not in params


async def test_complete_single_shot_path_unaffected_by_tool_additions():
    # The existing complete() path must still work unchanged.
    fake = _FakeCompletions()
    client = _client_with(fake, model="gpt-4o-mini")
    completion = await client.complete("prompt")
    assert completion.text
    assert fake.calls[0]["response_format"] == SQL_GENERATION_RESPONSE_FORMAT


async def test_stub_scripts_tool_call_turn():
    scripted = LlmTurn(
        text=None,
        tool_calls=[ToolCall(id="c1", name="get_join_subgraph", arguments='{"tables": []}')],
        finish_reason="tool_calls",
        usage=None,
        model="stub",
    )
    stub = StubLlmClient([], turns=[scripted])
    turn = await stub.complete_messages([{"role": "user", "content": "q"}])
    assert turn.tool_calls[0].name == "get_join_subgraph"


# ── P1 T3: call_llm_with_tools egress choke point ─────────────────────────────


def _usage(p):
    from ceiba_nl2sql.generation.llm import TokenUsage
    return TokenUsage(prompt_tokens=p, completion_tokens=1, total_tokens=p + 1)


def _tool_turn(call_id, name, arguments, *, usage=None):
    return LlmTurn(
        text=None, tool_calls=[ToolCall(id=call_id, name=name, arguments=arguments)],
        finish_reason="tool_calls", usage=usage, model="stub",
    )


def _final_turn(text, *, usage=None):
    return LlmTurn(text=text, tool_calls=[], finish_reason="stop", usage=usage, model="stub")


async def test_call_llm_with_tools_dispatches_handler_and_loops():
    from ceiba_nl2sql.generation.llm import call_llm_with_tools

    stub = StubLlmClient([], turns=[
        _tool_turn("c1", "get_join_subgraph", '{"tables": ["Patients"]}'),
        _final_turn('{"sql": "SELECT 1"}'),
    ])
    dispatched = []

    def handler(args):
        dispatched.append(args)
        return "RENDERED SUBGRAPH"

    completion = await call_llm_with_tools(
        stub, [{"role": "user", "content": "q"}], tools=[{"type": "function"}],
        handlers={"get_join_subgraph": handler}, egress_class="schema-metadata",
    )
    assert completion.text == '{"sql": "SELECT 1"}'
    assert dispatched == [{"tables": ["Patients"]}]
    # the tool result was appended as a role=tool message before the final turn
    tool_messages = [m for batch in stub.message_batches for m in batch if m.get("role") == "tool"]
    assert any(m["content"] == "RENDERED SUBGRAPH" and m["tool_call_id"] == "c1" for m in tool_messages)


async def test_call_llm_with_tools_asserts_egress_every_round(monkeypatch):
    from ceiba_nl2sql.generation.llm import call_llm_with_tools, EgressBlockedError

    gate_calls = {"n": 0}

    def fake_gate():
        gate_calls["n"] += 1
        return SimpleNamespace(allowed=(gate_calls["n"] == 1), message="egress blocked")

    monkeypatch.setattr("ceiba_nl2sql.generation.llm.assert_egress_allowed", fake_gate)

    stub = StubLlmClient([], turns=[_tool_turn("c1", "get_join_subgraph", "{}")])
    with pytest.raises(EgressBlockedError):
        await call_llm_with_tools(
            stub, [{"role": "user", "content": "q"}], tools=[{"type": "function"}],
            handlers={"get_join_subgraph": lambda a: "x"}, egress_class="patient-derived",
        )
    # gated on round 1 (allowed) AND round 2 (blocked) — not just the first
    assert gate_calls["n"] == 2


async def test_call_llm_with_tools_sums_usage_across_rounds():
    from ceiba_nl2sql.generation.llm import call_llm_with_tools

    stub = StubLlmClient([], turns=[
        _tool_turn("c1", "get_join_subgraph", "{}", usage=_usage(10)),
        _final_turn("done", usage=_usage(20)),
    ])
    completion = await call_llm_with_tools(
        stub, [{"role": "user", "content": "q"}], tools=[{"type": "function"}],
        handlers={"get_join_subgraph": lambda a: "x"}, egress_class="schema-metadata",
    )
    assert completion.usage.prompt_tokens == 30  # 10 + 20 across both rounds


# ── P1 T4: loop bounding ──────────────────────────────────────────────────────


async def test_tool_loop_stops_at_max_rounds():
    from ceiba_nl2sql.generation.llm import call_llm_with_tools

    # Model keeps calling tools forever; the loop must terminate at max_rounds.
    stub = StubLlmClient([], turns=[_tool_turn(f"c{i}", "get_join_subgraph", '{"tables": ["T%d"]}' % i) for i in range(10)])
    completion = await call_llm_with_tools(
        stub, [{"role": "user", "content": "q"}], tools=[{"type": "function"}],
        handlers={"get_join_subgraph": lambda a: "x"}, egress_class="schema-metadata", max_rounds=2,
    )
    assert completion is not None
    assert len(stub.message_batches) == 2  # exactly max_rounds outbound turns


async def test_tool_loop_duplicate_call_short_circuits():
    from ceiba_nl2sql.generation.llm import call_llm_with_tools

    stub = StubLlmClient([], turns=[
        _tool_turn("c1", "get_join_subgraph", '{"tables": ["Patients"]}'),
        _tool_turn("c2", "get_join_subgraph", '{"tables": ["Patients"]}'),  # identical args
        _final_turn("done"),
    ])
    invocations = []

    def handler(args):
        invocations.append(args)
        return "SUBGRAPH"

    await call_llm_with_tools(
        stub, [{"role": "user", "content": "q"}], tools=[{"type": "function"}],
        handlers={"get_join_subgraph": handler}, egress_class="schema-metadata",
    )
    assert len(invocations) == 1  # second identical call served from cache


async def test_tool_loop_length_finish_reason_fails_loud():
    from ceiba_nl2sql.generation.llm import call_llm_with_tools, LlmUpstreamError

    truncated = LlmTurn(text="partial", tool_calls=[], finish_reason="length", usage=None, model="stub")
    stub = StubLlmClient([], turns=[truncated])
    with pytest.raises(LlmUpstreamError):
        await call_llm_with_tools(
            stub, [{"role": "user", "content": "q"}], tools=[{"type": "function"}],
            handlers={"get_join_subgraph": lambda a: "x"}, egress_class="schema-metadata",
        )
