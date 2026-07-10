"""pricing.py — per-model USD price table + cost computation for LLM usage
metering (docs/PYTHON_NL2SQL_SERVICE_PLAN.md §7.5 "Latency + cost of two
stacks", Phase 3 KEY deliverable: "measure per-query costs").

── What this is ────────────────────────────────────────────────────────────
A small, overridable table mapping an OpenAI model id to its price in USD per
1,000,000 (1M) input (prompt) tokens and per 1M output (completion) tokens,
plus `estimate_cost_usd()` which turns a `(model, prompt_tokens,
completion_tokens)` triple into an estimated USD cost. This is the single
place the service derives per-query cost from, so a price change is one edit.

── Prices ──────────────────────────────────────────────────────────────────
The built-in `DEFAULT_MODEL_PRICES` carries current list prices for the models
the service is likely to run (`gpt-4o-mini` is the default driving model). All
prices are USD per 1M tokens (OpenAI publishes them per-1M). Prices drift, so
they are OVERRIDABLE two ways, most-specific wins:
  1. env `NL2SQL_MODEL_PRICES` — a JSON object
     `{"<model>": {"input": <usd_per_1M>, "output": <usd_per_1M>}, ...}`
     merged over the defaults (per-model, so you can override just one model).
  2. an explicit `prices=` mapping passed to `estimate_cost_usd()` (used by
     tests to assert the arithmetic without depending on live list prices).

── Unknown model ─────────────────────────────────────────────────────────────
If a model id is not in the (merged) table, cost is reported as 0.0 and the
model is recorded verbatim in the usage block so the gap is visible in logs —
we never guess a price. The `priced` flag on the result says whether a real
price was found.
"""

from __future__ import annotations

import json
import logging
import os
from dataclasses import dataclass

logger = logging.getLogger("ceiba_nl2sql.generation.pricing")

# USD per 1,000,000 tokens. Keep these current; override via env for a price
# change without a code deploy (see module docstring). Sources: OpenAI's
# published list prices for the chat models this service runs.
DEFAULT_MODEL_PRICES: dict[str, dict[str, float]] = {
    # gpt-4o-mini — the default driving model (settings.openai_model default).
    "gpt-4o-mini": {"input": 0.15, "output": 0.60},
    "gpt-4o": {"input": 2.50, "output": 10.00},
    "gpt-4.1-mini": {"input": 0.40, "output": 1.60},
    "gpt-4.1": {"input": 2.00, "output": 8.00},
    "gpt-4.1-nano": {"input": 0.10, "output": 0.40},
    # gpt-5.x — the models the staging benchmarks actually run
    # (docs/research/BENCHMARK_FINDINGS.md). Without these entries every
    # benchmarked query reported priced=False / cost $0. `cached_input` is the
    # discounted rate OpenAI bills for prompt-prefix cache hits (10% of input
    # across the gpt-5 family); used when the usage reports cached tokens.
    # List prices verified 2026-07 at developers.openai.com/api/docs/pricing.
    "gpt-5.5": {"input": 5.00, "cached_input": 0.50, "output": 30.00},
    "gpt-5.4-mini": {"input": 0.75, "cached_input": 0.075, "output": 4.50},
    "gpt-5.4-nano": {"input": 0.20, "cached_input": 0.02, "output": 1.25},
    "gpt-5.4": {"input": 2.50, "cached_input": 0.25, "output": 15.00},
    "gpt-5.6-luna": {"input": 1.00, "cached_input": 0.10, "output": 6.00},
    "gpt-5.6-terra": {"input": 2.50, "cached_input": 0.25, "output": 15.00},
}

_PER_MILLION = 1_000_000.0

# Env var carrying a JSON price-table override (see module docstring).
MODEL_PRICES_ENV = "NL2SQL_MODEL_PRICES"


@dataclass(frozen=True)
class CostEstimate:
    """The result of pricing a `(model, prompt, completion)` token triple."""

    model: str
    estimated_cost_usd: float
    priced: bool  # True iff a real price for `model` was found in the table


