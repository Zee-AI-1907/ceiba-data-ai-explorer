"""app.py — the FastAPI NL->SQL runtime service (Phase 2, DARK;
docs/PYTHON_NL2SQL_SERVICE_PLAN.md §2.2, §3.1 `app.py`).

Endpoints (verbatim wire contracts, §2.2):
  POST /nl2sql/generate  — NL -> SQL (mirrors app/api/sql-generate/route.ts's body)
  POST /nl2sql/execute   — execute a (TS-re-guarded) SQL string (§2.3: execution moves to Python)
  POST /nl2sql/explain   — dry-run validate (internal; also used by generate's self-repair loop)
  GET  /healthz          — liveness (no DB touch)
  GET  /readyz           — bundle loaded + engine attached + embedder resolvable

Every protected route requires the internal service Bearer token (§2.1); TS
route wrappers (auth/rate-limit/body-size/validate/cache/audit) all stay in
TS — this service is ONLY the NL->SQL runtime behind that boundary (§1.2).
"""

from __future__ import annotations

import logging
import uuid as _uuid
from contextlib import asynccontextmanager

from fastapi import Depends, FastAPI, Request
from fastapi.concurrency import run_in_threadpool
from fastapi.responses import JSONResponse

from ceiba_nl2sql.bundle.loader import BundleLoadError
from ceiba_nl2sql.compliance.egress import EgressBlockedError
from ceiba_nl2sql.engine.base import ExecuteOptions
from ceiba_nl2sql.engine.duckdb_engine import EngineDeadlineExceededError, NonReadOnlyAttachError
from ceiba_nl2sql.generation.llm import LlmUpstreamError
from ceiba_nl2sql.generation.pipeline import GenerateOptions, GenerationError, generate_sql
from ceiba_nl2sql.sqltools.guard import guard_sql

from ceiba_nl2sql_service.auth import require_internal_token
from ceiba_nl2sql_service.deps import AppState, create_app_state
from ceiba_nl2sql_service.errors import ServiceError, envelope_response, safe_error_response
from ceiba_nl2sql_service.models import (
    ColumnModel,
    ExecuteRequest,
    ExecuteResponse,
    ExplainRequest,
    ExplainResponse,
    GenerateRequest,
    GenerateResponse,
    HealthzResponse,
    RepairInfoModel,
    ReadyzResponse,
    RetrievalSummaryModel,
    UsageModel,
)
from ceiba_nl2sql_service.settings import get_settings

logger = logging.getLogger("ceiba_nl2sql_service.app")

MAX_QUERY_ROWS = 5000
DEFAULT_MAX_ROWS = 1000
DEFAULT_DEADLINE_MS = 55_000


@asynccontextmanager
async def _lifespan(app: FastAPI):
    """Loads the bundle + attaches the engine ONCE at process startup
    (mirrors the TS route's memoized `getGenerationDeps`). If bring-up fails
    (e.g. NL2SQL_BUNDLE_DIR unset in a dev shell), the service still boots so
    /healthz responds — /readyz reports the failure instead of the process
    refusing to start, which would make even liveness probing impossible.
    """
    settings = get_settings()
    try:
        app.state.nl2sql = create_app_state(settings)
        app.state.nl2sql_error = None
    except Exception as exc:  # noqa: BLE001 - deliberately broad: startup bring-up failure must not crash the process
        logger.warning("AppState bring-up failed at startup: %s", exc)
        app.state.nl2sql = None
        app.state.nl2sql_error = str(exc)
    yield
    if app.state.nl2sql is not None:
        app.state.nl2sql.dispose()


app = FastAPI(title="ceiba-nl2sql-service", lifespan=_lifespan)


def get_app_state(request: Request) -> AppState:
    state: AppState | None = getattr(request.app.state, "nl2sql", None)
    if state is None:
        raise ServiceError("internal", "The NL->SQL runtime is not ready.")
    return state


# ── GET /healthz, /readyz (unauthenticated — §2.1, §7.2) ─────────────────────


@app.get("/healthz", response_model=HealthzResponse)
async def healthz() -> HealthzResponse:
    return HealthzResponse()


@app.get("/readyz", response_model=ReadyzResponse)
async def readyz(request: Request) -> ReadyzResponse:
    state: AppState | None = getattr(request.app.state, "nl2sql", None)
    if state is None:
        reason = getattr(request.app.state, "nl2sql_error", "not initialized")
        return ReadyzResponse(ready=False, reason=reason)
    return ReadyzResponse(
        ready=True,
        bundleVersion=state.bundle_version,
        embeddingModelId=state.embedding_model_id,
        engineAttached=True,
    )


# ── POST /nl2sql/generate (§2.2) ─────────────────────────────────────────────


