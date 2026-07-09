"""egress.py — PHI/BAA egress gate (ports lib/phiScrubber.ts's
`assertEgressAllowed()` / `OPENAI_BAA_SIGNED` gate into Python;
docs/PYTHON_NL2SQL_SERVICE_PLAN.md §2.5, §3.1 `compliance/egress.py`).

── Why this exists here now (§2.5) ───────────────────────────────────────────
The plan moves the LLM call itself into Python (`generation/pipeline.py`), so
the egress gate must move to sit beside the choke point it guards — enforcing
it one process away from the actual OpenAI call (as today's TS/Python split
would otherwise require) would be weaker, not stronger. This module is a
faithful port of `lib/phiScrubber.ts`'s `isEgressAllowed` / `assertEgressAllowed`:
same env var (`OPENAI_BAA_SIGNED`), same default-closed posture, same message.

── Egress classes (mirrors lib/rag/generate.ts `LlmEgressClass`) ─────────────
`schema-metadata`   — schema/glossary/exemplars only, never a raw patient row.
                       Inherently BAA-safe by construction; ALWAYS allowed.
`patient-derived`   — any row-derived content (aggregates, scrubbed context).
                       Gated CLOSED by default; requires OPENAI_BAA_SIGNED=true.

Generation (`generation/pipeline.py`) only ever uses `schema-metadata` today —
the retriever never reads a raw cell, so the prompt sent to the LLM is
BAA-safe by construction. The `patient-derived` class exists so a future
row-derived prompt cannot silently bypass the gate: it exists to be gated,
not to be used by the current pipeline.
"""

from __future__ import annotations

import os
from dataclasses import dataclass
from typing import Literal

LlmEgressClass = Literal["schema-metadata", "patient-derived"]


@dataclass(frozen=True)
class EgressDecision:
    """Mirrors lib/phiScrubber.ts `EgressDecision`."""

    allowed: bool
    reason: Literal["baa_not_signed"] | None
    message: str


def is_egress_allowed() -> bool:
    """Mirror of lib/phiScrubber.ts `isEgressAllowed`: reads OPENAI_BAA_SIGNED
    from THIS process's env (the service's own env is now authoritative per
    plan §2.5 — the gate lives beside the code that actually calls OpenAI).

    Intentionally an EXACT, case-sensitive comparison against the literal
    string "true" — mirrors `process.env.OPENAI_BAA_SIGNED === 'true'`
    verbatim (not a lenient `.strip().lower()` truthy check), so a
    misconfigured env value (e.g. "True", "TRUE", " true") fails closed on
    both sides of the TS/Python migration window identically rather than
    being permissive in one language and strict in the other.
    """
    return os.environ.get("OPENAI_BAA_SIGNED") == "true"


def assert_egress_allowed() -> EgressDecision:
    """Decision object callers branch on before sending ANY patient-derived
    data to OpenAI. Mirrors lib/phiScrubber.ts `assertEgressAllowed` verbatim
    (same message text, so audit logs read identically across the TS/Python
    migration window).
    """
    if is_egress_allowed():
        return EgressDecision(
            allowed=True, reason=None, message="AI egress permitted (BAA + residency asserted)."
        )
    return EgressDecision(
        allowed=False,
        reason="baa_not_signed",
        message=(
            "AI features over patient data are disabled until the OpenAI BAA and "
            "data-residency (KVKK cross-border) basis are in place. Set "
            "OPENAI_BAA_SIGNED=true only after both are resolved."
        ),
    )


class EgressBlockedError(RuntimeError):
    """Raised when a `patient-derived` LLM call is attempted while the egress
    gate is closed. Mirrors lib/rag/generate.ts `EgressBlockedError`.
    """
