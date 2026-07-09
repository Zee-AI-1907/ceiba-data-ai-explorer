"""test_contract.py — TS-client ⇄ service Pydantic-model contract
(docs/PYTHON_NL2SQL_SERVICE_PLAN.md §2.2, §2.4, §4).

Asserts the service's Pydantic response models serialize to EXACTLY the wire
shape lib/nl2sqlServiceClient.ts parses — the field names its `isGenerateResult`
/ `isExecuteResult` type guards and its `Nl2sqlGenerateResult` / `Nl2sqlUsage` /
`Nl2sqlExecuteResult` / error-envelope interfaces read. Hermetic: it exercises
the models + the error envelope directly (no network, no OpenAI), which is the
"at minimum" contract test the plan's §4 service-contract check calls for when
booting a real service in CI is too heavy.

The TS shapes are transcribed here as the expected key sets; if either side's
field names drift, THIS test fails, which is the whole point.
"""

from __future__ import annotations

from ceiba_nl2sql_service.errors import envelope_response
from ceiba_nl2sql_service.models import (
    ColumnModel,
    ExecuteResponse,
    GenerateResponse,
    RepairInfoModel,
    RetrievalSummaryModel,
    UsageModel,
)

# ── The exact camelCase keys lib/nl2sqlServiceClient.ts reads ────────────────
# (Nl2sqlGenerateResult, Nl2sqlUsage, Nl2sqlExecuteResult, ServiceErrorEnvelope)

_GENERATE_KEYS = {"sql", "description", "dialect", "retrieval", "repair", "cached", "error", "usage"}
_RETRIEVAL_KEYS = {"tables", "exemplarsUsed", "cardinalityWarnings"}
_REPAIR_KEYS = {"rounds", "lastError"}
_USAGE_KEYS = {
    "model",
    "promptTokens",
    "completionTokens",
    "totalTokens",
    "llmCalls",
    "estimatedCostUsd",
    "latencyMs",
    "priced",
}
_EXECUTE_KEYS = {"columns", "rows", "rowCount", "truncated"}
_COLUMN_KEYS = {"name", "type"}
_ENVELOPE_ERROR_KEYS = {"kind", "message"}  # `detail` is optional


def test_generate_response_serializes_to_ts_generate_result_shape():
    model = GenerateResponse(
        sql="SELECT 1",
        description="a query",
        dialect="duckdb",
        retrieval=RetrievalSummaryModel(tables=["t"], exemplarsUsed=["e"], cardinalityWarnings=[]),
        repair=RepairInfoModel(rounds=1, lastError=None),
        cached=False,
        usage=UsageModel(
            model="gpt-4o-mini",
            promptTokens=10,
            completionTokens=5,
            totalTokens=15,
            llmCalls=1,
            estimatedCostUsd=0.0001,
            latencyMs=42,
            priced=True,
        ),
    )
    body = model.model_dump()
    assert set(body.keys()) == _GENERATE_KEYS
    assert set(body["retrieval"].keys()) == _RETRIEVAL_KEYS
    assert set(body["repair"].keys()) == _REPAIR_KEYS
    assert set(body["usage"].keys()) == _USAGE_KEYS
    # The TS `isGenerateResult` guard keys on these types.
    assert isinstance(body["sql"], str)
    assert isinstance(body["dialect"], str)
    assert isinstance(body["cached"], bool)


def test_usage_priced_flag_is_present_and_distinguishes_unknown_from_zero():
    unknown = UsageModel(
        model="some-unpriced-model",
        promptTokens=100,
        completionTokens=100,
        totalTokens=200,
        llmCalls=1,
        estimatedCostUsd=0.0,
        latencyMs=10,
        priced=False,
    )
    body = unknown.model_dump()
    assert body["priced"] is False
    assert body["estimatedCostUsd"] == 0.0  # 0.0 here means UNKNOWN, not near-zero


def test_execute_response_serializes_to_ts_execute_result_shape():
    model = ExecuteResponse(
        columns=[ColumnModel(name="Id", type="INTEGER")],
        rows=[{"Id": 1}],
        rowCount=1,
        truncated=False,
    )
    body = model.model_dump()
    assert set(body.keys()) == _EXECUTE_KEYS
    assert set(body["columns"][0].keys()) == _COLUMN_KEYS
    assert isinstance(body["rows"], list)
    assert isinstance(body["rowCount"], int)
    assert isinstance(body["truncated"], bool)


def test_error_envelope_serializes_to_ts_service_error_envelope_shape():
    response = envelope_response("auth", "nope")
    import json

    body = json.loads(bytes(response.body))
    assert set(body.keys()) == {"error"}
    assert _ENVELOPE_ERROR_KEYS <= set(body["error"].keys())
    assert body["error"]["kind"] == "auth"
    assert isinstance(body["error"]["message"], str)


def test_error_envelope_kinds_match_the_ts_client_vocabulary():
    """The service's ErrorKind vocabulary MUST be a subset of the TS client's
    `Nl2sqlServiceErrorKind` (minus 'unavailable', a client-only transport
    sentinel), or `coerceErrorKind` would silently downgrade a kind to
    'internal'.
    """
    ts_kinds = {"scope", "generation", "guard", "engine", "bad_request", "internal", "auth"}
    from ceiba_nl2sql_service.errors import _KIND_TO_STATUS

    assert set(_KIND_TO_STATUS.keys()) <= ts_kinds
