"""benchmark.py — faithful A/B benchmark of the NL→SQL pipeline improvements.

THE lesson from the staging benchmarking sessions (BENCHMARK_FINDINGS.md,
commit 9139e1e): benchmark the REAL production path — a hand-rolled harness
diverged from the pipeline and reported false failures. This module drives
`generate_sql` itself (the exact function the service calls) over the golden
corpus, per feature-flag VARIANT, and reports per-question + aggregate:

  - accuracy: the eval harness's EvalScore (guard/parse/execute/result_match)
  - latency: end-to-end + retrieve-only per question
  - tokens: prompt/completion/cached per question (from the SAME UsageSummary
    metering production uses)
  - cost: priced by generation/pricing.py at the simulated model's list price

Two modes:
  - HERMETIC (default, CI-safe): RecordedLlmClient + synthetic DuckDB topology
    + the committed fixture bundle. What it measures faithfully: prompt-size
    deltas, retrieval behavior/latency deltas, repair/guard behavior, and —
    via `PrefixCacheSimulatingLlm`, which reproduces OpenAI's prompt-cache
    mechanics (1024-token minimum, 128-token increments, longest-seen-prefix)
    — the cached-input discount a byte-identical prompt prefix earns.
  - LIVE (opt-in): real OpenAI (OPENAI_API_KEY) and optionally gated staging
    (STAGING_DSN + allow flag) — same variants, real model quality.

Variants are FLAG-GATED pipeline features, so baseline-vs-improved runs the
same code with the same corpus — an honest A/B, not a cross-commit guess.
"""

from __future__ import annotations

import argparse
import asyncio
import json
import statistics
import time
from dataclasses import dataclass, field
from pathlib import Path

from ceiba_nl2sql.engine.base import QueryEngine
from ceiba_nl2sql.generation.llm import LlmClient, LlmCompletion
from ceiba_nl2sql.generation.pipeline import GenerateOptions, GenerationError, generate_sql
from ceiba_nl2sql.generation.pricing import estimate_cost_usd
from ceiba_nl2sql.retrieval.retriever import HybridRetriever, RetrieveOptions

from ceiba_nl2sql_eval.recorded_llm import RecordedLlmClient
from ceiba_nl2sql_eval.run_eval import (
    DEFAULT_FIXTURE_BUNDLE_DIR,
    GoldenItem,
    _default_embed_query,
    _load_bundle_table_ids,
    load_golden_set,
)
from ceiba_nl2sql_eval.score import score_candidate
from ceiba_nl2sql_eval.synthetic import build_synthetic_topology

# OpenAI prompt-cache mechanics (developers.openai.com/api/docs — prompt
# caching): activates from 1024 tokens, grows in 128-token increments,
# matches on the longest previously-seen prefix.
PROMPT_CACHE_MIN_TOKENS = 1024
PROMPT_CACHE_INCREMENT_TOKENS = 128


