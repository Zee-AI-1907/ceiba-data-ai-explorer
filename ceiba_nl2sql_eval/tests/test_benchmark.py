"""test_benchmark.py — the hermetic A/B benchmark harness itself."""

from __future__ import annotations

import asyncio

from ceiba_nl2sql_eval.benchmark import (
    DEFAULT_VARIANTS,
    PrefixCacheSimulatingLlm,
    run_benchmark,
)


def test_benchmark_runs_both_default_variants_and_measures_gains():
    results = asyncio.run(run_benchmark(DEFAULT_VARIANTS))
    by_name = {r.variant.name: r for r in results}
    baseline = by_name["baseline-hybrid"].aggregate()
    static = by_name["static-context"].aggregate()

    # Same corpus, same recorded completions -> identical accuracy.
    assert baseline["questions"] == static["questions"] > 0
    assert baseline["generatedOk"] == static["generatedOk"]
    assert baseline["resultMatches"] == static["resultMatches"]

    # Static mode: byte-identical prefix earns simulated cache hits; the
    # baseline's per-question prompts earn none (fixture-bundle scale).
    assert static["totalCachedPromptTokens"] > 0
    assert baseline["totalCachedPromptTokens"] == 0
    # Cached tokens are billed at 10% -> static costs less despite slightly
    # larger prompts.
    assert static["totalEstimatedCostUsd"] < baseline["totalEstimatedCostUsd"]
    # Static skips the embedder entirely.
    assert static["meanRetrieveMs"] < baseline["meanRetrieveMs"]


def test_prefix_cache_simulator_mirrors_openai_mechanics():
    class _Echo:
        async def complete(self, prompt: str):
            from ceiba_nl2sql.generation.llm import LlmCompletion, TokenUsage

            return LlmCompletion(
                text="x",
                usage=TokenUsage(prompt_tokens=len(prompt) // 4, completion_tokens=1, total_tokens=len(prompt) // 4 + 1),
                model="m",
            )

    llm = PrefixCacheSimulatingLlm(_Echo())
    shared_prefix = "s" * 4096 * 4  # 4096 tokens of identical prefix

    async def _run():
        first = await llm.complete(shared_prefix + " question one")
        second = await llm.complete(shared_prefix + " question two")
        short = await llm.complete("tiny prompt")  # below the 1024-token minimum
        return first, second, short

    first, second, short = asyncio.run(_run())
    assert first.usage.cached_prompt_tokens == 0  # nothing seen yet
    assert second.usage.cached_prompt_tokens == 4096  # 128-token-aligned prefix hit
    assert short.usage.cached_prompt_tokens == 0
