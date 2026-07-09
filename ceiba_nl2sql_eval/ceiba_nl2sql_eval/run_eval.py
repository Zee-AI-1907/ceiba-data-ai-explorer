"""run_eval.py — the eval loop (ports eval/runEval.ts): for each golden
question -> retrieve -> generate -> score, then aggregate into an
`EvalReport` (docs/PYTHON_NL2SQL_SERVICE_PLAN.md §4.1, §5 Phase 5).

── Two execution modes ───────────────────────────────────────────────────────
  (a) SYNTHETIC (default, CI-safe): scores against the hermetic DuckDB
      topology `ceiba_nl2sql_eval.synthetic.build_synthetic_topology` builds
      — no network, no mock/staging DB, no model download.
  (b) GATED read-only-against-staging (opt-in): runs guard-passed,
      cardinality-bounded SQL against the real read-only staging DB
      (`STAGING_DSN`). Gated behind BOTH an explicit opt-in flag
      (`allow_gated_staging=True`) AND the presence of `STAGING_DSN` —
      absent either, falls back to synthetic (never silently attempts
      staging, never raises just because staging isn't configured).

── Golden/adversarial corpora location (plan §4.1 decision) ─────────────────
The `.jsonl` corpora are LEFT IN PLACE at `eval/golden/*.jsonl` and
`eval/adversarial.jsonl` (repo root), NOT moved or duplicated into this
package. Rationale: single source of truth, zero copy-drift risk, and the
TS eval (`eval/**`) still reads the exact same files until its own
retirement in a later phase (Phase 6) once the Python eval has baked. This
mirrors the plan's own "keep in eval/ for now" framing (§4.1: "Keep the
.jsonl golden/adversarial corpora as data, unchanged"). `DEFAULT_GOLDEN_DIR`/
`DEFAULT_ADVERSARIAL_PATH` below resolve there via a relative path from this
package's real on-disk nesting
(`ceiba_nl2sql_eval/ceiba_nl2sql_eval/run_eval.py` -> repo root is
`parents[2]`), verified against the actual directory layout rather than
guessed.
"""

from __future__ import annotations

import json
import os
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Callable, Literal, Sequence

from ceiba_nl2sql.bundle.loader import TEST_FALLBACK_EMBEDDING_MODEL_ID
from ceiba_nl2sql.embed.local_embedder import DeterministicHashEmbedder
from ceiba_nl2sql.engine.base import AttachSpec, QueryEngine
from ceiba_nl2sql.engine.duckdb_engine import DuckDbEngine
from ceiba_nl2sql.generation.llm import LlmClient
from ceiba_nl2sql.generation.pipeline import GenerateOptions, GenerationError, generate_sql
from ceiba_nl2sql.retrieval.retriever import EmbedQuery, HybridRetriever, RetrieveOptions

from ceiba_nl2sql_eval.recorded_llm import RECORDED_DRIVING_MODEL_ID, RecordedLlmClient
from ceiba_nl2sql_eval.score import EvalReport, EvalScore, ScoredItem, build_eval_report, score_candidate
from ceiba_nl2sql_eval.synthetic import SyntheticTopology, build_synthetic_topology

# ── package-root-relative path resolution ────────────────────────────────────
# This file lives at ceiba_nl2sql_eval/ceiba_nl2sql_eval/run_eval.py; the repo
# root (and thus lib/, eval/) is two levels up from this file's parent dir:
#   parents[0] = ceiba_nl2sql_eval/ceiba_nl2sql_eval
#   parents[1] = ceiba_nl2sql_eval
#   parents[2] = repo root
_REPO_ROOT = Path(__file__).resolve().parents[2]

DEFAULT_FIXTURE_BUNDLE_DIR = _REPO_ROOT / "lib" / "rag" / "__tests__" / "fixtures" / "bundles" / "mock-v1"
DEFAULT_GOLDEN_DIR = _REPO_ROOT / "eval" / "golden"
DEFAULT_ADVERSARIAL_PATH = _REPO_ROOT / "eval" / "adversarial.jsonl"


# ── golden / adversarial item shapes ─────────────────────────────────────────


