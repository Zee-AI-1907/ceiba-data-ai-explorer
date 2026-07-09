"""test_egress_gate.py — service-level egress gate assertions
(docs/PYTHON_NL2SQL_SERVICE_PLAN.md §2.5: "the egress gate blocks when
OPENAI_BAA_SIGNED != true and a patient-derived path is attempted (schema-
only path still works)").

`/nl2sql/generate`'s pipeline only ever uses the `schema-metadata` egress
class (the prompt is BAA-safe by construction — schema/glossary/exemplars
only, never a raw patient row), so the schema-only path succeeds
UNCONDITIONALLY regardless of `OPENAI_BAA_SIGNED` — this is the actual
service-observable behavior asserted here. The `patient-derived` class exists
so a FUTURE row-derived prompt cannot silently bypass the gate; that half of
the contract is proven directly against the shared library's choke point
(`ceiba_nl2sql.generation.llm.call_llm`), the same choke point
`generate_sql` and any future patient-derived code path would go through.
"""

from __future__ import annotations

import pytest

from ceiba_nl2sql.compliance.egress import EgressBlockedError
from ceiba_nl2sql.generation.llm import StubLlmClient, call_llm

GOOD_HEART_RATE_SQL = """SELECT m."patientRef", m."Value", m."RecordedAt"
FROM mock.public."MeasurementsMock" m
WHERE m."Value" > 120 AND m."RecordedAt" >= now() - INTERVAL '3 hours'
ORDER BY m."RecordedAt"
LIMIT 1000"""


async def test_generate_schema_only_path_succeeds_regardless_of_baa_flag(
    monkeypatch: pytest.MonkeyPatch, client, app_state, auth_headers
):
    """The service's only current LLM-calling endpoint, /nl2sql/generate,
    sends schema-metadata-only prompts — so it must succeed even with
    OPENAI_BAA_SIGNED unset/false, proving the "degraded, schema-only mode"
    guarantee holds at the service boundary, not just in the shared library.
    """
    monkeypatch.delenv("OPENAI_BAA_SIGNED", raising=False)
    app_state._llm = StubLlmClient([GOOD_HEART_RATE_SQL])
    response = await client.post(
        "/nl2sql/generate",
        json={"question": "heart rate over 120 in the last 3 hours", "tenantId": "org_1"},
        headers=auth_headers,
    )
    assert response.status_code == 200
    assert "MeasurementsMock" in response.json()["sql"]


async def test_patient_derived_egress_class_blocked_at_the_choke_point_when_gate_closed(monkeypatch: pytest.MonkeyPatch):
    """Directly exercises `call_llm` — the SAME choke point
    `generate_sql`'s [C] LLM step goes through — with the `patient-derived`
    class a future row-derived prompt would have to use. Proves the gate
    still exists and still defaults closed even though nothing in this
    phase's endpoints currently exercises it.
    """
    monkeypatch.delenv("OPENAI_BAA_SIGNED", raising=False)
    llm = StubLlmClient(["should never be reached"])
    with pytest.raises(EgressBlockedError):
        await call_llm(llm, "some patient-row-derived prompt", "patient-derived")
    assert llm.prompts == []


async def test_patient_derived_egress_class_allowed_at_the_choke_point_when_gate_open(monkeypatch: pytest.MonkeyPatch):
    monkeypatch.setenv("OPENAI_BAA_SIGNED", "true")
    llm = StubLlmClient(["ok"])
    result = await call_llm(llm, "some patient-row-derived prompt", "patient-derived")
    assert result == "ok"
