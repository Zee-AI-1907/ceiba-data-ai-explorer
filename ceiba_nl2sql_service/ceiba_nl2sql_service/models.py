"""models.py — Pydantic request/response schemas for the FastAPI service,
mirroring `lib/rag/generate.ts`'s `SqlGenerateResponse` and the plan's §2.2
wire contracts VERBATIM so `lib/sqlGenerateClient.ts`'s existing TS contract
still matches after Phase 3 cutover (docs/PYTHON_NL2SQL_SERVICE_PLAN.md
§2.2, §2.4).
"""

from __future__ import annotations

from typing import Literal

from pydantic import BaseModel, Field

SqlDialect = Literal["duckdb", "postgres", "trino"]


# ── shared: the trusted-but-scoped org/user context (§2.1, §2.2) ────────────


class RequestContext(BaseModel):
    """Resolved by TS; trusted-but-scoped. `activeOrgId` scopes source
    selection/telemetry only — the service never re-authorizes on it (§2.5).
    """

    userId: str | None = None
    activeOrgId: str | None = None
    role: str | None = None


# ── POST /nl2sql/generate (§2.2) ─────────────────────────────────────────────


class GenerateOptionsModel(BaseModel):
    maxRepairRounds: int | None = None
    defaultLimit: int | None = None
    tokenBudget: int | None = None
    maxTables: int | None = None


class GenerateRequest(BaseModel):
    question: str = Field(..., min_length=1)
    tenantId: str | None = None
    context: RequestContext | None = None
    dialect: SqlDialect | None = None
    sourceScope: list[str] | None = None
    options: GenerateOptionsModel | None = None


class RetrievalSummaryModel(BaseModel):
    tables: list[str]
    exemplarsUsed: list[str]
    cardinalityWarnings: list[str]


class RepairInfoModel(BaseModel):
    rounds: int
    lastError: str | None = None


class UsageModel(BaseModel):
    """Per-query LLM cost + token metering (Phase 3 KEY deliverable). Summed
    across EVERY LLM call in the generate request (initial + each self-repair
    round). `estimatedCostUsd` is priced from generation/pricing.py's table.
    """

    model: str
    promptTokens: int
    completionTokens: int
    totalTokens: int
    llmCalls: int
    estimatedCostUsd: float
    latencyMs: int


class GenerateResponse(BaseModel):
    """Mirrors `SqlGenerateResponse` in lib/rag/generate.ts verbatim, plus an
    additive `usage` block for per-query cost metering (Phase 3).
    """

    sql: str
    description: str
    dialect: SqlDialect
    retrieval: RetrievalSummaryModel
    repair: RepairInfoModel | None = None
    cached: bool = False
    error: Literal["scope"] | None = None
    usage: UsageModel | None = None


# ── POST /nl2sql/execute (§2.2, §2.3) ────────────────────────────────────────


class ExecuteRequest(BaseModel):
    sql: str = Field(..., min_length=1)
    tenantId: str | None = None
    context: RequestContext | None = None
    database: str | None = None
    schema_: str | None = Field(default=None, alias="schema")
    maxRows: int | None = None
    deadlineMs: int | None = None

    model_config = {"populate_by_name": True}


class ColumnModel(BaseModel):
    name: str
    type: str


class ExecuteResponse(BaseModel):
    columns: list[ColumnModel]
    rows: list[dict]
    rowCount: int
    truncated: bool


# ── POST /nl2sql/explain (§2.2) ──────────────────────────────────────────────


class ExplainRequest(BaseModel):
    sql: str = Field(..., min_length=1)
    dialect: SqlDialect | None = None


class ExplainResponse(BaseModel):
    ok: bool
    plan: str | None = None
    error: str | None = None


# ── GET /healthz, /readyz (§2.2) ─────────────────────────────────────────────


class HealthzResponse(BaseModel):
    status: Literal["ok"] = "ok"


class ReadyzResponse(BaseModel):
    ready: bool
    bundleVersion: str | None = None
    embeddingModelId: str | None = None
    engineAttached: bool = False
    reason: str | None = None


# ── error envelope (§2.4) ────────────────────────────────────────────────────

ErrorKind = Literal["scope", "generation", "guard", "engine", "bad_request", "internal", "auth"]


class ServiceErrorDetail(BaseModel):
    kind: ErrorKind
    message: str
    detail: dict | None = None


class ServiceErrorEnvelope(BaseModel):
    error: ServiceErrorDetail