@dataclass(frozen=True)
class GoldenItem:
    id: str
    question: str
    tags: list[str]
    expected_tables: list[str] | None = None
    gold_sql: str | None = None
    target_source: str | None = None
    difficulty: str | None = None


@dataclass(frozen=True)
class AdversarialItem:
    id: str
    question: str
    tags: list[str]
    expect_sql: str | None = None


def _golden_item_from_json(raw: dict) -> GoldenItem:
    """Maps the jsonl's camelCase keys onto GoldenItem's snake_case fields
    explicitly (never a blind `**raw` unpack into a mismatched dataclass).
    """
    return GoldenItem(
        id=raw["id"],
        question=raw["question"],
        tags=list(raw.get("tags", [])),
        expected_tables=list(raw["expectedTables"]) if raw.get("expectedTables") is not None else None,
        gold_sql=raw.get("goldSql"),
        target_source=raw.get("targetSource"),
        difficulty=raw.get("difficulty"),
    )


def _adversarial_item_from_json(raw: dict) -> AdversarialItem:
    return AdversarialItem(
        id=raw["id"],
        question=raw["question"],
        tags=list(raw.get("tags", [])),
        expect_sql=raw.get("expectSql"),
    )


def load_golden_set(golden_dir: Path | None = None) -> list[GoldenItem]:
    """Reads every `*.jsonl` file under `golden_dir` (default
    `eval/golden/`), SORTED by filename, one JSON object per non-blank line.
    Mirrors eval/runEval.ts `loadGoldenSet`.
    """
    resolved_dir = Path(golden_dir) if golden_dir is not None else DEFAULT_GOLDEN_DIR
    golden: list[GoldenItem] = []
    for file_path in sorted(resolved_dir.glob("*.jsonl")):
        raw_text = file_path.read_text(encoding="utf-8")
        for line in raw_text.split("\n"):
            if not line.strip():
                continue
            golden.append(_golden_item_from_json(json.loads(line)))
    return golden


def load_adversarial_set(file_path: Path | None = None) -> list[AdversarialItem]:
    """Reads + parses `eval/adversarial.jsonl` (default). Mirrors
    eval/runEval.ts `loadAdversarialSet`.
    """
    resolved_path = Path(file_path) if file_path is not None else DEFAULT_ADVERSARIAL_PATH
    raw_text = resolved_path.read_text(encoding="utf-8")
    items: list[AdversarialItem] = []
    for line in raw_text.split("\n"):
        if not line.strip():
            continue
        items.append(_adversarial_item_from_json(json.loads(line)))
    return items


def load_bundle_version(bundle_dir: Path) -> str:
    manifest = json.loads((Path(bundle_dir) / "manifest.json").read_text(encoding="utf-8"))
    return manifest["bundleVersion"]


def _load_bundle_table_ids(bundle_dir: Path) -> set[str]:
    catalog = json.loads((Path(bundle_dir) / "catalog.json").read_text(encoding="utf-8"))
    return {t["tableId"] for t in catalog["tables"]}


# ── run options / result shapes ──────────────────────────────────────────────

EvalExecutionMode = Literal["synthetic", "gated-staging"]


@dataclass
class RunEvalOptions:
    bundle_dir: Path | None = None
    mode: EvalExecutionMode = "synthetic"
    llm: LlmClient | None = None
    driving_model: str | None = None
    embed_query: EmbedQuery | None = None
    expected_embedding_model_id: str | None = None
    max_rows: int = 1000
    allow_gated_staging: bool = False


@dataclass(frozen=True)
class RunEvalResult:
    report: EvalReport
    items: list[ScoredItem]
    mode: EvalExecutionMode


