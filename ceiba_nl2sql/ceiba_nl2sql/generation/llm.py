"""llm.py — the LlmClient abstraction + the OpenAI implementation (ports the
`LlmClient` interface from lib/rag/generate.ts and stands up the REAL OpenAI
client the plan calls for; docs/PYTHON_NL2SQL_SERVICE_PLAN.md §3.1
`generation/llm.py`).

── The seam ───────────────────────────────────────────────────────────────────
`LlmClient` is the ONLY seam to a driving LLM. `complete(prompt)` returns an
`LlmCompletion` — the model text PLUS the per-call token usage + resolved model
id — so the pipeline can meter cost across every call (including self-repair
rounds). Injected so tests stub it (no network, no BAA, no model download); the
stub reports SYNTHETIC token counts so the cost-metering path is exercised
hermetically (Phase 3 §5: "the stub must now also report synthetic token
counts").

── The egress choke point (§2.5) ─────────────────────────────────────────────
`call_llm` is the single choke point every LLM call in the pipeline goes
through. It enforces the egress gate BEFORE the prompt leaves the process for
a `patient-derived` call, then delegates to the injected client. Today the
pipeline only ever uses `schema-metadata` (always allowed); `patient-derived`
exists so a future row-derived prompt cannot silently bypass the gate.

── The real OpenAI client ────────────────────────────────────────────────────
`OpenAiLlmClient` calls the OpenAI Chat Completions API for real. It reads
`OPENAI_API_KEY` + a configurable model (`NL2SQL_LLM_MODEL`, default
`gpt-4o-mini`), and returns the completion text, the token usage OpenAI reports
(`prompt_tokens`/`completion_tokens`/`total_tokens`), and the model id from the
response (the API echoes the resolved model, which may differ from the request
alias). It never leaks a raw OpenAI error body to a caller (mirrors the TS
`createOpenAiLlmClient` H20 discipline) — `complete()` catches any SDK exception
and re-raises a generic `LlmUpstreamError` with the original detail available
only via `__cause__` for server-side logging.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass
from typing import Protocol

from ceiba_nl2sql.compliance.egress import LlmEgressClass, EgressBlockedError, assert_egress_allowed

logger = logging.getLogger("ceiba_nl2sql.generation.llm")

# Default driving model when the caller/settings do not pick one. Kept in sync
# with settings.openai_model / NL2SQL_LLM_MODEL's default.
DEFAULT_LLM_MODEL = "gpt-4o-mini"

# Sampling parameters for the driving LLM. Kept in sync with the TS in-process
# client (app/api/sql-generate/route.ts) so generation behaves identically on
# both runtimes across the migration window. `temperature=0` = deterministic
# SQL generation (we want the same SQL for the same schema+question, not
# creative variation); `max_tokens=600` bounds a single SQL+description
# completion (a generated statement + short description never approaches 600
# tokens, so this caps a runaway generation without truncating real output).
LLM_TEMPERATURE = 0.0
LLM_MAX_TOKENS = 600
# Reasoning models (gpt-5*, o-series) spend completion tokens on internal
# reasoning BEFORE emitting any answer text, and that reasoning counts against
# `max_completion_tokens`. A 600 cap leaves nothing for the actual SQL (the
# model returns an EMPTY completion). Give reasoning models a much larger cap so
# reasoning + the SQL both fit; chat models keep the tight 600 bound.
LLM_MAX_COMPLETION_TOKENS_REASONING = 4000


@dataclass(frozen=True)
class TokenUsage:
    """Per-call token counts. Mirrors OpenAI's `usage` object. All fields
    default to 0 so a client that cannot report usage (or a stub that chooses
    not to) still yields a well-formed, summable value.

    `cached_prompt_tokens` is the prompt-prefix cache-hit portion
    (`usage.prompt_tokens_details.cached_tokens`) — a SUBSET of
    `prompt_tokens` billed at the provider's discounted cached-input rate.
    Metered so prompt-caching gains are measurable, not guessed.
    """

    prompt_tokens: int = 0
    completion_tokens: int = 0
    total_tokens: int = 0
    cached_prompt_tokens: int = 0

    def __add__(self, other: "TokenUsage") -> "TokenUsage":
        return TokenUsage(
            prompt_tokens=self.prompt_tokens + other.prompt_tokens,
            completion_tokens=self.completion_tokens + other.completion_tokens,
            total_tokens=self.total_tokens + other.total_tokens,
            cached_prompt_tokens=self.cached_prompt_tokens + other.cached_prompt_tokens,
        )


@dataclass(frozen=True)
class LlmCompletion:
    """The result of one LLM call: the raw text, the token usage, and the
    model id the provider actually used (may differ from the requested alias).
    """

    text: str
    usage: TokenUsage
    model: str


class LlmClient(Protocol):
    """The ONLY seam to a driving LLM. `complete(prompt) -> LlmCompletion`."""

    async def complete(self, prompt: str) -> LlmCompletion: ...


class LlmUpstreamError(RuntimeError):
    """Raised when the real LLM call fails. The message is always safe to
    log/return generically; the original exception is chained via `raise ...
    from exc` so full detail is still available server-side (H20 discipline
    — mirrors lib/errors.ts `safeError`: never echo raw upstream detail to a
    client).
    """


async def call_llm(llm: LlmClient, prompt: str, egress_class: LlmEgressClass) -> LlmCompletion:
    """The single choke point for every LLM call in generation. Enforces the
    egress gate BEFORE the prompt leaves the process for a `patient-derived`
    call, then delegates to the injected client. Mirrors lib/rag/generate.ts
    `callLlm` exactly. Returns the full `LlmCompletion` (text + usage + model)
    so the pipeline can meter cost across every call.
    """
    if egress_class == "patient-derived":
        decision = assert_egress_allowed()
        if not decision.allowed:
            raise EgressBlockedError(decision.message)
    return await llm.complete(prompt)


# ── stub / recorded implementations (hermetic tests) ─────────────────────────


def _synthetic_usage(prompt: str, completion: str) -> TokenUsage:
    """A deterministic, roughly-realistic synthetic token count for a
    prompt/completion pair — ~4 chars per token (OpenAI's rule of thumb). Used
    by the stub/recorded clients so the cost-metering path is exercised in
    hermetic tests WITHOUT a real tokenizer or network (Phase 3 §5).
    """
    prompt_tokens = max(1, len(prompt) // 4)
    completion_tokens = max(1, len(completion) // 4)
    return TokenUsage(
        prompt_tokens=prompt_tokens,
        completion_tokens=completion_tokens,
        total_tokens=prompt_tokens + completion_tokens,
    )


class StubLlmClient:
    """A stub LlmClient returning queued completions in order (one per LLM
    call) — mirrors the TS test suite's `QueuedLlmClient`. Raises if asked
    for more completions than were queued, so a test's expected call count
    is enforced.

    Reports SYNTHETIC per-call token counts (derived from the prompt +
    completion lengths) so the cost-metering path (usage summing + USD
    estimate) is exercised hermetically. The synthetic model id defaults to
    `gpt-4o-mini` (the priced default) so `estimated_cost_usd` is non-zero in
    tests; override via `model=`.
    """

    def __init__(self, completions: list[str], *, model: str = DEFAULT_LLM_MODEL) -> None:
        self._queue = list(completions)
        self._model = model
        self.prompts: list[str] = []

    async def complete(self, prompt: str) -> LlmCompletion:
        self.prompts.append(prompt)
        if not self._queue:
            raise RuntimeError("StubLlmClient: no more queued completions")
        text = self._queue.pop(0)
        return LlmCompletion(text=text, usage=_synthetic_usage(prompt, text), model=self._model)


class RecordedLlmClient:
    """Replays a fixed mapping of prompt (or prompt substring) -> completion,
    for eval/regression scenarios where a queue's strict ordering is too
    brittle. Falls back to `default_completion` if no key matches. Reports
    synthetic token usage like `StubLlmClient`.
    """

    def __init__(
        self,
        recordings: dict[str, str],
        *,
        default_completion: str | None = None,
        model: str = DEFAULT_LLM_MODEL,
    ) -> None:
        self._recordings = recordings
        self._default = default_completion
        self._model = model
        self.prompts: list[str] = []

    async def complete(self, prompt: str) -> LlmCompletion:
        self.prompts.append(prompt)
        for key, completion in self._recordings.items():
            if key in prompt:
                return LlmCompletion(text=completion, usage=_synthetic_usage(prompt, completion), model=self._model)
        if self._default is not None:
            return LlmCompletion(text=self._default, usage=_synthetic_usage(prompt, self._default), model=self._model)
        raise RuntimeError("RecordedLlmClient: no recording matched the prompt and no default_completion was set")


# ── the real OpenAI client (network path exists; gated by the egress choke point) ──


class OpenAiLlmClient:
    """The real driving-LLM client (SPEC §5.1 [C]), backed by the OpenAI
    Chat Completions API. Constructed with an API key from `OPENAI_API_KEY`
    and a model from `NL2SQL_LLM_MODEL` (default `gpt-4o-mini`); never called
    in tests (they inject `StubLlmClient` instead).

    Returns the completion text PLUS the token usage OpenAI reports and the
    resolved model id from the response, so the pipeline can meter per-query
    cost. The BAA/egress gate is enforced by `call_llm` (the choke point), not
    by this class — this class only knows how to talk to OpenAI. Do not call
    `.complete()` directly from pipeline code; always go through `call_llm`.
    """

    def __init__(self, *, api_key: str, model: str = DEFAULT_LLM_MODEL, timeout_seconds: float = 30.0) -> None:
        self._model = model
        self._timeout_seconds = timeout_seconds
        # Imported lazily so a service that never exercises the real OpenAI
        # path (e.g. this phase's hermetic test suite) does not require the
        # `openai` package to even be importable at collection time — though
        # it IS a declared dependency (pyproject), so this is defense only.
        from openai import AsyncOpenAI

        self._client = AsyncOpenAI(api_key=api_key, timeout=timeout_seconds)

    async def complete(self, prompt: str) -> LlmCompletion:
        # Newer OpenAI models (gpt-5*, o-series reasoning models) renamed
        # `max_tokens` -> `max_completion_tokens` and reject a custom
        # `temperature` (only the default 1 is allowed). Older chat models
        # (gpt-4o*, gpt-4.1*) still take `max_tokens` + a custom temperature.
        # Detect by model-id family and send the params that model accepts.
        params: dict = {
            "model": self._model,
            "messages": [{"role": "user", "content": prompt}],
        }
        model_id = self._model.lower()
        uses_completion_tokens = model_id.startswith(("gpt-5", "o1", "o3", "o4"))
        if uses_completion_tokens:
            # reasoning models burn completion tokens on hidden reasoning, so
            # cap must be large enough for reasoning + the emitted SQL.
            params["max_completion_tokens"] = LLM_MAX_COMPLETION_TOKENS_REASONING
            # do NOT set temperature — these models only allow the default (1).
        else:
            params["max_tokens"] = LLM_MAX_TOKENS
            params["temperature"] = LLM_TEMPERATURE
        try:
            response = await self._client.chat.completions.create(**params)
        except Exception as exc:  # noqa: BLE001 - deliberately broad: any SDK error is scrubbed before surfacing
            logger.error("OpenAI completion failed: %s", exc)
            raise LlmUpstreamError("The driving language model is temporarily unavailable.") from exc

        choice = response.choices[0] if response.choices else None
        content = choice.message.content if choice and choice.message else None
        if not content:
            raise LlmUpstreamError("The driving language model returned an empty completion.")

        usage_obj = getattr(response, "usage", None)
        # prompt_tokens_details.cached_tokens = the prompt-prefix cache-hit
        # portion, billed at the discounted cached-input rate. Absent on older
        # models/SDKs -> 0.
        prompt_details = getattr(usage_obj, "prompt_tokens_details", None)
        usage = TokenUsage(
            prompt_tokens=getattr(usage_obj, "prompt_tokens", 0) or 0,
            completion_tokens=getattr(usage_obj, "completion_tokens", 0) or 0,
            total_tokens=getattr(usage_obj, "total_tokens", 0) or 0,
            cached_prompt_tokens=getattr(prompt_details, "cached_tokens", 0) or 0,
        )
        # OpenAI echoes the resolved model (e.g. a dated snapshot) — record it
        # verbatim so cost pricing + audit reflect exactly what ran.
        resolved_model = getattr(response, "model", None) or self._model
        return LlmCompletion(text=content, usage=usage, model=resolved_model)


def build_llm_client(*, api_key: str | None, model: str = DEFAULT_LLM_MODEL) -> LlmClient:
    """Constructs the real OpenAI LlmClient. Raises if no API key is
    configured — callers (deps.py) decide whether that is fatal (readyz) or
    tolerable (dark/unused paths).
    """
    if not api_key:
        raise LlmUpstreamError("OPENAI_API_KEY is not configured.")
    return OpenAiLlmClient(api_key=api_key, model=model)
