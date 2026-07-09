"""llm.py — the LlmClient abstraction + the OpenAI implementation (ports the
`LlmClient` interface from lib/rag/generate.ts and stands up the REAL OpenAI
client the plan calls for; docs/PYTHON_NL2SQL_SERVICE_PLAN.md §3.1
`generation/llm.py`).

── The seam ───────────────────────────────────────────────────────────────────
`LlmClient` is the ONLY seam to a driving LLM (mirrors lib/rag/generate.ts's
`LlmClient` interface exactly: one method, `complete(prompt) -> str`).
Injected so tests stub it (no network, no BAA, no model download).

── The egress choke point (§2.5) ─────────────────────────────────────────────
`call_llm` is the single choke point every LLM call in the pipeline goes
through. It enforces the egress gate BEFORE the prompt leaves the process for
a `patient-derived` call, then delegates to the injected client — exactly
mirroring lib/rag/generate.ts's `callLlm`. Today the pipeline only ever uses
`schema-metadata` (always allowed); `patient-derived` exists so a future
row-derived prompt cannot silently bypass the gate.

── The real OpenAI client ────────────────────────────────────────────────────
`OpenAiLlmClient` exists so the real call path is wired up this phase (per
the task: "the real OpenAI call path should EXIST but tests use the stub").
It reads `OPENAI_API_KEY` from the environment and never leaks a raw OpenAI
error body to a caller (mirrors the TS `createOpenAiLlmClient` H20
discipline) — `complete()` catches any SDK exception and re-raises a generic
`LlmUpstreamError` with the original detail available only via `__cause__`
for server-side logging, never in the message a route would echo back.
"""

from __future__ import annotations

import logging
from typing import Protocol

from ceiba_nl2sql.compliance.egress import LlmEgressClass, EgressBlockedError, assert_egress_allowed

logger = logging.getLogger("ceiba_nl2sql.generation.llm")


class LlmClient(Protocol):
    """The ONLY seam to a driving LLM. Mirrors lib/rag/generate.ts `LlmClient`."""

    async def complete(self, prompt: str) -> str: ...


class LlmUpstreamError(RuntimeError):
    """Raised when the real LLM call fails. The message is always safe to
    log/return generically; the original exception is chained via `raise ...
    from exc` so full detail is still available server-side (H20 discipline
    — mirrors lib/errors.ts `safeError`: never echo raw upstream detail to a
    client).
    """


async def call_llm(llm: LlmClient, prompt: str, egress_class: LlmEgressClass) -> str:
    """The single choke point for every LLM call in generation. Enforces the
    egress gate BEFORE the prompt leaves the process for a `patient-derived`
    call, then delegates to the injected client. Mirrors lib/rag/generate.ts
    `callLlm` exactly.
    """
    if egress_class == "patient-derived":
        decision = assert_egress_allowed()
        if not decision.allowed:
            raise EgressBlockedError(decision.message)
    return await llm.complete(prompt)


# ── stub / recorded implementations (hermetic tests) ─────────────────────────


class StubLlmClient:
    """A stub LlmClient returning queued completions in order (one per LLM
    call) — mirrors the TS test suite's `QueuedLlmClient`. Raises if asked
    for more completions than were queued, so a test's expected call count
    is enforced.
    """

    def __init__(self, completions: list[str]) -> None:
        self._queue = list(completions)
        self.prompts: list[str] = []

    async def complete(self, prompt: str) -> str:
        self.prompts.append(prompt)
        if not self._queue:
            raise RuntimeError("StubLlmClient: no more queued completions")
        return self._queue.pop(0)


class RecordedLlmClient:
    """Replays a fixed mapping of prompt (or prompt substring) -> completion,
    for eval/regression scenarios where a queue's strict ordering is too
    brittle. Falls back to `default_completion` if no key matches.
    """

    def __init__(self, recordings: dict[str, str], *, default_completion: str | None = None) -> None:
        self._recordings = recordings
        self._default = default_completion
        self.prompts: list[str] = []

    async def complete(self, prompt: str) -> str:
        self.prompts.append(prompt)
        for key, completion in self._recordings.items():
            if key in prompt:
                return completion
        if self._default is not None:
            return self._default
        raise RuntimeError("RecordedLlmClient: no recording matched the prompt and no default_completion was set")


# ── the real OpenAI client (network path exists; gated by the egress choke point) ──


class OpenAiLlmClient:
    """The real driving-LLM client (SPEC §5.1 [C]), backed by the OpenAI
    Chat Completions API. Constructed with an API key from
    `OPENAI_API_KEY`; never called in tests (they inject `StubLlmClient`
    instead) — this class exists so Phase 3's cutover only has to flip a
    dependency, not write a new client.

    The BAA/egress gate is enforced by `call_llm` (the choke point), not by
    this class — this class only knows how to talk to OpenAI. Do not call
    `.complete()` directly from pipeline code; always go through `call_llm`.
    """

    def __init__(self, *, api_key: str, model: str = "gpt-4o-mini", timeout_seconds: float = 30.0) -> None:
        self._model = model
        self._timeout_seconds = timeout_seconds
        # Imported lazily so a service that never exercises the real OpenAI
        # path (e.g. this phase's hermetic test suite) does not require the
        # `openai` package to even be importable at collection time — though
        # it IS a declared dependency (pyproject), so this is defense only.
        from openai import AsyncOpenAI

        self._client = AsyncOpenAI(api_key=api_key, timeout=timeout_seconds)

    async def complete(self, prompt: str) -> str:
        try:
            response = await self._client.chat.completions.create(
                model=self._model,
                messages=[{"role": "user", "content": prompt}],
                temperature=0,
            )
        except Exception as exc:  # noqa: BLE001 - deliberately broad: any SDK error is scrubbed before surfacing
            logger.error("OpenAI completion failed: %s", exc)
            raise LlmUpstreamError("The driving language model is temporarily unavailable.") from exc

        choice = response.choices[0] if response.choices else None
        content = choice.message.content if choice and choice.message else None
        if not content:
            raise LlmUpstreamError("The driving language model returned an empty completion.")
        return content


def build_llm_client(*, api_key: str | None, model: str = "gpt-4o-mini") -> LlmClient:
    """Constructs the real OpenAI LlmClient. Raises if no API key is
    configured — callers (deps.py) decide whether that is fatal (readyz) or
    tolerable (dark/unused paths).
    """
    if not api_key:
        raise LlmUpstreamError("OPENAI_API_KEY is not configured.")
    return OpenAiLlmClient(api_key=api_key, model=model)
