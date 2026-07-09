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

from collections import deque
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

# ── Fix A (JOINGRAPH_SURFACING.md §2, §6, §8.2) ─────────────────────────────
MAX_BRIDGE_HOPS = 3
MAX_BRIDGE_PATHS = 6

# ── Fix D (SEMANTIC_HINTS.md §4.2/§8.3, §5.3) ───────────────────────────────
HINT_PIN_THRESHOLD = 0.62
MAX_SEMANTIC_HINTS = 6

_CARDINALITY_TAG = {
    "many-to-one": "N:1",
    "one-to-many": "1:N",
    "one-to-one": "1:1",
    "many-to-many": "N:N",
}

# SEMANTIC_HINTS.md §7 stop-token deny-list: bare short abbreviations that are
# common English words. A bare-form match only fires when the FULL multi-word
# alias also matched (see _expand_question's autoSynonyms scan).
_AMBIGUOUS_BARE_TERM_DENYLIST = frozenset({"map", "temp", "pa", "sap"})

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
    # Fix C: whether this column is indexed/PK/FK — feeds the cardinality
    # guard's selective-equality-or-IN-predicate check (ceiba_nl2sql.guard.cardinality).
    is_indexed: bool = False
    is_foreign_key_or_primary_key: bool = False


@dataclass(frozen=True)
class TimeVia:
    """Cardinality-guard remediation: how a large table with NO own time
    column can still be bounded — via a directly-joined PARENT table's time
    column (e.g. MonitorMeasurements has none; Monitors.MeasuredDate, reached
    via MonitorMeasurements.DeviceId -> Monitors.Id, is the bound). Populated
    from catalog.json's `timeVia` hint (prep/prep/enrich/importance.py
    `apply_time_via_hints`) when present; the guard also derives this
    relationship independently from the SQL + join graph as a fallback, so a
    bundle built before this hint existed is not silently unprotected.
    """

    table_id: str
    column: str
    from_columns: list[str]
    to_columns: list[str]


@dataclass(frozen=True)
class RenderedTable:
    table_id: str
    quoted_ref: str
    grain: str
    columns: list[RenderedColumn]
    approx_row_count: int
    is_large_time_series: bool
    required_time_column: str | None = None
    # Fix A (JOINGRAPH_SURFACING.md §8.3): "primary" survivors render with
    # their full (possibly recall-scoped) column list; "bridge" tables render
    # as PK/FK-only stubs — they exist to be joined THROUGH, not selected FROM.
    role: str = "primary"
    # Cardinality-guard remediation: set when this table has no own time
    # column but a declared FK reaches a parent table that does (see TimeVia).
    time_via: TimeVia | None = None


@dataclass(frozen=True)
class JoinHint:
    from_ref: str
    from_columns: list[str]
    to_ref: str
    to_columns: list[str]
    join_cardinality: str
    cross_source: bool


@dataclass(frozen=True)
class JoinPath:
    """A BFS-shortest bridge path connecting two survivor tables through one
    or more intermediate (bridge) tables. Mirrors JOINGRAPH_SURFACING.md
    §8.3's `JoinPath{ nodes, edges, ... }`.
    """

    nodes: list[str]  # tableIds, from_ref -> ... -> to_ref, in traversal order
    edges: list[JoinHint]  # one JoinHint per hop, same order as nodes
    hop_count: int


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
    # Fix D (SEMANTIC_HINTS.md §3.2/§8.2/§8.3): the fact table the coded value
    # lives on (the retrieval-pin anchor) + how confident this hit is.
    hosting_table_id: str | None = None
    confidence: float = 1.0
    # The literal coded value this hit resolves to (e.g. 2, or "Heart Rate")
    # plus a human label for the `-- code N = 'NAME'` prompt provenance comment.
    code_value: object | None = None
    code_label: str | None = None
    # The FK/discriminator column the code_value filters on (e.g.
    # MonitorMeasurements.MeasurementTypeId) — needed to render the literal
    # filter predicate without guessing a column name.
    code_column_id: str | None = None


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
    # Fix A: Tier-2 bridge paths (JOINGRAPH_SURFACING.md §8.3), restricted to
    # bridges that made it into the final rendered `tables` set.
    join_paths: list[JoinPath] = field(default_factory=list)


