"""test_egress_gate.py — ceiba_nl2sql.compliance.egress (Phase 2; ports
lib/phiScrubber.ts's `assertEgressAllowed`/`OPENAI_BAA_SIGNED` gate test
assertions; docs/PYTHON_NL2SQL_SERVICE_PLAN.md §2.5).
"""

from __future__ import annotations

import pytest

from ceiba_nl2sql.compliance.egress import assert_egress_allowed, is_egress_allowed
from ceiba_nl2sql.generation.llm import StubLlmClient, call_llm
from ceiba_nl2sql.compliance.egress import EgressBlockedError


def test_egress_closed_by_default(monkeypatch: pytest.MonkeyPatch):
    monkeypatch.delenv("OPENAI_BAA_SIGNED", raising=False)
    assert is_egress_allowed() is False
    decision = assert_egress_allowed()
    assert decision.allowed is False
    assert decision.reason == "baa_not_signed"


def test_egress_open_when_signed(monkeypatch: pytest.MonkeyPatch):
    monkeypatch.setenv("OPENAI_BAA_SIGNED", "true")
    assert is_egress_allowed() is True
    decision = assert_egress_allowed()
    assert decision.allowed is True
    assert decision.reason is None


@pytest.mark.parametrize("value", ["false", "1", "yes", "", "TRUE", " true", "true "])
def test_egress_closed_for_any_non_exact_true_value(monkeypatch: pytest.MonkeyPatch, value: str):
    """Mirrors the TS gate's exact, case-sensitive `=== 'true'` comparison —
    even "TRUE" or " true" (whitespace) must fail closed, not be leniently
    coerced, so the gate behaves identically regardless of which process
    (TS today, Python after cutover) reads the env var.
    """
    monkeypatch.setenv("OPENAI_BAA_SIGNED", value)
    assert is_egress_allowed() is False


def test_egress_open_for_exact_lowercase_true(monkeypatch: pytest.MonkeyPatch):
    monkeypatch.setenv("OPENAI_BAA_SIGNED", "true")
    assert is_egress_allowed() is True


async def test_schema_metadata_egress_class_always_allowed_even_when_gate_closed(monkeypatch: pytest.MonkeyPatch):
    monkeypatch.delenv("OPENAI_BAA_SIGNED", raising=False)
    llm = StubLlmClient(["SELECT 1"])
    result = await call_llm(llm, "some schema-only prompt", "schema-metadata")
    # call_llm now returns an LlmCompletion (text + usage + model) so the
    # pipeline can meter cost; the egress gate behavior is unchanged.
    assert result.text == "SELECT 1"
    assert result.usage.total_tokens > 0


async def test_patient_derived_egress_class_blocked_when_gate_closed(monkeypatch: pytest.MonkeyPatch):
    monkeypatch.delenv("OPENAI_BAA_SIGNED", raising=False)
    llm = StubLlmClient(["SELECT 1"])
    with pytest.raises(EgressBlockedError):
        await call_llm(llm, "some patient-derived prompt", "patient-derived")
    # The gated call never reached the LLM client.
    assert llm.prompts == []


async def test_patient_derived_egress_class_allowed_when_gate_open(monkeypatch: pytest.MonkeyPatch):
    monkeypatch.setenv("OPENAI_BAA_SIGNED", "true")
    llm = StubLlmClient(["SELECT 1"])
    result = await call_llm(llm, "some patient-derived prompt", "patient-derived")
    assert result.text == "SELECT 1"