def _tokens(text: str) -> int:
    return -(-len(text) // 4)


class PrefixCacheSimulatingLlm:
    """Wraps an LlmClient and reports `cached_prompt_tokens` exactly the way
    OpenAI's prompt cache would bill them, so hermetic runs measure the
    cached-input discount a stable prompt prefix earns. Simulation only —
    mechanics mirrored, no network.
    """

    def __init__(self, inner: LlmClient) -> None:
        self._inner = inner
        self._seen_prompts: list[str] = []

    def _cached_tokens_for(self, prompt: str) -> int:
        best_prefix_chars = 0
        for seen in self._seen_prompts:
            limit = min(len(seen), len(prompt))
            i = 0
            while i < limit and seen[i] == prompt[i]:
                i += 1
            best_prefix_chars = max(best_prefix_chars, i)
        prefix_tokens = best_prefix_chars // 4
        if prefix_tokens < PROMPT_CACHE_MIN_TOKENS:
            return 0
        return (prefix_tokens // PROMPT_CACHE_INCREMENT_TOKENS) * PROMPT_CACHE_INCREMENT_TOKENS

    async def complete(self, prompt: str) -> LlmCompletion:
        completion = await self._inner.complete(prompt)
        cached = self._cached_tokens_for(prompt)
        self._seen_prompts.append(prompt)
        usage = completion.usage
        return LlmCompletion(
            text=completion.text,
            usage=type(usage)(
                prompt_tokens=usage.prompt_tokens,
                completion_tokens=usage.completion_tokens,
                total_tokens=usage.total_tokens,
                cached_prompt_tokens=min(cached, usage.prompt_tokens),
            ),
            model=completion.model,
        )


@dataclass(frozen=True)
class BenchmarkVariant:
    """One flag configuration of the SAME pipeline."""

    name: str
    static_context_max_tokens: int | None = None
    simulate_prompt_cache: bool = True
    # priced-as model for the synthetic token counts (hermetic mode).
    price_model: str = "gpt-5.4-mini"


@dataclass
class QuestionMetrics:
    id: str
    question: str
    ok: bool
    guard_passes: bool = False
    executes: bool = False
    result_match: bool | None = None
    latency_ms: float = 0.0
    retrieve_ms: float = 0.0
    prompt_tokens: int = 0
    completion_tokens: int = 0
    cached_prompt_tokens: int = 0
    llm_calls: int = 0
    estimated_cost_usd: float = 0.0
    error: str | None = None

    def to_json(self) -> dict:
        return {
            "id": self.id,
            "ok": self.ok,
            "guardPasses": self.guard_passes,
            "executes": self.executes,
            "resultMatch": self.result_match,
            "latencyMs": round(self.latency_ms, 2),
            "retrieveMs": round(self.retrieve_ms, 2),
            "promptTokens": self.prompt_tokens,
            "completionTokens": self.completion_tokens,
            "cachedPromptTokens": self.cached_prompt_tokens,
            "llmCalls": self.llm_calls,
            "estimatedCostUsd": self.estimated_cost_usd,
            "error": self.error,
        }


@dataclass
class VariantResult:
    variant: BenchmarkVariant
    items: list[QuestionMetrics] = field(default_factory=list)

    def aggregate(self) -> dict:
        succeeded = [i for i in self.items if i.ok]
        matched = [i for i in self.items if i.result_match]
        prompt_tokens = [i.prompt_tokens for i in self.items]
        cached = sum(i.cached_prompt_tokens for i in self.items)
        total_prompt = sum(prompt_tokens)
        return {
            "variant": self.variant.name,
            "questions": len(self.items),
            "generatedOk": len(succeeded),
            "resultMatches": len(matched),
            "meanPromptTokens": round(statistics.mean(prompt_tokens), 1) if prompt_tokens else 0,
            "totalPromptTokens": total_prompt,
            "totalCachedPromptTokens": cached,
            "cachedFraction": round(cached / total_prompt, 3) if total_prompt else 0.0,
            "totalCompletionTokens": sum(i.completion_tokens for i in self.items),
            "totalLlmCalls": sum(i.llm_calls for i in self.items),
            "totalEstimatedCostUsd": round(sum(i.estimated_cost_usd for i in self.items), 6),
            "meanLatencyMs": round(statistics.mean([i.latency_ms for i in self.items]), 2) if self.items else 0,
            "meanRetrieveMs": round(statistics.mean([i.retrieve_ms for i in self.items]), 2) if self.items else 0,
        }


def _build_hermetic_stack(variant: BenchmarkVariant, bundle_dir: Path):
    retriever = HybridRetriever(
        embed_query=_default_embed_query(),
        dialect="duckdb",
        expected_embedding_model_id="test-deterministic-hash-v1",
        static_context_max_tokens=variant.static_context_max_tokens,
    )
    retriever.load(bundle_dir)
    synthetic = build_synthetic_topology(bundle_dir)
    inner = RecordedLlmClient(model=variant.price_model)
    llm: LlmClient = PrefixCacheSimulatingLlm(inner) if variant.simulate_prompt_cache else inner
    return retriever, synthetic.engine, llm


async def _run_question(
    item: GoldenItem,
    *,
    retriever: HybridRetriever,
    engine: QueryEngine,
    llm: LlmClient,
    bundle_known_table_ids: set[str],
    variant: BenchmarkVariant,
) -> QuestionMetrics:
    metrics = QuestionMetrics(id=item.id, question=item.question, ok=False)

    retrieve_start = time.perf_counter()
    retriever.retrieve(item.question, RetrieveOptions(token_budget=2500, max_tables=6))
    metrics.retrieve_ms = (time.perf_counter() - retrieve_start) * 1000

    start = time.perf_counter()
    try:
        response = await generate_sql(
            question=item.question,
            engine=engine,
            retriever=retriever,
            llm=llm,
            options=GenerateOptions(default_limit=1000),
        )
    except GenerationError as err:
        metrics.latency_ms = (time.perf_counter() - start) * 1000
        metrics.error = str(err)
        if err.usage:
            metrics.prompt_tokens = err.usage.prompt_tokens
            metrics.completion_tokens = err.usage.completion_tokens
            metrics.cached_prompt_tokens = err.usage.cached_prompt_tokens
            metrics.llm_calls = err.usage.llm_calls
        return metrics
    except Exception as err:  # noqa: BLE001 - one bad question never aborts the run
        metrics.latency_ms = (time.perf_counter() - start) * 1000
        metrics.error = f"{type(err).__name__}: {err}"
        return metrics

    metrics.latency_ms = (time.perf_counter() - start) * 1000
    metrics.ok = bool(response.sql)
    usage = response.usage
    if usage:
        metrics.prompt_tokens = usage.prompt_tokens
        metrics.completion_tokens = usage.completion_tokens
        metrics.cached_prompt_tokens = usage.cached_prompt_tokens
        metrics.llm_calls = usage.llm_calls
        # Re-price at the variant's price model with the cached discount, so
        # variants are compared at the same realistic list price.
        metrics.estimated_cost_usd = estimate_cost_usd(
            variant.price_model,
            usage.prompt_tokens,
            usage.completion_tokens,
            cached_prompt_tokens=usage.cached_prompt_tokens,
        ).estimated_cost_usd

    context = retriever.retrieve(item.question, RetrieveOptions(token_budget=4000, max_tables=8))
    score = score_candidate(
        sql=response.sql,
        context=context,
        engine=engine,
        bundle_known_table_ids=bundle_known_table_ids,
        gold_sql=item.gold_sql,
        max_rows=1000,
    )
    metrics.guard_passes = score.guard_passes
    metrics.executes = score.executes
    metrics.result_match = score.result_match
    return metrics


async def run_benchmark(
    variants: list[BenchmarkVariant],
    *,
    bundle_dir: Path | None = None,
    golden_dir: Path | None = None,
) -> list[VariantResult]:
    """Hermetic benchmark: every variant over the same golden corpus, same
    bundle, same recorded completions. Each variant gets a FRESH stack (its
    own prefix-cache state), so cache effects never leak across variants.
    """
    resolved_bundle = Path(bundle_dir) if bundle_dir else DEFAULT_FIXTURE_BUNDLE_DIR
    golden = load_golden_set(golden_dir)
    known_table_ids = _load_bundle_table_ids(resolved_bundle)

    results: list[VariantResult] = []
    for variant in variants:
        retriever, engine, llm = _build_hermetic_stack(variant, resolved_bundle)
        result = VariantResult(variant=variant)
        try:
            for item in golden:
                result.items.append(
                    await _run_question(
                        item,
                        retriever=retriever,
                        engine=engine,
                        llm=llm,
                        bundle_known_table_ids=known_table_ids,
                        variant=variant,
                    )
                )
        finally:
            retriever.dispose()
            engine.dispose()
        results.append(result)
    return results


DEFAULT_VARIANTS = [
    # Baseline: hybrid retrieval, per-question prompts (cache mostly misses).
    BenchmarkVariant(name="baseline-hybrid", static_context_max_tokens=None),
    # R2: static context — identical prompt prefix across questions.
    BenchmarkVariant(name="static-context", static_context_max_tokens=100_000),
]


def render_markdown(results: list[VariantResult]) -> str:
    lines = [
        "# NL→SQL pipeline benchmark",
        "",
        "Hermetic run: real `generate_sql`, recorded completions, synthetic DuckDB",
        "topology, OpenAI prompt-cache mechanics simulated (1024-token min /",
        "128-token increments / longest-seen-prefix). Costs are list-price",
        "simulations at the variant's price model — not real spend.",
        "",
        "| variant | questions | ok | result match | mean prompt tok | cached tok (frac) | completion tok | llm calls | est. cost | mean retrieve ms |",
        "|---|---|---|---|---|---|---|---|---|---|",
    ]
    for result in results:
        agg = result.aggregate()
        lines.append(
            f"| {agg['variant']} | {agg['questions']} | {agg['generatedOk']} | {agg['resultMatches']} "
            f"| {agg['meanPromptTokens']} | {agg['totalCachedPromptTokens']} ({agg['cachedFraction']}) "
            f"| {agg['totalCompletionTokens']} | {agg['totalLlmCalls']} | ${agg['totalEstimatedCostUsd']} "
            f"| {agg['meanRetrieveMs']} |"
        )
    lines.append("")
    return "\n".join(lines)


def main() -> int:
    parser = argparse.ArgumentParser(description="Faithful NL→SQL pipeline A/B benchmark (hermetic).")
    parser.add_argument("--out", default=None, help="output dir (default artifacts/benchmarks/<epoch>)")
    parser.add_argument("--bundle", default=None)
    args = parser.parse_args()

    results = asyncio.run(run_benchmark(DEFAULT_VARIANTS, bundle_dir=Path(args.bundle) if args.bundle else None))

    repo_root = Path(__file__).resolve().parents[2]
    out_dir = Path(args.out) if args.out else repo_root / "artifacts" / "benchmarks" / str(int(time.time()))
    out_dir.mkdir(parents=True, exist_ok=True)

    payload = {
        "aggregates": [r.aggregate() for r in results],
        "items": {r.variant.name: [i.to_json() for i in r.items] for r in results},
    }
    (out_dir / "benchmark.json").write_text(json.dumps(payload, indent=2) + "\n", encoding="utf-8")
    markdown = render_markdown(results)
    (out_dir / "benchmark.md").write_text(markdown, encoding="utf-8")
    print(markdown)
    print(f"written: {out_dir}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