@dataclass
class RetrieveOptions:
    token_budget: int
    max_tables: int
    source_scope: list[str] | None = None
    recall_tables: int | None = None
    recall_columns: int | None = None
    exemplar_k: int | None = None


# Column-name substrings suggesting a genuine coded discriminator (mirrors
# prep/prep/enrich/importance.py `_CODE_COLUMN_NAME_HINTS`) — preferred over
# a plain entity-identifying FK column (e.g. DeviceId, PatientId) when
# picking the example column for a cardinality-warning message: "filter on
# MeasurementTypeId" is a more genuinely useful example of a selective filter
# than "filter on DeviceId" (which narrows to one device, not one measurement
# kind — a materially different, and usually not what's wanted, query shape).
_DISCRIMINATOR_COLUMN_NAME_HINTS = ("type", "status", "code", "category", "kind")


def _best_selective_column_for_warning(table: RenderedTable) -> str | None:
    """Picks the example column named in a cardinality-warning message's
    equality/IN escape-hatch mention. Prefers a coded-discriminator-shaped
    FK/indexed column (see `_DISCRIMINATOR_COLUMN_NAME_HINTS`) over a plain
    entity-identifying one, falling back to the first FK/indexed column found
    when none matches (unchanged prior behavior for a table with only
    entity-identifying FK columns, e.g. PatientId-only).
    """
    selective_columns = [c for c in table.columns if c.is_indexed or c.is_foreign_key_or_primary_key]
    discriminator = next(
        (c.name for c in selective_columns if any(hint in c.name.lower() for hint in _DISCRIMINATOR_COLUMN_NAME_HINTS)),
        None,
    )
    if discriminator:
        return discriminator
    return selective_columns[0].name if selective_columns else None


def build_cardinality_warning_message(table: RenderedTable) -> str:
    """The verbatim warning text for a large/time-series table, surfaced in
    the generation prompt's CARDINALITY WARNINGS section. Mirrors
    lib/rag/promptAssembly.ts `buildCardinalityWarningMessage`, plus the
    cardinality-guard remediation below (canonical home: both
    `HybridRetriever._build_cardinality_warning` and
    `ceiba_nl2sql.generation.prompt.derive_cardinality_warnings` delegate here
    so the message logic exists in exactly one place).

    Cardinality-guard remediation: a table with NO own time column (e.g.
    MonitorMeasurements — 344M rows, time dimension lives on the joined
    parent Monitors.MeasuredDate) previously got only the vague "a bounding
    predicate that limits the scan" instruction, giving the model NO
    actionable guidance on how to bound it — exactly the ambiguity that let
    the model emit an unbounded (or wrongly-joined) query. When `time_via` is
    set, the message now names the exact parent table/column/join to bound
    through. When the table also has an FK/indexed column (surfaced via its
    own rendered columns), the message additionally names the equality/IN
    escape hatch (e.g. filtering `MeasurementTypeId`) as an alternative to a
    time bound — matching what the cardinality guard actually accepts.
    """
    rows_desc = f"{table.approx_row_count:,}"
    time_col = table.required_time_column
    selective_column = _best_selective_column_for_warning(table)

    if time_col:
        time_bound_instruction = f"you MUST include a time-bound predicate on {time_col}"
    elif table.time_via:
        join_desc = ", ".join(f"{f}={t}" for f, t in zip(table.time_via.from_columns, table.time_via.to_columns))
        parent_bare_name = table.time_via.table_id.split(".")[-1]
        if selective_column:
            time_bound_instruction = (
                f"this table has no own time column, so you MUST either join to {parent_bare_name} "
                f"(via {join_desc}) and bound on its {table.time_via.column} column, or filter on a "
                f"selective column such as {selective_column}"
            )
        else:
            time_bound_instruction = (
                f"this table has no own time column, so you MUST join to {parent_bare_name} "
                f"(via {join_desc}) and bound on its {table.time_via.column} column"
            )
    elif selective_column:
        time_bound_instruction = (
            f"you MUST include a bounding predicate that limits the scan (e.g. an equality/IN filter on {selective_column})"
        )
    else:
        time_bound_instruction = "you MUST include a bounding predicate that limits the scan"

    return f"{table.quoted_ref} has ~{rows_desc} rows; {time_bound_instruction} and a LIMIT; do not scan unbounded."


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