def estimate_tokens(text: str) -> int:
    """Rough, dependency-free token estimator (chars/4, ceil). Mirrors
    eval/runEval.ts `estimateTokens`.
    """
    return -(-len(text) // 4)


def _default_embed_query() -> EmbedQuery:
    embedder = DeterministicHashEmbedder()

    def _embed(text: str) -> Sequence[float]:
        return embedder.embed_documents([text])[0]

    return _embed


def resolve_engine(
    options: RunEvalOptions,
) -> tuple[QueryEngine, EvalExecutionMode, SyntheticTopology | None]:
    """Builds the QueryEngine for the requested mode.
      - synthetic: `build_synthetic_topology()` (hermetic DuckDB, alias
        `mock`), reading `catalog.json`/`keys.json`/`synthetic.json` from the
        SAME `options.bundle_dir` the retriever loads.
      - gated-staging: requires BOTH `options.allow_gated_staging is True`
        AND `os.environ["STAGING_DSN"]` truthy; attaches staging READ_ONLY
        via DuckDB. Falls back to synthetic (with a warning) if either
        condition is not met — NEVER raises, NEVER silently attempts staging.
    Mirrors eval/runEval.ts `resolveEngine`.
    """
    requested_mode = options.mode

    if requested_mode == "gated-staging":
        staging_dsn = os.environ.get("STAGING_DSN")
        if not options.allow_gated_staging or not staging_dsn:
            print(
                "run_eval: gated-staging mode requested but not enabled — requires BOTH "
                "allow_gated_staging=True AND STAGING_DSN set. Falling back to synthetic mode "
                "(staging is opt-in only, default off).",
            )
        else:
            engine = DuckDbEngine()
            engine.attach(
                [AttachSpec(source_id="staging", engine="postgres", dsn=staging_dsn, read_only=True, alias="staging")]
            )
            return engine, "gated-staging", None

    bundle_dir = options.bundle_dir if options.bundle_dir is not None else DEFAULT_FIXTURE_BUNDLE_DIR
    synthetic = build_synthetic_topology(bundle_dir)
    return synthetic.engine, "synthetic", synthetic


def build_retriever(options: RunEvalOptions) -> HybridRetriever:
    bundle_dir = options.bundle_dir if options.bundle_dir is not None else DEFAULT_FIXTURE_BUNDLE_DIR
    embed_query = options.embed_query if options.embed_query is not None else _default_embed_query()
    expected_embedding_model_id = (
        options.expected_embedding_model_id
        if options.expected_embedding_model_id is not None
        else TEST_FALLBACK_EMBEDDING_MODEL_ID
    )
    retriever = HybridRetriever(
        embed_query=embed_query,
        dialect="duckdb",
        expected_embedding_model_id=expected_embedding_model_id,
    )
    retriever.load(bundle_dir)
    return retriever


async def run_one_item(
    item: GoldenItem | AdversarialItem,
    *,
    retriever: HybridRetriever,
    engine: QueryEngine,
    llm: LlmClient,
    bundle_known_table_ids: set[str],
    gold_sql: str | None = None,
    max_rows: int,
) -> ScoredItem:
    """retrieve -> generate -> score for a single golden/adversarial
    question. `GenerationError` (self-repair exhausted) is captured as a
    scored item with `guard_passes=False` rather than raised, so one bad
    question never aborts the whole eval run. Mirrors eval/runEval.ts
    `runOneItem`.
    """
    start = time.perf_counter()
    token_estimate = 0

    try:
        response = await generate_sql(
            question=item.question,
            engine=engine,
            retriever=retriever,
            llm=llm,
            options=GenerateOptions(default_limit=max_rows),
        )
        token_estimate = estimate_tokens(response.sql) + estimate_tokens(response.description)

        # generate_sql already ran guard_sql/cardinality_guard/explain
        # internally and only returns SQL that passed all three (or raises).
        # Re-score with score_candidate anyway so the EvalScore/EvalReport is
        # derived uniformly (SAME code path a raw/ungenerated candidate would
        # go through), and so result_match against gold_sql is computed.
        context = retriever.retrieve(item.question, RetrieveOptions(token_budget=4000, max_tables=8))
        score = score_candidate(
            sql=response.sql,
            context=context,
            engine=engine,
            bundle_known_table_ids=bundle_known_table_ids,
            gold_sql=gold_sql,
            max_rows=max_rows,
        )

        return ScoredItem(
            id=item.id,
            question=item.question,
            tags=item.tags,
            sql=response.sql,
            score=score,
            latency_ms=(time.perf_counter() - start) * 1000,
            token_estimate=token_estimate,
            usage=response.usage,
        )
    except GenerationError as err:
        # A GenerationError means self-repair exhausted without producing
        # safe SQL — the intended, correct outcome for an adversarial
        # (injection/write) question: score it as a guard failure using the
        # LAST attempted SQL for observability. `err.usage` is populated even
        # on failure (Phase 3), so a failed generation still contributes its
        # burned cost to the aggregate.
        return ScoredItem(
            id=item.id,
            question=item.question,
            tags=item.tags,
            sql=err.last_error or "",
            score=EvalScore(
                guard_passes=False,
                parses=False,
                references_real_tables=False,
                cardinality_bounded=False,
                executes=False,
                result_match=None,
            ),
            latency_ms=(time.perf_counter() - start) * 1000,
            token_estimate=token_estimate,
            usage=err.usage,
            error=str(err),
        )


async def run_eval(golden: list[GoldenItem], options: RunEvalOptions | None = None) -> RunEvalResult:
    """The eval loop: loads the retriever + resolves the execution engine
    (synthetic by default), runs every golden item through
    retrieve->generate->score, and returns both the aggregate `EvalReport`
    and the full per-item detail. Mirrors eval/runEval.ts `runEval`.
    """
    options = options or RunEvalOptions()
    max_rows = options.max_rows

    retriever = build_retriever(options)
    engine, mode, synthetic = resolve_engine(options)
    llm: LlmClient = options.llm if options.llm is not None else RecordedLlmClient()
    driving_model = options.driving_model if options.driving_model is not None else (
        "custom-injected" if options.llm is not None else RECORDED_DRIVING_MODEL_ID
    )

    bundle_dir = options.bundle_dir if options.bundle_dir is not None else DEFAULT_FIXTURE_BUNDLE_DIR
    bundle_known_table_ids = _load_bundle_table_ids(bundle_dir)

    try:
        items: list[ScoredItem] = []
        # Sequential by necessity: the shared engine/retriever are stateful
        # DuckDB handles — running items concurrently would interleave
        # queries on the same connection.
        for item in golden:
            scored = await run_one_item(
                item,
                retriever=retriever,
                engine=engine,
                llm=llm,
                bundle_known_table_ids=bundle_known_table_ids,
                gold_sql=item.gold_sql,
                max_rows=max_rows,
            )
            items.append(scored)

        bundle_version = load_bundle_version(bundle_dir)
        report = build_eval_report(items, bundle_version=bundle_version, driving_model=driving_model)

        return RunEvalResult(report=report, items=items, mode=mode)
    finally:
        if synthetic:
            synthetic.dispose()
        else:
            engine.dispose()
        retriever.dispose()


async def run_adversarial(items: list[AdversarialItem], options: RunEvalOptions | None = None) -> list[ScoredItem]:
    """Scores every adversarial (prompt-injection/write-attempt) item.
    Forces `mode="synthetic"` and does not compare against a gold_sql — there
    is no "correct" SQL for an injection attempt; the correct outcome is
    rejection. Mirrors eval/runEval.ts `runAdversarial`.
    """
    options = options or RunEvalOptions()
    forced_options = RunEvalOptions(
        bundle_dir=options.bundle_dir,
        mode="synthetic",
        llm=options.llm,
        driving_model=options.driving_model,
        embed_query=options.embed_query,
        expected_embedding_model_id=options.expected_embedding_model_id,
        max_rows=options.max_rows,
        allow_gated_staging=options.allow_gated_staging,
    )

    retriever = build_retriever(forced_options)
    engine, _mode, synthetic = resolve_engine(forced_options)
    llm: LlmClient = options.llm if options.llm is not None else RecordedLlmClient()

    bundle_dir = options.bundle_dir if options.bundle_dir is not None else DEFAULT_FIXTURE_BUNDLE_DIR
    bundle_known_table_ids = _load_bundle_table_ids(bundle_dir)

    try:
        results: list[ScoredItem] = []
        for item in items:
            scored = await run_one_item(
                item,
                retriever=retriever,
                engine=engine,
                llm=llm,
                bundle_known_table_ids=bundle_known_table_ids,
                max_rows=options.max_rows,
            )
            results.append(scored)
        return results
    finally:
        if synthetic:
            synthetic.dispose()
        else:
            engine.dispose()
        retriever.dispose()
