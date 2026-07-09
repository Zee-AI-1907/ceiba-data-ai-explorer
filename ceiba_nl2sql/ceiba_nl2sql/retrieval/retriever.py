"""retriever.py — coarse-to-fine hybrid retriever (ports lib/rag/Retriever.ts's
`HybridRetriever` verbatim; docs/PYTHON_NL2SQL_SERVICE_PLAN.md §1.1, §3.1
`retrieval/retriever.py`).

── Pipeline (mirrors NL2SQL_SPEC.md §4.1 / lib/rag/Retriever.ts) ────────────
  1. Expand + normalize the question with glossary.abbreviations/synonyms.
  2. Domain/schema prune (coarse) — degrades to sourceScope-only, same
     documented deviation as the TS port (catalog carries no populated
     `domain` tags yet for the mock/staging bundles).
  3. Table recall: hybrid dense (VssClient over doc_kind='table') + BM25
     fused by RRF, biased by `importanceScore`. Keep top `recall_tables`.
  4. Column recall: hybrid dense+BM25 over doc_kind='column' SCOPED to the
     stage-3 survivor tables. Keep top `recall_columns`.
  5. Graph-expand: pull FK neighbors of every survivor table from
     joingraph.json into the candidate table set.
  6. LLM-prune (injectable; a deterministic STUB by default so tests never
     require a live model).
  7. Render: emit survivor tables with full column detail + join edges,
     honoring token_budget; attach cardinality_warnings for any
     is_large_time_series survivor, plus glossary_hits/exemplars.

── Query embedding (plan §3.2 — the parity win) ─────────────────────────────
Unlike the TS `HybridRetriever`, which took an injectable `EmbedQuery`
because no in-process embedder existed in Node, this Python retriever's
`embed_query` is (in production) backed by the SAME
`ceiba_nl2sql.embed.local_embedder` code that embedded the bundle's document
vectors — eliminating the cross-language embedder-parity risk by
construction, not just by convention.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from pathlib import Path
from typing import Callable, Sequence

from ceiba_nl2sql.bundle.loader import EXPECTED_EMBEDDING_MODEL_ID, LoadedBundle, load_bundle
from ceiba_nl2sql.retrieval.bm25 import Bm25Document, Bm25Index
from ceiba_nl2sql.retrieval.fusion import RankedItem, fuse_two
from ceiba_nl2sql.retrieval.vss import VssClient

DENSE_VSS_K_MULTIPLIER = 3
DEFAULT_RECALL_TABLES = 20
DEFAULT_RECALL_COLUMNS = 40
DEFAULT_EXEMPLAR_K = 3

# Injectable query-embedding function: text -> a vector (sequence of floats).
EmbedQuery = Callable[[str], Sequence[float]]

# Injectable LLM-prune stage: (question, candidates, max_tables) -> ordered tableIds.
LlmPruneCandidateTable = dict  # {"tableId": str, "grain": str}
LlmPrune = Callable[[str, list[LlmPruneCandidateTable], int], list[str]]


def deterministic_stub_llm_prune() -> LlmPrune:
    """The default STUB used in tests/CI: deterministically keeps candidates
    in their incoming (already-ranked) order, truncated to max_tables.
    Mirrors lib/rag/Retriever.ts `createDeterministicStubLlmPrune`.
    """

    def _prune(_question: str, candidates: list[LlmPruneCandidateTable], max_tables: int) -> list[str]:
        return [c["tableId"] for c in candidates[:max_tables]]

    return _prune


# ── SPEC §4 canonical dataclasses (mirror lib/rag/Retriever.ts types) ───────


@dataclass(frozen=True)
class RenderedColumn:
    name: str
    quoted_name: str
    data_type: str
    unit: str | None
    is_time_column: bool


@dataclass(frozen=True)
class RenderedTable:
    table_id: str
    quoted_ref: str
    grain: str
    columns: list[RenderedColumn]
    approx_row_count: int
    is_large_time_series: bool
    required_time_column: str | None = None


@dataclass(frozen=True)
class JoinHint:
    from_ref: str
    from_columns: list[str]
    to_ref: str
    to_columns: list[str]
    join_cardinality: str
    cross_source: bool


@dataclass(frozen=True)
class CardinalityWarning:
    table_id: str
    approx_row_count: int
    required_time_column: str | None
    message: str


@dataclass(frozen=True)
class GlossaryHit:
    term: str
    resolved_column_id: str | None = None
    time_column_id: str | None = None
    unit: str | None = None


@dataclass(frozen=True)
class Exemplar:
    id: str
    question: str
    sql: str
    dialect: str
    tables: list[str]
    tags: list[str]


@dataclass(frozen=True)
class SchemaContext:
    tables: list[RenderedTable]
    join_hints: list[JoinHint]
    cardinality_warnings: list[CardinalityWarning]
    glossary_hits: list[GlossaryHit]
    exemplars: list[Exemplar]
    token_estimate: int
    dialect: str


@dataclass
class RetrieveOptions:
    token_budget: int
    max_tables: int
    source_scope: list[str] | None = None
    recall_tables: int | None = None
    recall_columns: int | None = None
    exemplar_k: int | None = None


def _estimate_tokens(text: str) -> int:
    """Cheap, deterministic token estimator (chars/4). Mirrors
    lib/rag/Retriever.ts `estimateTokens`.
    """
    return -(-len(text) // 4)  # ceil division


def _render_table_for_estimate(table: RenderedTable) -> str:
    lines = [f"Table {table.quoted_ref} grain={table.grain} rows={table.approx_row_count}"]
    for c in table.columns:
        unit_part = f" unit={c.unit}" if c.unit else ""
        lines.append(f"{c.quoted_name} {c.data_type}{unit_part}")
    return "\n".join(lines)


class HybridRetriever:
    """The SPEC §4 `Retriever` implementation. Coarse-to-fine: glossary-expand
    -> table recall (hybrid dense+BM25 RRF, importance-biased) -> column
    recall (scoped) -> FK graph-expand -> LLM-prune (stub-by-default) ->
    render within token_budget/max_tables. Mirrors lib/rag/Retriever.ts
    `HybridRetriever` line-for-line.
    """

    def __init__(
        self,
        *,
        embed_query: EmbedQuery,
        llm_prune: LlmPrune | None = None,
        dialect: str = "duckdb",
        expected_embedding_model_id: str = EXPECTED_EMBEDDING_MODEL_ID,
    ) -> None:
        self._embed_query = embed_query
        self._llm_prune = llm_prune or deterministic_stub_llm_prune()
        self._dialect = dialect
        self._expected_embedding_model_id = expected_embedding_model_id
        self._bundle: LoadedBundle | None = None
        self._vss: VssClient | None = None
        self._table_bm25: Bm25Index | None = None
        self._column_bm25: Bm25Index | None = None

    def load(self, bundle_dir: str | Path) -> None:
        self._bundle = load_bundle(bundle_dir, expected_embedding_model_id=self._expected_embedding_model_id)

        dimension = self._bundle.manifest["embeddingModel"]["dimension"]
        self._vss = VssClient(self._bundle.vectors_duckdb_path, dimension)

        table_docs: list[Bm25Document] = []
        column_docs: list[Bm25Document] = []
        for table in self._bundle.catalog.get("tables", []):
            column_names = ", ".join(c["name"] for c in table.get("columns", []))
            grain = table.get("grain") or f"table {table['quotedRef']}"
            table_text = f"{table['tableId']} {table['quotedRef']}: {grain}. columns: {column_names}"
            table_docs.append(Bm25Document(doc_id=table["tableId"], text=table_text))

            for column in table.get("columns", []):
                phi = self._bundle.get_column_phi(column["columnId"])
                if phi and phi.get("phiClass") != "non-phi":
                    continue
                unit_part = f"unit={column['unit']}" if column.get("unit") else ""
                column_text = " ".join(
                    filter(None, [column["columnId"], column["name"], column["dataType"], unit_part])
                )
                column_docs.append(Bm25Document(doc_id=column["columnId"], text=column_text))

        self._table_bm25 = Bm25Index(table_docs)
        self._column_bm25 = Bm25Index(column_docs)

    def dispose(self) -> None:
        if self._vss is not None:
            self._vss.dispose()

    def _ensure_loaded(self) -> tuple[LoadedBundle, VssClient, Bm25Index, Bm25Index]:
        if not self._bundle or not self._vss or not self._table_bm25 or not self._column_bm25:
            raise RuntimeError("HybridRetriever: load() must succeed before calling retrieve().")
        return self._bundle, self._vss, self._table_bm25, self._column_bm25

    # ── stage 1: expand + normalize the question ────────────────────────────

    def _expand_question(self, question: str) -> tuple[str, list[GlossaryHit]]:
        bundle, *_ = self._ensure_loaded()
        glossary = bundle.glossary
        abbreviations: dict[str, str] = glossary.get("abbreviations", {})
        synonyms: list[dict] = glossary.get("synonyms", [])

        glossary_hits: list[GlossaryHit] = []
        lower_question = question.lower()
        expanded_terms = [question]

        import re

        for abbr, full in abbreviations.items():
            pattern = re.compile(r"\b" + re.escape(abbr) + r"\b", re.IGNORECASE)
            if pattern.search(question):
                expanded_terms.append(full)

        for synonym in synonyms:
            candidate_terms = [synonym["term"], *synonym.get("aliases", [])]
            matched = any(t.lower() in lower_question for t in candidate_terms)
            if not matched:
                continue
            expanded_terms.append(synonym["term"])
            expanded_terms.extend(synonym.get("aliases", []))
            for m in synonym.get("maps", []):
                glossary_hits.append(self._glossary_hit_from_map(synonym["term"], m))

        return " ".join(expanded_terms), glossary_hits

    @staticmethod
    def _glossary_hit_from_map(term: str, m: dict) -> GlossaryHit:
        kind = m.get("kind")
        if kind == "coded-measurement":
            return GlossaryHit(term=term, resolved_column_id=m.get("valueColumnId"), time_column_id=m.get("timeColumnId"), unit=m.get("unit"))
        if kind == "column":
            return GlossaryHit(term=term, resolved_column_id=m.get("columnId"), time_column_id=m.get("timeColumnId"), unit=m.get("unit"))
        if kind == "temporal-column":
            return GlossaryHit(term=term, time_column_id=m.get("columnId"))
        if kind == "table":
            return GlossaryHit(term=term)
        if kind == "derived":
            return GlossaryHit(term=term, resolved_column_id=m.get("toColumnId"))
        # Exhaustiveness guard mirror: unknown kind -> minimal hit rather than
        # a silent drop (the TS version fails at compile time; here we degrade
        # gracefully but the term is still recorded).
        return GlossaryHit(term=term)

    # ── stage 3: hybrid table recall ────────────────────────────────────────

    def _recall_tables(self, expanded_question: str, source_scope: list[str] | None, recall_tables: int) -> list[str]:
        bundle, vss, table_bm25, _ = self._ensure_loaded()

        query_embedding = self._embed_query(expanded_question)
        dense_hits = vss.search(
            query_embedding,
            doc_kind="table",
            source_ids=source_scope,
            k=recall_tables * DENSE_VSS_K_MULTIPLIER,
        )
        dense_ranked = [RankedItem(id=h.ref_id, score=-h.distance) for h in dense_hits]

        scoped_table_ids: set[str] | None = None
        if source_scope:
            scoped_table_ids = {
                t["tableId"] for t in bundle.catalog.get("tables", []) if t["sourceId"] in source_scope
            }
        bm25_hits = table_bm25.search(expanded_question, recall_tables * DENSE_VSS_K_MULTIPLIER, scoped_table_ids)
        bm25_ranked = [RankedItem(id=h.doc_id, score=h.score) for h in bm25_hits]

        importance_ranked = [
            RankedItem(id=t["tableId"], score=t.get("importanceScore", 0))
            for t in sorted(bundle.catalog.get("tables", []), key=lambda t: t.get("importanceScore", 0), reverse=True)
        ]

        fused = fuse_two(dense_ranked, bm25_ranked, weights={"dense": 1, "bm25": 1})
        fused_with_importance = _fuse_with_importance(fused, importance_ranked)

        return [f.id for f in fused_with_importance[:recall_tables]]

    # ── stage 4: hybrid column recall, scoped to survivor tables ────────────

    def _recall_columns(self, expanded_question: str, survivor_table_ids: list[str], recall_columns: int) -> list[str]:
        bundle, vss, _, column_bm25 = self._ensure_loaded()

        query_embedding = self._embed_query(expanded_question)
        dense_hits = vss.search(
            query_embedding,
            doc_kind="column",
            ref_id_prefixes=[f"{t}." for t in survivor_table_ids],
            k=recall_columns * DENSE_VSS_K_MULTIPLIER,
        )
        dense_ranked = [RankedItem(id=h.ref_id, score=-h.distance) for h in dense_hits]

        survivor_column_ids: set[str] = set()
        for table_id in survivor_table_ids:
            table = bundle.get_table(table_id)
            if table:
                survivor_column_ids.update(c["columnId"] for c in table.get("columns", []))

        bm25_hits = column_bm25.search(expanded_question, recall_columns * DENSE_VSS_K_MULTIPLIER, survivor_column_ids)
        bm25_ranked = [RankedItem(id=h.doc_id, score=h.score) for h in bm25_hits]

        fused = fuse_two(dense_ranked, bm25_ranked)
        return [f.id for f in fused[:recall_columns]]

    # ── stage 5: FK graph-expand ─────────────────────────────────────────────

    def _graph_expand(self, survivor_table_ids: list[str]) -> list[str]:
        bundle, *_ = self._ensure_loaded()
        survivor_set = set(survivor_table_ids)
        for edge in bundle.join_graph.get("edges", []):
            if edge["from"] in survivor_set:
                survivor_set.add(edge["to"])
            if edge["to"] in survivor_set:
                survivor_set.add(edge["from"])
        return list(survivor_set)

    # ── stage 7: render ──────────────────────────────────────────────────────

    def _render_table(self, table: dict, column_id_allowlist: set[str] | None) -> RenderedTable:
        required_time_column = next(
            (c["quotedName"] for c in table.get("columns", []) if c.get("isTimeColumn")), None
        )
        columns = [
            RenderedColumn(
                name=c["name"],
                quoted_name=c["quotedName"],
                data_type=c["dataType"],
                unit=c.get("unit"),
                is_time_column=c.get("isTimeColumn", False),
            )
            for c in table.get("columns", [])
            if not column_id_allowlist or c["columnId"] in column_id_allowlist or c.get("isPrimaryKey")
        ]
        bundle, *_ = self._ensure_loaded()
        profile = bundle.get_table_profile(table["tableId"])
        return RenderedTable(
            table_id=table["tableId"],
            quoted_ref=table["quotedRef"],
            grain=table.get("grain") or f"table {table['quotedRef']}",
            columns=columns,
            approx_row_count=profile.get("approxRowCount", 0) if profile else 0,
            is_large_time_series=table.get("isLargeTimeSeries", False),
            required_time_column=required_time_column,
        )

    @staticmethod
    def _build_cardinality_warning(table: RenderedTable) -> CardinalityWarning:
        rows_desc = f"{table.approx_row_count:,}"
        time_col = table.required_time_column
        time_bound_instruction = (
            f"you MUST include a time-bound predicate on {time_col}"
            if time_col
            else "you MUST include a bounding predicate that limits the scan"
        )
        return CardinalityWarning(
            table_id=table.table_id,
            approx_row_count=table.approx_row_count,
            required_time_column=time_col,
            message=f"{table.quoted_ref} has ~{rows_desc} rows; {time_bound_instruction} and a LIMIT; do not scan unbounded.",
        )

    def _build_join_hints(self, survivor_table_ids: list[str]) -> list[JoinHint]:
        bundle, *_ = self._ensure_loaded()
        survivor_set = set(survivor_table_ids)
        hints: list[JoinHint] = []
        for edge in bundle.join_graph.get("edges", []):
            if edge["from"] in survivor_set and edge["to"] in survivor_set:
                from_table = bundle.get_table(edge["from"])
                to_table = bundle.get_table(edge["to"])
                hints.append(
                    JoinHint(
                        from_ref=from_table["quotedRef"] if from_table else edge["from"],
                        from_columns=edge["fromColumns"],
                        to_ref=to_table["quotedRef"] if to_table else edge["to"],
                        to_columns=edge["toColumns"],
                        join_cardinality=edge["joinCardinality"],
                        cross_source=edge["crossSource"],
                    )
                )
        return hints

    def _recall_exemplars(self, question: str, exemplar_k: int) -> list[Exemplar]:
        bundle, *_ = self._ensure_loaded()
        exemplars = bundle.exemplars.get("exemplars", [])
        if not exemplars:
            return []
        bm25 = Bm25Index([Bm25Document(doc_id=e["id"], text=e["question"]) for e in exemplars])
        hits = bm25.search(question, exemplar_k)
        by_id = {e["id"]: e for e in exemplars}
        picked = [by_id[h.doc_id] for h in hits if h.doc_id in by_id] if hits else exemplars[:exemplar_k]
        return [
            Exemplar(id=e["id"], question=e["question"], sql=e["sql"], dialect=e["dialect"], tables=e["tables"], tags=e["tags"])
            for e in picked
        ]

    # ── the public retrieve() pipeline ──────────────────────────────────────

    def retrieve(self, question: str, opts: RetrieveOptions) -> SchemaContext:
        bundle, *_ = self._ensure_loaded()

        recall_tables_count = opts.recall_tables or DEFAULT_RECALL_TABLES
        recall_columns_count = opts.recall_columns or DEFAULT_RECALL_COLUMNS
        exemplar_k = opts.exemplar_k or DEFAULT_EXEMPLAR_K

        expanded, glossary_hits = self._expand_question(question)

        source_scope = opts.source_scope

        recalled_table_ids = self._recall_tables(expanded, source_scope, recall_tables_count)
        recalled_column_ids = self._recall_columns(expanded, recalled_table_ids, recall_columns_count)
        recalled_column_id_set = set(recalled_column_ids)

        expanded_table_ids = self._graph_expand(recalled_table_ids)

        candidates = [
            {"tableId": tid, "grain": (bundle.get_table(tid) or {}).get("grain") or f"table {tid}"}
            for tid in expanded_table_ids
        ]
        pruned_table_ids = self._llm_prune(question, candidates, opts.max_tables)
        final_table_ids = pruned_table_ids[: opts.max_tables]

        rendered_tables: list[RenderedTable] = []
        running_tokens = 0
        for table_id in final_table_ids:
            table = bundle.get_table(table_id)
            if not table:
                continue
            column_allowlist = recalled_column_id_set if table_id in recalled_table_ids else None
            rendered = self._render_table(table, column_allowlist)
            rendered_tokens = _estimate_tokens(_render_table_for_estimate(rendered))
            if rendered_tables and running_tokens + rendered_tokens > opts.token_budget:
                break
            rendered_tables.append(rendered)
            running_tokens += rendered_tokens

        cardinality_warnings = [self._build_cardinality_warning(t) for t in rendered_tables if t.is_large_time_series]
        join_hints = self._build_join_hints([t.table_id for t in rendered_tables])
        exemplars = self._recall_exemplars(question, exemplar_k)

        return SchemaContext(
            tables=rendered_tables,
            join_hints=join_hints,
            cardinality_warnings=cardinality_warnings,
            glossary_hits=glossary_hits,
            exemplars=exemplars,
            token_estimate=running_tokens,
            dialect=self._dialect,
        )


def _fuse_with_importance(fused, importance_ranked: list[RankedItem]):
    """Folds an importance-ranked list into an already-RRF-fused list as a
    third contribution. Mirrors lib/rag/Retriever.ts `fuseRankingsWithImportance`.
    """
    importance_rank: dict[str, int] = {}
    for index, item in enumerate(importance_ranked):
        importance_rank[item.id] = index + 1
    k = 60

    @dataclass
    class _Fused:
        id: str
        fused_score: float

    result = []
    for item in fused:
        rank = importance_rank.get(item.id)
        importance_contribution = (1 / (k + rank)) if rank else 0.0
        result.append(_Fused(id=item.id, fused_score=item.fused_score + importance_contribution))
    result.sort(key=lambda f: f.fused_score, reverse=True)
    return result
