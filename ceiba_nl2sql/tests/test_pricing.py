"""test_pricing.py — the per-query cost computation (Phase 3 KEY deliverable;
docs/PYTHON_NL2SQL_SERVICE_PLAN.md §7.5). Asserts the arithmetic
`tokens x price = expected USD` deterministically against an explicit price
table (no dependency on live list prices), plus the env-override and
unknown-model paths.
"""

from __future__ import annotations

import pytest

from ceiba_nl2sql.generation.pricing import (
    DEFAULT_MODEL_PRICES,
    MODEL_PRICES_ENV,
    estimate_cost_usd,
    resolve_prices,
)


def test_cost_is_tokens_times_price_per_million():
    # Explicit prices so the assertion is pure arithmetic, not a live rate:
    # $1/1M input, $2/1M output.
    prices = {"test-model": {"input": 1.0, "output": 2.0}}
    # 2,000,000 input tokens -> $2.00; 1,000,000 output tokens -> $2.00.
    result = estimate_cost_usd("test-model", 2_000_000, 1_000_000, prices=prices)
    assert result.priced is True
    assert result.estimated_cost_usd == pytest.approx(4.00)


def test_cost_default_model_gpt_4o_mini_matches_table():
    # gpt-4o-mini default: $0.15/1M input, $0.60/1M output.
    input_price = DEFAULT_MODEL_PRICES["gpt-4o-mini"]["input"]
    output_price = DEFAULT_MODEL_PRICES["gpt-4o-mini"]["output"]
    prompt_tokens, completion_tokens = 500_000, 100_000
    expected = (prompt_tokens / 1_000_000) * input_price + (completion_tokens / 1_000_000) * output_price
    result = estimate_cost_usd("gpt-4o-mini", prompt_tokens, completion_tokens)
    assert result.priced is True
    assert result.estimated_cost_usd == pytest.approx(round(expected, 6))


def test_unknown_model_is_zero_cost_and_not_priced():
    result = estimate_cost_usd("some-unlisted-model", 1000, 1000)
    assert result.priced is False
    assert result.estimated_cost_usd == 0.0
    assert result.model == "some-unlisted-model"


def test_dated_model_id_is_priced_via_longest_prefix():
    # OpenAI echoes a dated snapshot id; it must still price from its family key.
    dated = estimate_cost_usd("gpt-4o-mini-2024-07-18", 1000, 500)
    bare = estimate_cost_usd("gpt-4o-mini", 1000, 500)
    assert dated.priced is True
    assert dated.estimated_cost_usd == bare.estimated_cost_usd > 0.0


def test_longest_prefix_wins_over_shorter_family():
    # "gpt-4o-mini-*" must match "gpt-4o-mini", not the shorter "gpt-4o".
    prices = {"gpt-4o": {"input": 2.5, "output": 10.0}, "gpt-4o-mini": {"input": 0.15, "output": 0.60}}
    r = estimate_cost_usd("gpt-4o-mini-2024-07-18", 1_000_000, 0, prices=prices)
    assert r.estimated_cost_usd == 0.15  # mini price, not the 2.50 gpt-4o price


def test_env_price_override_merges_over_defaults(monkeypatch: pytest.MonkeyPatch):
    monkeypatch.setenv(MODEL_PRICES_ENV, '{"gpt-4o-mini": {"input": 10.0, "output": 20.0}}')
    # gpt-4o-mini overridden...
    overridden = estimate_cost_usd("gpt-4o-mini", 1_000_000, 0)
    assert overridden.estimated_cost_usd == pytest.approx(10.0)
    # ...but other defaults still present (per-model merge, not replace).
    assert "gpt-4o" in resolve_prices()


def test_malformed_env_override_is_ignored(monkeypatch: pytest.MonkeyPatch):
    monkeypatch.setenv(MODEL_PRICES_ENV, "not-json")
    # Falls back to defaults; no crash.
    result = estimate_cost_usd("gpt-4o-mini", 1_000_000, 0)
    assert result.estimated_cost_usd == pytest.approx(DEFAULT_MODEL_PRICES["gpt-4o-mini"]["input"])