# ── Fix A: pure BFS bridge-path functions (JOINGRAPH_SURFACING.md §2, §8.2) ─
#
# Deliberately free of any `HybridRetriever`/`LoadedBundle` dependency so they
# are trivially unit-testable against a hand-built adjacency dict (see
# ceiba_nl2sql/tests/test_retriever.py's bridge-expand tests) — the crux of
# the HR failure (a 3-hop Measurements->Monitors->Acceptances->Patients path
# through bridge tables the current fixture bundle does not model) can be
# exercised without loading any bundle at all.

# adjacency: tableId -> list of (neighbor_table_id, JoinEdgeDict) where
# JoinEdgeDict is the raw joingraph.json edge shape: {"from", "fromColumns",
# "to", "toColumns", "joinCardinality", "crossSource", "origin", "confidence"}.
# Each edge is inserted TWICE (once per direction) so BFS can walk it either
# way (JOINGRAPH_SURFACING.md §2: "BFS over the UNDIRECTED join graph").
JoinAdjacency = dict[str, list[tuple[str, dict]]]


def build_join_adjacency(edges: list[dict]) -> JoinAdjacency:
    """Build an undirected adjacency map from joingraph.json's `edges` list.
    Precomputed once (cached on `HybridRetriever._adjacency` at `load()` time)
    per JOINGRAPH_SURFACING.md §6: "Precompute an adjacency map once at
    load() time... rather than scanning `edges` linearly on every retrieve."
    """
    adjacency: JoinAdjacency = {}
    for edge in edges:
        adjacency.setdefault(edge["from"], []).append((edge["to"], edge))
        adjacency.setdefault(edge["to"], []).append((edge["from"], edge))
    return adjacency


def bfs_shortest_path(
    adjacency: JoinAdjacency, start: str, end: str, max_hops: int = MAX_BRIDGE_HOPS
) -> list[tuple[str, str, dict]] | None:
    """BFS shortest path from `start` to `end` over the undirected join graph,
    capped at `max_hops` edges. Returns the path as a list of
    `(from_node, to_node, edge_dict)` hops (in traversal order, `from_node`/
    `to_node` being the BFS walk direction, NOT necessarily the edge's own
    `from`/`to` — the edge is undirected for reachability purposes), or None
    if no path within `max_hops` exists. Returns `None` (not an empty path)
    when `start == end` — a table never needs to "bridge" to itself.
    """
    if start == end:
        return None
    visited = {start}
    # queue entries: (node, path_so_far)
    queue: deque[tuple[str, list[tuple[str, str, dict]]]] = deque([(start, [])])
    while queue:
        node, path = queue.popleft()
        if len(path) >= max_hops:
            continue
        for neighbor, edge in adjacency.get(node, []):
            if neighbor in visited:
                continue
            new_path = path + [(node, neighbor, edge)]
            if neighbor == end:
                return new_path
            visited.add(neighbor)
            queue.append((neighbor, new_path))
    return None


def _edge_confidence_sum(hops: list[tuple[str, str, dict]]) -> float:
    return sum(edge.get("confidence", 1.0) for _, _, edge in hops)


