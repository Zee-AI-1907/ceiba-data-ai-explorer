"""deps.py — memoized bundle + engine + retriever + llm (mirrors the TS
route's `getGenerationDeps`/`getQueryEngine` memoization pattern;
docs/PYTHON_NL2SQL_SERVICE_PLAN.md §2.1 "process-lifetime memoized engine +
loaded bundle", §3.1 `deps.py`).

The service is stateless PER REQUEST except for this process-lifetime state:
one loaded bundle, one attached DuckDbEngine, one HybridRetriever built from
that bundle, and (lazily) one OpenAI LlmClient. `AppState` is constructed
once at startup (`create_app_state`) and stashed on `app.state`; every route
reads it from there via a FastAPI dependency.

`__setGenerationDepsForTest`-style seam: `AppState` fields are plain mutable
attributes, so a test can construct one directly (bypassing
`create_app_state`'s real bundle/engine bring-up) and hand it to the app via
`app.state.nl2sql = test_state` — no separate override function needed
because Python has no compile-time-private module state to route around.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass

from ceiba_nl2sql.engine.base import AttachSpec, QueryEngine
from ceiba_nl2sql.engine.duckdb_engine import DuckDbEngine
from ceiba_nl2sql.generation.llm import LlmClient, LlmUpstreamError, build_llm_client
from ceiba_nl2sql.retrieval.retriever import EmbedQuery, HybridRetriever

from ceiba_nl2sql_service.settings import Settings

logger = logging.getLogger("ceiba_nl2sql_service.deps")


@dataclass
class AppState:
    """The process-lifetime state every route reads. `llm` is constructed
    lazily (only when a real OpenAI call is actually attempted) so the
    service can boot and serve /healthz, /readyz, /nl2sql/explain, and even
    /nl2sql/generate-with-a-stub-injected without ever requiring
    OPENAI_API_KEY to be set (this phase is dark; nothing depends on a real
    key existing).
    """

    settings: Settings
    engine: QueryEngine
    retriever: HybridRetriever
    bundle_version: str
    embedding_model_id: str
    _llm: LlmClient | None = None
    _llm_simple: LlmClient | None = None
    _llm_repair: LlmClient | None = None
    # R5: optional semantic paraphrase cache (None = disabled).
    semantic_cache: object | None = None

    def llm_client(self) -> LlmClient:
        if self._llm is None:
            self._llm = build_llm_client(api_key=self.settings.openai_api_key, model=self.settings.openai_model)
        return self._llm

    def llm_client_simple(self) -> LlmClient | None:
        """R1 routing: the cheap tier for join-free questions. None when
        NL2SQL_LLM_MODEL_SIMPLE is unset (no routing).
        """
        if not self.settings.openai_model_simple:
            return None
        if self._llm_simple is None:
            self._llm_simple = build_llm_client(
                api_key=self.settings.openai_api_key, model=self.settings.openai_model_simple
            )
        return self._llm_simple

    def llm_client_repair(self) -> LlmClient | None:
        """R1 escalation: the repair-round tier. None when
        NL2SQL_LLM_MODEL_REPAIR is unset (repairs use the main model).
        """
        if not self.settings.openai_model_repair:
            return None
        if self._llm_repair is None:
            self._llm_repair = build_llm_client(
                api_key=self.settings.openai_api_key, model=self.settings.openai_model_repair
            )
        return self._llm_repair

    def dispose(self) -> None:
        self.engine.dispose()
        self.retriever.dispose()


def _build_embed_query(settings: Settings, expected_model_id: str) -> EmbedQuery:
    """Builds the query embedder used by the retriever. When the bundle's
    embedding model id is the TEST-ONLY fallback id, uses the SAME
    `DeterministicHashEmbedder` the bundle was built with (hermetic, no
    model download) — this is what the fixture bundle
    (lib/rag/__tests__/fixtures/bundles/mock-v1) requires. Otherwise
    constructs the real `FastEmbedEmbedder` (bge-small-en-v1.5), the SAME
    code path that embedded the bundle's document vectors — this eliminates
    the JS-embedder parity risk by construction (plan §3.2), since there is
    no second reproduction of the embedding recipe anywhere in this service.
    """
    from ceiba_nl2sql.embed.local_embedder import DeterministicHashEmbedder, FastEmbedEmbedder

    if expected_model_id == DeterministicHashEmbedder.MODEL_ID:
        embedder = DeterministicHashEmbedder()
    else:
        embedder = FastEmbedEmbedder()

    def _embed(text: str):
        return embedder.embed_documents([text])[0]

    return _embed


def create_app_state(settings: Settings) -> AppState:
    """Builds the real, production `AppState`: loads the configured bundle,
    attaches the configured DSNs to a DuckDbEngine, and builds a
    HybridRetriever over the bundle. Raises if `NL2SQL_BUNDLE_DIR` is unset —
    the caller (readyz / lifespan) decides whether that is fatal.
    """
    if not settings.nl2sql_bundle_dir:
        raise RuntimeError("NL2SQL_BUNDLE_DIR is not configured; cannot load the artifact bundle.")

    expected_model_id = settings.nl2sql_embedding_model_id
    embed_query_holder: dict[str, EmbedQuery] = {}

    # The retriever's expected embedding model id must match the bundle's
    # manifest, or load() raises EmbeddingModelMismatchError (fail closed —
    # never silently retrieve against a mismatched vector space).
    from ceiba_nl2sql.bundle.loader import EXPECTED_EMBEDDING_MODEL_ID

    resolved_expected_model_id = expected_model_id or EXPECTED_EMBEDDING_MODEL_ID
    embed_query = _build_embed_query(settings, resolved_expected_model_id)

    retriever = HybridRetriever(
        embed_query=embed_query,
        dialect="duckdb" if settings.nl2sql_engine == "duckdb" else settings.nl2sql_engine,
        expected_embedding_model_id=resolved_expected_model_id,
        # R2: opt-in static-context mode (NL2SQL_STATIC_CONTEXT_MAX_TOKENS).
        static_context_max_tokens=settings.nl2sql_static_context_max_tokens,
    )
    retriever.load(settings.nl2sql_bundle_dir)

    engine = DuckDbEngine()
    attach_specs: list[AttachSpec] = []
    if settings.mock_dsn:
        attach_specs.append(AttachSpec(source_id="mock", engine="postgres", dsn=settings.mock_dsn, read_only=True, alias="mock"))
    if settings.staging_dsn:
        attach_specs.append(
            AttachSpec(source_id="staging", engine="postgres", dsn=settings.staging_dsn, read_only=True, alias="staging")
        )
    if attach_specs:
        engine.attach(attach_specs)

    bundle_version = retriever._bundle.manifest.get("bundleVersion", "unknown") if retriever._bundle else "unknown"  # noqa: SLF001

    # R5: optional semantic paraphrase cache, sharing the retriever's embedder
    # so the similarity space matches retrieval's.
    semantic_cache = None
    if settings.nl2sql_semantic_cache:
        from ceiba_nl2sql.generation.semantic_cache import SemanticSqlCache

        semantic_cache = SemanticSqlCache(
            embed_query, threshold=settings.nl2sql_semantic_cache_threshold
        )

    return AppState(
        settings=settings,
        engine=engine,
        retriever=retriever,
        bundle_version=bundle_version,
        embedding_model_id=resolved_expected_model_id,
        semantic_cache=semantic_cache,
    )