def _env_price_overrides() -> dict[str, dict[str, float]]:
    """Parse the `NL2SQL_MODEL_PRICES` JSON override, if set. Malformed JSON is
    logged and ignored (fail safe to defaults) — a bad env var must never crash
    generation, only forfeit the override.
    """
    raw = os.environ.get(MODEL_PRICES_ENV)
    if not raw:
        return {}
    try:
        parsed = json.loads(raw)
    except (json.JSONDecodeError, ValueError) as exc:
        logger.warning("%s is not valid JSON; ignoring the price override: %s", MODEL_PRICES_ENV, exc)
        return {}
    if not isinstance(parsed, dict):
        logger.warning("%s must be a JSON object; ignoring the price override.", MODEL_PRICES_ENV)
        return {}
    cleaned: dict[str, dict[str, float]] = {}
    for model, entry in parsed.items():
        if not isinstance(entry, dict):
            continue
        try:
            cleaned_entry = {
                "input": float(entry.get("input", 0.0)),
                "output": float(entry.get("output", 0.0)),
            }
            if "cached_input" in entry:
                cleaned_entry["cached_input"] = float(entry["cached_input"])
            cleaned[str(model)] = cleaned_entry
        except (TypeError, ValueError):
            continue
    return cleaned


def resolve_prices(prices: dict[str, dict[str, float]] | None = None) -> dict[str, dict[str, float]]:
    """The effective price table: built-in defaults, overlaid with the env
    override, overlaid with an explicit `prices=` argument (most specific wins).
    """
    effective = dict(DEFAULT_MODEL_PRICES)
    effective.update(_env_price_overrides())
    if prices:
        effective.update(prices)
    return effective


def estimate_cost_usd(
    model: str,
    prompt_tokens: int,
    completion_tokens: int,
    *,
    cached_prompt_tokens: int = 0,
    prices: dict[str, dict[str, float]] | None = None,
) -> CostEstimate:
    """Estimate the USD cost of a set of prompt+completion tokens for `model`.

    cost = (prompt_tokens - cached) / 1e6 * input_price
         + cached / 1e6 * cached_input_price   (falls back to input_price when
                                                the model has no cached rate)
         + completion_tokens / 1e6 * output_price

    `cached_prompt_tokens` is the prompt-prefix cache-hit portion OpenAI
    reports in `usage.prompt_tokens_details.cached_tokens` — a SUBSET of
    `prompt_tokens`, billed at the discounted `cached_input` rate. Clamped
    into [0, prompt_tokens] so a malformed usage can't produce a negative
    cost. Returns a `CostEstimate`; `priced=False` (and cost 0.0) when the
    model is not in the table — we never fabricate a price.
    """
    table = resolve_prices(prices)
    entry = table.get(model)
    if entry is None:
        # OpenAI echoes a DATED model id (e.g. "gpt-4o-mini-2024-07-18") that
        # won't exactly match a bare price key ("gpt-4o-mini"). Fall back to the
        # LONGEST price-table key that `model` starts with, so dated snapshots
        # are priced from their family entry. (Longest-prefix so "gpt-4o-mini-*"
        # matches "gpt-4o-mini" rather than "gpt-4o".)
        prefix_matches = [key for key in table if model.startswith(key)]
        if prefix_matches:
            entry = table[max(prefix_matches, key=len)]
    if entry is None:
        return CostEstimate(model=model, estimated_cost_usd=0.0, priced=False)
    input_price = entry.get("input", 0.0)
    output_price = entry.get("output", 0.0)
    cached_price = entry.get("cached_input", input_price)
    cached = min(max(cached_prompt_tokens, 0), max(prompt_tokens, 0))
    uncached = max(prompt_tokens, 0) - cached
    cost = (
        (uncached / _PER_MILLION) * input_price
        + (cached / _PER_MILLION) * cached_price
        + (completion_tokens / _PER_MILLION) * output_price
    )
    # Round to 6 dp: per-query costs are fractions of a cent; 6 dp keeps
    # sub-cent precision without float-noise digits leaking into logs/JSON.
    return CostEstimate(model=model, estimated_cost_usd=round(cost, 6), priced=True)
