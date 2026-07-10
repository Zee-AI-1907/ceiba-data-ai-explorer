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


def test_gpt5_benchmark_models_are_priced():
    """Regression: the staging benchmarks run gpt-5.4-mini / gpt-5.4-nano
    (docs/research/BENCHMARK_FINDINGS.md), which had NO price entry — every
    benchmarked query reported priced=False / cost $0. Dated snapshots must
    price via the longest-prefix family fallback too.
    """
    for model in ("gpt-5.4-mini", "gpt-5.4-nano", "gpt-5.4", "gpt-5.5", "gpt-5.4-mini-2026-05-01"):
        result = estimate_cost_usd(model, 1_000_000, 100_000)
        assert result.priced is True, model
        assert result.estimated_cost_usd > 0.0, model
    # Longest prefix: a dated gpt-5.4-mini snapshot uses the mini price,
    # not the more expensive bare gpt-5.4 family price.
    dated_mini = estimate_cost_usd("gpt-5.4-mini-2026-05-01", 1_000_000, 0)
    assert dated_mini.estimated_cost_usd == pytest.approx(DEFAULT_MODEL_PRICES["gpt-5.4-mini"]["input"])


def test_cached_prompt_tokens_billed_at_cached_rate():
    prices = {"cache-model": {"input": 1.0, "cached_input": 0.1, "output": 2.0}}
    # 1M prompt tokens, 400k of them cache hits: 600k @ $1 + 400k @ $0.1 = $0.64.
    result = estimate_cost_usd("cache-model", 1_000_000, 0, cached_prompt_tokens=400_000, prices=prices)
    assert result.estimated_cost_usd == pytest.approx(0.64)


def test_cached_tokens_fall_back_to_input_price_when_no_cached_rate():
    prices = {"no-cache-rate": {"input": 1.0, "output": 2.0}}
    with_cache = estimate_cost_usd("no-cache-rate", 1_000_000, 0, cached_prompt_tokens=400_000, prices=prices)
    without_cache = estimate_cost_usd("no-cache-rate", 1_000_000, 0, prices=prices)
    assert with_cache.estimated_cost_usd == without_cache.estimated_cost_usd


def test_cached_tokens_clamped_to_prompt_tokens():
    prices = {"cache-model": {"input": 1.0, "cached_input": 0.1, "output": 2.0}}
    # A malformed usage reporting MORE cached than prompt tokens must clamp,
    # never produce a negative uncached count / negative cost.
    result = estimate_cost_usd("cache-model", 100_000, 0, cached_prompt_tokens=1_000_000, prices=prices)
    assert result.estimated_cost_usd == pytest.approx(0.01)  # all 100k at cached rate


def test_env_override_preserves_cached_input_rate(monkeypatch: pytest.MonkeyPatch):
    monkeypatch.setenv(
        MODEL_PRICES_ENV, '{"gpt-5.4-mini": {"input": 1.0, "cached_input": 0.5, "output": 2.0}}'
    )
    result = estimate_cost_usd("gpt-5.4-mini", 1_000_000, 0, cached_prompt_tokens=1_000_000)
    assert result.estimated_cost_usd == pytest.approx(0.5)


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


def test_gpt56_models_priced():
    # gpt-5.6-luna and gpt-5.6-terra must be priced.
    for model in ("gpt-5.6-luna", "gpt-5.6-terra"):
        r = estimate_cost_usd(model, 1_000_000, 0)
        assert r.priced is True, model
    # gpt-5.6-luna: 1M prompt @ $1.00 + 1M completion @ $6.00 = $7.00
    luna = estimate_cost_usd("gpt-5.6-luna", 1_000_000, 1_000_000)
    assert abs(luna.estimated_cost_usd - (1.00 + 6.00)) < 1e-6
    # gpt-5.6-terra: 1M prompt @ $2.50 + 1M completion @ $15.00 = $17.50
    terra = estimate_cost_usd("gpt-5.6-terra", 1_000_000, 1_000_000)
    assert abs(terra.estimated_cost_usd - (2.50 + 15.00)) < 1e-6