def _usage_model(usage) -> UsageModel | None:
    """Map the pipeline's `UsageSummary` dataclass onto the wire `UsageModel`.
    None-safe: a response without metered usage (should not happen for a real
    generate, but defensive) yields None.
    """
    if usage is None:
        return None
    return UsageModel(
        model=usage.model,
        promptTokens=usage.prompt_tokens,
        completionTokens=usage.completion_tokens,
        totalTokens=usage.total_tokens,
        llmCalls=usage.llm_calls,
        estimatedCostUsd=usage.estimated_cost_usd,
        latencyMs=usage.latency_ms,
        priced=usage.priced,
        cachedPromptTokens=getattr(usage, "cached_prompt_tokens", 0),
    )


def _log_usage(correlation_id: str, tenant_id: str | None, outcome: str, usage) -> None:
    """Structured server-side per-request cost log, keyed by the correlation id
    the TS caller forwarded (§7.7 "the service logs its own structured lines
    keyed by the same request-id"). This is what lets us measure per-query cost
    server-side independent of the response body.
    """
    if usage is None:
        return
    logger.info(
        "nl2sql.generate.usage correlationId=%s tenantId=%s outcome=%s model=%s "
        "promptTokens=%d completionTokens=%d totalTokens=%d llmCalls=%d estimatedCostUsd=%.6f latencyMs=%d priced=%s",
        correlation_id,
        tenant_id or "-",
        outcome,
        usage.model,
        usage.prompt_tokens,
        usage.completion_tokens,
        usage.total_tokens,
        usage.llm_calls,
        usage.estimated_cost_usd,
        usage.latency_ms,
        usage.priced,
    )


@app.post("/nl2sql/generate", response_model=GenerateResponse, dependencies=[Depends(require_internal_token)])
async def nl2sql_generate(payload: GenerateRequest, request: Request, state: AppState = Depends(get_app_state)):
    # Correlation id forwarded by the TS route (lib/nl2sqlServiceClient.ts) so a
    # single NL->SQL request traces Next -> FastAPI (§7.7). Generated here if
    # absent (e.g. a direct/manual call).
    correlation_id = request.headers.get("x-correlation-id") or str(_uuid.uuid4())
    tenant_id = payload.tenantId or (payload.context.activeOrgId if payload.context else None)

    options = payload.options
    generate_options = GenerateOptions(
        max_repair_rounds=options.maxRepairRounds if options and options.maxRepairRounds is not None else 2,
        default_limit=options.defaultLimit if options and options.defaultLimit is not None else 1000,
        token_budget=options.tokenBudget if options and options.tokenBudget is not None else 2500,
        max_tables=options.maxTables if options and options.maxTables is not None else 6,
        source_scope=payload.sourceScope,
    )

    try:
        llm = state.llm_client()
    except LlmUpstreamError as exc:
        return safe_error_response(exc, context="generate.llm_client", kind="engine")

    try:
        response = await generate_sql(
            question=payload.question,
            engine=state.engine,
            retriever=state.retriever,
            llm=llm,
            dialect=payload.dialect,
            options=generate_options,
            cached=False,
            # Offload the pipeline's BLOCKING segments (retriever.retrieve —
            # embed + BM25; engine.explain — DuckDB) to the threadpool so the
            # event loop is not stalled and concurrent requests are not
            # serialized. The genuinely-async LLM calls stay on the loop.
            offload=run_in_threadpool,
        )
    except EgressBlockedError as exc:
        return envelope_response("scope", str(exc))
    except GenerationError as exc:
        # Even a failed generate burned tokens — log the cost it spent.
        _log_usage(correlation_id, tenant_id, "generation_failed", exc.usage)
        return envelope_response(
            "generation",
            "Could not produce safe, executable SQL within the repair budget.",
            detail={"rounds": exc.rounds, "lastError": exc.last_error},
        )
    except LlmUpstreamError as exc:
        return safe_error_response(exc, context="generate.llm_call", kind="engine")
    except Exception as exc:  # noqa: BLE001 - any unexpected pipeline failure is scrubbed before returning
        return safe_error_response(exc, context="generate", kind="internal")

    usage_model = _usage_model(response.usage)

    if response.error == "scope":
        _log_usage(correlation_id, tenant_id, "scope", response.usage)
        return GenerateResponse(
            sql="",
            description="",
            dialect=response.dialect,
            retrieval=RetrievalSummaryModel(
                tables=response.retrieval.tables,
                exemplarsUsed=response.retrieval.exemplars_used,
                cardinalityWarnings=response.retrieval.cardinality_warnings,
            ),
            cached=response.cached,
            error="scope",
            usage=usage_model,
        )

    _log_usage(correlation_id, tenant_id, "success", response.usage)
    return GenerateResponse(
        sql=response.sql,
        description=response.description,
        dialect=response.dialect,
        retrieval=RetrievalSummaryModel(
            tables=response.retrieval.tables,
            exemplarsUsed=response.retrieval.exemplars_used,
            cardinalityWarnings=response.retrieval.cardinality_warnings,
        ),
        repair=RepairInfoModel(rounds=response.repair.rounds, lastError=response.repair.last_error) if response.repair else None,
        cached=response.cached,
        usage=usage_model,
    )