def bridge_expand(
    adjacency: JoinAdjacency,
    survivor_ids: list[str],
    max_hops: int = MAX_BRIDGE_HOPS,
    max_paths: int = MAX_BRIDGE_PATHS,
) -> tuple[set[str], list[list[tuple[str, str, dict]]]]:
    """JOINGRAPH_SURFACING.md §8.2's algorithm, as a pure function over plain
    dicts/sets (no bundle/dataclass dependency — trivially unit-testable).

    For every unordered pair of survivors with NO direct edge between them,
    finds the BFS shortest path (<= max_hops); collects every intermediate
    (bridge) node into a set, and every found path (each a list of
    `(from_node, to_node, edge_dict)` hops), ranked shortest-first then by
    total edge confidence descending, capped at `max_paths`.

    Returns `(bridge_nodes, admitted_paths)`.
    """
    survivor_set = set(survivor_ids)
    direct_pairs: set[tuple[str, str]] = set()
    for node, neighbors in adjacency.items():
        if node not in survivor_set:
            continue
        for neighbor, _edge in neighbors:
            if neighbor in survivor_set:
                direct_pairs.add(frozenset((node, neighbor)))  # type: ignore[arg-type]

    candidate_paths: list[list[tuple[str, str, dict]]] = []
    seen_pairs: set[frozenset] = set()
    survivors_sorted = sorted(survivor_set)
    for i, s_i in enumerate(survivors_sorted):
        for s_j in survivors_sorted[i + 1 :]:
            pair = frozenset((s_i, s_j))
            if pair in direct_pairs or pair in seen_pairs:
                continue
            seen_pairs.add(pair)
            path = bfs_shortest_path(adjacency, s_i, s_j, max_hops=max_hops)
            if path is not None:
                candidate_paths.append(path)

    candidate_paths.sort(key=lambda hops: (len(hops), -_edge_confidence_sum(hops)))
    admitted = candidate_paths[:max_paths]

    bridge_nodes: set[str] = set()
    for hops in admitted:
        for from_node, to_node, _edge in hops:
            if from_node not in survivor_set:
                bridge_nodes.add(from_node)
            if to_node not in survivor_set:
                bridge_nodes.add(to_node)

    return bridge_nodes, admitted


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
        self._adjacency: JoinAdjacency = {}

    def load(self, bundle_dir: str | Path) -> None:
        self._bundle = load_bundle(bundle_dir, expected_embedding_model_id=self._expected_embedding_model_id)

        dimension = self._bundle.manifest["embeddingModel"]["dimension"]
        self._vss = VssClient(self._bundle.vectors_duckdb_path, dimension)

        # Fix A (JOINGRAPH_SURFACING.md §6): precompute the adjacency map ONCE
        # at load() time rather than scanning `edges` linearly on every retrieve.
        self._adjacency = build_join_adjacency(self._bundle.join_graph.get("edges", []))

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
        # Fix D (SEMANTIC_HINTS.md §3.2/§8.2): machine-mined hint matrix, kept
        # separate from hand-seeded `synonyms` for auditable provenance.
        # Backward compatible: absent on any bundle built before this fix.
        auto_synonyms: list[dict] = glossary.get("autoSynonyms", [])

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
                glossary_hits.append(self._glossary_hit_from_map(synonym["term"], m, confidence=1.0))

        for auto_synonym in auto_synonyms:
            term = auto_synonym["term"]
            aliases = auto_synonym.get("aliases", [])
            confidence = auto_synonym.get("confidence", 1.0)
            candidate_terms = [term, *aliases]

            matched_multi_word_alias = any(
                " " in t and t.lower() in lower_question for t in candidate_terms
            )
            matched_bare = False
            for t in candidate_terms:
                if " " in t:
                    continue
                if not re.search(r"\b" + re.escape(t.lower()) + r"\b", lower_question):
                    continue
                # SEMANTIC_HINTS.md §7 stop-token deny-list: a bare short
                # ambiguous abbreviation only counts if a multi-word alias
                # for THIS SAME term also matched.
                if t.lower() in _AMBIGUOUS_BARE_TERM_DENYLIST and not matched_multi_word_alias:
                    continue
                matched_bare = True
                break

            if not (matched_multi_word_alias or matched_bare):
                continue

            expanded_terms.append(term)
            expanded_terms.extend(aliases)
            for m in auto_synonym.get("maps", []):
                glossary_hits.append(self._glossary_hit_from_map(term, m, confidence=confidence))

        return " ".join(expanded_terms), glossary_hits

    @staticmethod
    def _glossary_hit_from_map(term: str, m: dict, *, confidence: float = 1.0) -> GlossaryHit:
        kind = m.get("kind")
        if kind == "coded-measurement":
            value_column_id = m.get("valueColumnId")
            # Fix D §3.3: hostingTableId is the load-bearing retrieval-pin
            # field. Prefer an explicit `hostingTableId` (auto-mined maps
            # always carry it); derive it from valueColumnId's table for
            # backward compat with hand-seeded entries that don't yet carry
            # the field (SEMANTIC_HINTS.md §3.3: "derive-from-value-column is
            # almost certainly simplest and covers both... cases uniformly").
            hosting_table_id = m.get("hostingTableId")
            if not hosting_table_id and value_column_id:
                hosting_table_id = ".".join(value_column_id.split(".")[:-1])
            return GlossaryHit(
                term=term,
                resolved_column_id=value_column_id,
                time_column_id=m.get("timeColumnId"),
                unit=m.get("unit"),
                hosting_table_id=hosting_table_id,
                confidence=m.get("confidence", confidence),
                code_value=m.get("codeValue"),
                code_label=m.get("codeLabel") or (m.get("codeValue") if isinstance(m.get("codeValue"), str) else None),
                code_column_id=m.get("codeColumnId"),
            )
        if kind == "column":
            return GlossaryHit(
                term=term,
                resolved_column_id=m.get("columnId"),
                time_column_id=m.get("timeColumnId"),
                unit=m.get("unit"),
                confidence=confidence,
            )
        if kind == "temporal-column":
            return GlossaryHit(term=term, time_column_id=m.get("columnId"), confidence=confidence)
        if kind == "table":
            return GlossaryHit(term=term, confidence=confidence)
        if kind == "derived":
            return GlossaryHit(term=term, resolved_column_id=m.get("toColumnId"), confidence=confidence)
        # Exhaustiveness guard mirror: unknown kind -> minimal hit rather than
        # a silent drop (the TS version fails at compile time; here we degrade
        # gracefully but the term is still recorded).
        return GlossaryHit(term=term, confidence=confidence)

    # ── stage 3: hybrid table recall ────────────────────────────────────────

    def _recall_tables(
        self,
        expanded_question: str,
        source_scope: list[str] | None,
        recall_tables: int,
        query_embedding: list[float] | None = None,
    ) -> list[str]:
        bundle, vss, table_bm25, _ = self._ensure_loaded()

        # The embedding is computed ONCE per retrieve() and passed down —
        # table and column recall share the same expanded question, so
        # embedding it twice was pure duplicated latency.
        if query_embedding is None:
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

    def _recall_columns(
        self,
        expanded_question: str,
        survivor_table_ids: list[str],
        recall_columns: int,
        query_embedding: list[float] | None = None,
    ) -> list[str]:
        bundle, vss, _, column_bm25 = self._ensure_loaded()

        if query_embedding is None:
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

    # ── Fix A stage: BFS bridge-expand (JOINGRAPH_SURFACING.md §2, §3, §8.2) ─

    def _bridge_expand(self, recalled_survivor_ids: list[str]) -> tuple[set[str], list[JoinPath]]:
        """Runs BETWEEN graph-expand (stage 5) and LLM-prune. For every
        unordered pair of survivors with no direct edge, BFS the shortest
        path (<= MAX_BRIDGE_HOPS) over the precomputed adjacency map; collects
        intermediate bridge nodes + admits up to MAX_BRIDGE_PATHS paths
        (shortest-first, then by edge confidence descending).
        """
        bundle, *_ = self._ensure_loaded()
        bridge_nodes, admitted_hops = bridge_expand(
            self._adjacency, recalled_survivor_ids, max_hops=MAX_BRIDGE_HOPS, max_paths=MAX_BRIDGE_PATHS
        )

        join_paths: list[JoinPath] = []
        for hops in admitted_hops:
            nodes = [hops[0][0]] + [to_node for _from, to_node, _edge in hops]
            hints: list[JoinHint] = []
            for from_node, to_node, edge in hops:
                # Preserve the EDGE's own declared from/to direction (FK-side
                # -> PK-side) in the rendered hint regardless of the BFS walk
                # direction (JOINGRAPH_SURFACING.md §4: direction is FK->PK).
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
            join_paths.append(JoinPath(nodes=nodes, edges=hints, hop_count=len(hops)))

        return bridge_nodes, join_paths

    # ── stage 7: render ──────────────────────────────────────────────────────

    def _render_table(
        self, table: dict, column_id_allowlist: set[str] | None, *, role: str = "primary"
    ) -> RenderedTable:
        # Cardinality-guard remediation: a table can carry MORE THAN ONE
        # isTimeColumn (e.g. staging.Shared.Monitors has CreatedDate,
        # MeasuredDate, ValidationDate — all timestamp bookkeeping columns,
        # but only MeasuredDate is the one meaning "when this reading was
        # taken", and only it is indexed). Picking the first one found (the
        # prior behavior) can silently name a non-indexed, semantically-wrong
        # column as `required_time_column` — the guard would then reject a
        # query that correctly bounds the RIGHT time column because it
        # doesn't match the WRONG one this function picked. Prefer an
        # INDEXED time column; fall back to the first when none is indexed
        # (unchanged behavior for a single-time-column table, the common
        # case). Mirrors prep/prep/enrich/importance.py
        # `_best_time_column_for_bounding`'s identical preference.
        time_columns = [c for c in table.get("columns", []) if c.get("isTimeColumn")]
        best_time_column = next((c for c in time_columns if c.get("isIndexed")), time_columns[0] if time_columns else None)
        required_time_column = best_time_column["quotedName"] if best_time_column else None
        fk_column_names = {
            col_name for cols in self._fk_from_columns_by_table(table["tableId"]) for col_name in cols
        }
        if role == "bridge":
            # Bridge tables render as PK/FK-only stubs (JOINGRAPH_SURFACING.md
            # §3): they exist to be joined THROUGH, not selected FROM.
            raw_columns = [
                c
                for c in table.get("columns", [])
                if c.get("isPrimaryKey") or c["name"] in fk_column_names
            ]
        else:
            raw_columns = [
                c
                for c in table.get("columns", [])
                if not column_id_allowlist or c["columnId"] in column_id_allowlist or c.get("isPrimaryKey")
            ]
        columns = [
            RenderedColumn(
                name=c["name"],
                quoted_name=c["quotedName"],
                data_type=c["dataType"],
                unit=c.get("unit"),
                is_time_column=c.get("isTimeColumn", False),
                is_indexed=c.get("isIndexed", False),
                is_foreign_key_or_primary_key=bool(c.get("isPrimaryKey") or c["name"] in fk_column_names),
            )
            for c in raw_columns
        ]
        bundle, *_ = self._ensure_loaded()
        profile = bundle.get_table_profile(table["tableId"])
        time_via_raw = table.get("timeVia")
        time_via = (
            TimeVia(
                table_id=time_via_raw["table"],
                column=time_via_raw["column"],
                from_columns=list(time_via_raw.get("fromColumns", [])),
                to_columns=list(time_via_raw.get("toColumns", [])),
            )
            if time_via_raw
            else None
        )
        return RenderedTable(
            table_id=table["tableId"],
            quoted_ref=table["quotedRef"],
            grain=table.get("grain") or f"table {table['quotedRef']}",
            columns=columns,
            approx_row_count=profile.get("approxRowCount", 0) if profile else 0,
            is_large_time_series=table.get("isLargeTimeSeries", False),
            required_time_column=required_time_column,
            role=role,
            time_via=time_via,
        )

    def _fk_from_columns_by_table(self, table_id: str) -> list[list[str]]:
        """All `fromColumns` lists of join-graph edges where `table_id` is the
        FK ("from") side — used to mark FK columns for bridge-stub rendering
        and for Fix C's selective-column derivation.
        """
        bundle, *_ = self._ensure_loaded()
        return [edge["fromColumns"] for edge in bundle.join_graph.get("edges", []) if edge["from"] == table_id]

    @staticmethod
    def _build_cardinality_warning(table: RenderedTable) -> CardinalityWarning:
        return CardinalityWarning(
            table_id=table.table_id,
            approx_row_count=table.approx_row_count,
            required_time_column=table.required_time_column,
            message=build_cardinality_warning_message(table),
        )

    def _build_join_hints(self, survivor_table_ids: list[str]) -> list[JoinHint]:
        """Tier 1 (JOINGRAPH_SURFACING.md §2): edges among final rendered
        survivors — unchanged existing behavior.
        """
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

    @staticmethod
    def _restrict_join_paths_to_rendered(
        join_paths: list[JoinPath], rendered_table_ids: set[str]
    ) -> list[JoinPath]:
        """Tier 2: restrict bridge JoinPaths to those whose every node
        actually made it into the final rendered set (JOINGRAPH_SURFACING.md
        §8.2 step 5: "Bridge nodes feed back into stage 7 render as
        protected... tables").
        """
        return [jp for jp in join_paths if all(n in rendered_table_ids for n in jp.nodes)]

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

        # Embed the expanded question ONCE; table + column recall both use it.
        query_embedding = self._embed_query(expanded)

        recalled_table_ids = self._recall_tables(
            expanded, source_scope, recall_tables_count, query_embedding=query_embedding
        )

        # Fix D §4.2/§8.3 — the RETRIEVAL PIN: a matched glossary hint's
        # hosting table is injected at rank 0, AHEAD of the dense/BM25 fused
        # list, bypassing dense/BM25 entirely for a known coded-measurement
        # hit. This is the recall fix for "HR" never surfacing MonitorMeasurements.
        pinned_table_ids = [
            h.hosting_table_id
            for h in glossary_hits
            if h.hosting_table_id and h.confidence >= HINT_PIN_THRESHOLD
        ]
        # De-dupe while preserving pin-then-recall order.
        seen: set[str] = set()
        ordered_recalled_table_ids: list[str] = []
        for tid in [*pinned_table_ids, *recalled_table_ids]:
            if tid in seen:
                continue
            seen.add(tid)
            ordered_recalled_table_ids.append(tid)
        recalled_table_ids = ordered_recalled_table_ids

        recalled_column_ids = self._recall_columns(
            expanded, recalled_table_ids, recall_columns_count, query_embedding=query_embedding
        )
        recalled_column_id_set = set(recalled_column_ids)

        expanded_table_ids = self._graph_expand(recalled_table_ids)
        # Preserve the pin-then-recall RANK ORDER through graph-expand: the
        # newly-reachable FK neighbors are appended after the already-ordered
        # `recalled_table_ids` (pins at rank 0), rather than the arbitrary
        # set-iteration order `_graph_expand` returns internally — this is
        # what lets the deterministic stub LLM-prune's "keep incoming order,
        # truncate to max_tables" actually respect the pin under a tight cap.
        ordered_expanded_table_ids = list(recalled_table_ids)
        seen_expanded = set(ordered_expanded_table_ids)
        for tid in expanded_table_ids:
            if tid in seen_expanded:
                continue
            seen_expanded.add(tid)
            ordered_expanded_table_ids.append(tid)
        expanded_table_ids = ordered_expanded_table_ids

        # Fix A §2/§3 — BFS bridge-expand + bridge-protect: pull in the
        # shortest connecting paths (and their intermediate bridge tables)
        # between survivor pairs with no direct edge, BEFORE LLM-prune runs,
        # and reserve slots for protected/bridge tables so max_tables
        # truncation does not drop them ahead of lower-value non-bridge
        # candidates (JOINGRAPH_SURFACING.md §3's bridge-protect pseudocode).
        bridge_nodes, join_paths = self._bridge_expand(expanded_table_ids)
        candidate_ids = list(expanded_table_ids)
        seen_candidates = set(candidate_ids)
        for tid in bridge_nodes:
            if tid in seen_candidates:
                continue
            seen_candidates.add(tid)
            candidate_ids.append(tid)

        candidates = [
            {"tableId": tid, "grain": (bundle.get_table(tid) or {}).get("grain") or f"table {tid}"}
            for tid in candidate_ids
        ]
        pruned_table_ids = self._llm_prune(question, candidates, opts.max_tables)

        # Bridge-protect (+ pin-protect): if the LLM-prune truncated away a
        # bridge node a still-admitted path needs, OR a pinned hosting table,
        # re-admit it ahead of the cut — reserve slots for protected tables
        # before truncating the rest. Pinned tables are protected the same
        # way bridge nodes are: a "guaranteed recall" hit must not be silently
        # dropped by a tight max_tables cap either.
        protected_ordered = [t for t in pinned_table_ids if t in candidate_ids] + [
            t for t in bridge_nodes if t in candidate_ids and t not in pinned_table_ids
        ]

        final_table_ids = list(pruned_table_ids[: opts.max_tables])
        missing_protected = [t for t in protected_ordered if t not in final_table_ids]
        if missing_protected and len(final_table_ids) + len(missing_protected) <= opts.max_tables:
            final_table_ids.extend(missing_protected)
        elif missing_protected:
            # Not enough room for every protected table: reserve slots for
            # them first (pins ahead of bridges, per `protected_ordered`'s
            # construction), capped at max_tables, then fill any remainder
            # with the highest-ranked non-protected candidates.
            protected_capped = missing_protected[: opts.max_tables]
            non_protected_ranked = [t for t in pruned_table_ids if t not in protected_ordered]
            room_for_non_protected = max(opts.max_tables - len(protected_capped), 0)
            final_table_ids = [*protected_capped, *non_protected_ranked[:room_for_non_protected]]

        final_table_id_set = set(final_table_ids)
        # A bridge node renders as a stub UNLESS it also independently
        # survived as a primary candidate (e.g. it was recalled directly).
        primary_rendered_ids = set(recalled_table_ids) | (set(final_table_ids) - bridge_nodes)

        rendered_tables: list[RenderedTable] = []
        running_tokens = 0
        for table_id in final_table_ids:
            table = bundle.get_table(table_id)
            if not table:
                continue
            role = "bridge" if table_id in bridge_nodes and table_id not in primary_rendered_ids else "primary"
            column_allowlist = recalled_column_id_set if table_id in recalled_table_ids else None
            rendered = self._render_table(table, column_allowlist, role=role)
            rendered_tokens = _estimate_tokens(_render_table_for_estimate(rendered))
            if rendered_tables and running_tokens + rendered_tokens > opts.token_budget:
                # Bridge tables are protected from the token-budget cut too,
                # as long as at least one non-bridge table already rendered
                # (JOINGRAPH_SURFACING.md §3/§6): a bridge-only render with no
                # target table would be useless, so only skip the BREAK for a
                # bridge stub, never force past budget for a primary table.
                if role == "bridge":
                    rendered_tables.append(rendered)
                    running_tokens += rendered_tokens
                    continue
                break
            rendered_tables.append(rendered)
            running_tokens += rendered_tokens

        rendered_table_ids = {t.table_id for t in rendered_tables}
        cardinality_warnings = [
            self._build_cardinality_warning(t) for t in rendered_tables if t.is_large_time_series
        ]
        join_hints = self._build_join_hints([t.table_id for t in rendered_tables])
        rendered_join_paths = self._restrict_join_paths_to_rendered(join_paths, rendered_table_ids)
        exemplars = self._recall_exemplars(question, exemplar_k)

        return SchemaContext(
            tables=rendered_tables,
            join_hints=join_hints,
            join_paths=rendered_join_paths,
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