# ── POST /nl2sql/explain (§2.2) ──────────────────────────────────────────────


@app.post("/nl2sql/explain", response_model=ExplainResponse, dependencies=[Depends(require_internal_token)])
async def nl2sql_explain(payload: ExplainRequest, state: AppState = Depends(get_app_state)):
    guard_verdict = guard_sql(payload.sql, dialect=payload.dialect or state.engine.dialect())
    if not guard_verdict.allowed:
        return ExplainResponse(ok=False, error=guard_verdict.reason or "SQL rejected by the read-only guard.")

    # DuckDB's engine methods are BLOCKING (synchronous C calls). Running them
    # directly on the event loop would stall it for every request; offload to
    # Starlette's threadpool. The engine runs each explain() on a per-call
    # DuckDB cursor (its lock covers only attach/dispose/harden), so
    # threadpool workers run queries genuinely in parallel — concurrency is
    # capped by the threadpool size, not by the engine.
    result = await run_in_threadpool(state.engine.explain, payload.sql)
    if result.ok:
        return ExplainResponse(ok=True, plan=result.plan)  # type: ignore[union-attr]
    return ExplainResponse(ok=False, error=result.error)  # type: ignore[union-attr]


# ── POST /nl2sql/execute (§2.2, §2.3) ────────────────────────────────────────


@app.post("/nl2sql/execute", response_model=ExecuteResponse, dependencies=[Depends(require_internal_token)])
async def nl2sql_execute(payload: ExecuteRequest, state: AppState = Depends(get_app_state)):
    # The service execution path is NOT the security boundary (§1.3, §2.3) —
    # the TS `/api/query` route already ran guardSql + the catalog/schema
    # allowlist before calling this endpoint. This re-check is defense in
    # depth: the service must never trust that ANY caller (including a
    # future direct caller that skips the TS route) submitted guard-passed
    # SQL. A write/DDL statement is rejected here even if it somehow reached
    # this endpoint unguarded.
    guard_verdict = guard_sql(payload.sql, dialect=state.engine.dialect())
    if not guard_verdict.allowed:
        # `guard` maps to 422 in the taxonomy (a rejected request, not an
        # upstream failure) — no status override needed; the mapping is
        # authoritative and documented in errors.py.
        return envelope_response("guard", guard_verdict.reason or "SQL rejected by the read-only guard.")

    max_rows = min(payload.maxRows or DEFAULT_MAX_ROWS, MAX_QUERY_ROWS)
    deadline_ms = payload.deadlineMs or DEFAULT_DEADLINE_MS

    try:
        # Offload the BLOCKING DuckDB execute to the threadpool so a single
        # long query does not stall the event loop for all other requests.
        # The engine runs each execute() on a per-call DuckDB cursor (its lock
        # covers only attach/dispose/harden), so a slow query here does NOT
        # serialize other requests' queries — concurrency is capped by the
        # threadpool size, not by the engine.
        result = await run_in_threadpool(
            state.engine.execute,
            payload.sql,
            ExecuteOptions(catalog=payload.database, schema=payload.schema_, max_rows=max_rows, deadline_ms=deadline_ms),
        )
    except EngineDeadlineExceededError as exc:
        return envelope_response("engine", "The query exceeded its execution time budget.", status_code=502)
    except NonReadOnlyAttachError as exc:
        return safe_error_response(exc, context="execute.attach", kind="engine")
    except Exception as exc:  # noqa: BLE001 - DuckDB/driver errors are scrubbed before returning
        return safe_error_response(exc, context="execute", kind="engine")

    return ExecuteResponse(
        columns=[ColumnModel(name=c.name, type=c.type) for c in result.columns],
        rows=result.rows,
        rowCount=result.row_count,
        truncated=result.truncated,
    )


# ── generic exception handlers (last-resort H20 scrub) ───────────────────────


@app.exception_handler(ServiceError)
async def _service_error_handler(_request: Request, exc: ServiceError) -> JSONResponse:
    return envelope_response(exc.kind, exc.message, detail=exc.detail, status_code=exc.status_code)


@app.exception_handler(BundleLoadError)
async def _bundle_load_error_handler(_request: Request, exc: BundleLoadError) -> JSONResponse:
    return safe_error_response(exc, context="bundle_load", kind="engine")
