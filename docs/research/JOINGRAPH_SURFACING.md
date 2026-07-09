# Surfacing the FK Join Graph to the Driving LLM for Multi-Hop NL→SQL

**Status:** research + decision-grade recommendation (feeds implementation immediately).
**Scope:** how to render `joingraph.json` edges + shortest bridge paths into the generation prompt so the driving LLM picks correct multi-hop join paths at the ~1,200-table scale.
**Read-only research.** No code was changed.

---

## 0. TL;DR — the recommendation

1. **Add a dedicated `JOIN GRAPH` section to the prompt** (separate block, not inline per-table), rendered in a compact **`A.col = B.col [N:1]`** notation with a one-line direction/cardinality tag per edge. This is the single highest-leverage change and is directly supported by the literature (§1, §4).
2. **Compute the edge set with BFS over the join graph:** include (a) every edge *among survivor tables*, plus (b) the **shortest join path between each pair of survivors**, pulling in **bridge tables** (like `Monitors`, `Acceptances`) that lie on those paths even when the retriever did not rank them (§2, §3).
3. **Promote bridge tables into the survivor set** and mark them explicitly as `-- bridge/junction table: needed only to join X to Y` so the model keeps them in the FROM/JOIN but does not try to SELECT from them (§3).
4. **Render cardinality + direction** (`N:1`, `1:N`) so the model avoids fan-out / wrong-grain aggregation (§4).
5. **Wire the glossary lookup fact** ("heart rate" → `MeasurementTypeId = 2`, a value in `MonitorMeasurements`) into a `SEMANTIC HINTS` block, and connect it to the join graph by naming the table the coded value lives on (§5).
6. **Token budget:** edges-among-survivors first (cheap, always include), then shortest bridge paths by ascending length until a hard cap (`MAX_JOIN_EDGES`, `MAX_BRIDGE_HOPS`, and a token ceiling). This keeps cost bounded at 1,200-table scale (§6).

Expected impact on the motivating HR failure: **eliminates the `Monitors.Id = Patients.Id` error class outright** — the model no longer guesses a join column, it copies the exact edge from the prompt, and the bridge tables it needs (`Monitors`, `Acceptances`) are present and labeled (§7).

---

## 1. Representation in the prompt — which format the LLM actually uses

### What we emit today
`assemble_prompt()` (`ceiba_nl2sql/generation/prompt.py`) renders, per survivor table: `quoted_ref`, `grain`, `approxRowCount`, and a column list. It emits **no join information at all** — `SchemaContext.join_hints` is *built* by the retriever (`_build_join_hints`) but **never consumed by the prompt assembler**. That is the root cause of the HR failure: the FK edges exist in the bundle and even in the `SchemaContext`, but the LLM never sees them, so it invents a join predicate (`Monitors.Id = Patients.Id`).

### Options considered

| Option | Form | Verdict |
|---|---|---|
| (a) Inline per-table "joins to X via col=col" | annotation appended under each table's column list | Good, but scatters the graph; the model must mentally stitch a multi-hop path from fragments. Weak for 3-hop paths. |
| (b) Dedicated **JOIN GRAPH / relationships** section listing edges | one block, all edges | **Recommended primary.** Matches M-Schema's `【Foreign keys】` section and the "+ForeignKey" prompt variant that the literature shows helps. |
| (c) DDL-style `FOREIGN KEY (...) REFERENCES ...` constraints | CREATE TABLE with FK clauses | Works, but verbose; DDL "lacks essential table/column descriptions and example values, causing LLMs to struggle to differentiate similar columns" — and burns tokens we need for bridge paths. |
| (d) Compact **path notation** `A.col → B.col → C.col` | one line per multi-hop path | **Recommended companion** for the specific bridge paths between two survivors. It hands the model the *whole traversal* pre-assembled. |
| (e) Explicit NL "to go from A to C, join via …" | sentence per path | Highest token cost; use sparingly, only for the 1-2 paths most central to the question. |

### What the literature shows

- **Adding FK relationships to the prompt is empirically decisive.** Gao et al., *How to Prompt LLMs for Text-to-SQL* (the standardized zero-shot study), find: *"in zero-shot settings, adding the table's relationship which represents a foreign key, the model consistently outperforms prompts not using the relationship, demonstrating that relationships are very helpful for the model to understand the database."* This is the direct empirical warrant for §0 item 1. ([openreview](https://openreview.net/pdf?id=5sOZNkkKh3), [wobby summary](https://www.wobby.ai/insights/what-we-learned-about-prompting-llms-for-text-to-sql))
- **A separate FK section is the format frontier systems use.** M-Schema (the schema serialization behind XiYan-SQL, a top BIRD system) renders a dedicated `【Foreign keys】` block, one relationship per line in the exact compact form **`table1.col1=table2.col2`**, and is reported to outperform the code-structure/DDL representation. ([M-Schema repo](https://github.com/XGenerationLab/M-Schema), `m_schema.py` line 127: `output.append(f"{fk[0]}.{fk[1]}={fk[3]}.{fk[4]}")`; [XiYan-SQL](https://arxiv.org/pdf/2411.08599))
- **Pre-computed join *paths* (not just edges) drive SOTA on multi-hop.** SchemaGraphSQL builds the FK graph, asks the model only for source+destination tables, then runs **classical path-finding** and hands the model the *optimal sequence of tables and columns to join* — reaching state-of-the-art on BIRD, beating fine-tuned and multi-step baselines. This validates option (d): give the model the traversal, don't make it derive it. ([arXiv 2505.18363](https://arxiv.org/abs/2505.18363))
- **Plugging a schema graph into multi-table QA gives very large gains.** *Plugging Schema Graph into Multi-Table QA* reports **+51.26 F1 (33.29→84.55) on Olympics and +39.19 F1 (17.68→56.87) on Financial** when the graph-derived join paths are supplied, with the explicit prompt instruction *"Only join tables that contribute directly to the SELECT, WHERE, or GROUP BY clauses. Avoid unnecessary joins."* ([arXiv 2506.04427](https://arxiv.org/html/2506.04427v1))

**Recommendation:** use **(b) + (d) together** — a `JOIN GRAPH` section that (i) lists edges among survivors in `A.col = B.col [N:1]` form, then (ii) lists the shortest *bridge paths* between survivors in `A.col → B.col → C.col` form. Keep the M-Schema `=` convention because top BIRD systems train the models' expectations on exactly that token.

---

## 2. Which edges to include — you cannot dump 1,160 FKs

The retriever already produces a **survivor set** (`final_table_ids` → `rendered_tables`). Budget the graph render off that set, in two tiers:

**Tier 1 — edges among survivors (always include).** Exactly what `_build_join_hints()` already computes: every edge whose `from` and `to` are both survivors. Cheap, bounded by `O(survivors²)` in the worst case but in practice a handful. This is the free win.

**Tier 2 — shortest bridge paths between survivor *pairs* (the fix for HR).** The HR failure is precisely the case where two high-relevance survivors (`MonitorMeasurements`, `Patients`) have **no direct edge** — the connection runs through `Monitors` and `Acceptances`, which the column-recall stage has no reason to rank (the user asked about HR and patients, not devices or acceptances). Compute the connecting path with **BFS over the undirected join graph**:

```
for each unordered pair (s_i, s_j) of survivors:
    path = BFS_shortest_path(joingraph, s_i, s_j)     # nodes + the edge used at each hop
    if path and len(path.hops) <= MAX_BRIDGE_HOPS:
        record path; mark every intermediate node as a BRIDGE table
```

BFS (not Dijkstra) because edges are unweighted for reachability; if you want to *prefer* declared over inferred edges or high-confidence over low, weight `= 2 - confidence` and switch to Dijkstra (cheap upgrade, see §4/§6). This mirrors SchemaGraphSQL's "classical path-finding over the FK graph" and the *Plugging Schema Graph* "traverse the minimal set of necessary join paths" ([2505.18363](https://arxiv.org/abs/2505.18363), [2506.04427](https://arxiv.org/html/2506.04427v1)).

**Budgeting the paths:** cap by (a) `MAX_BRIDGE_HOPS` (recommend **3** — enough for `Measurements→Monitors→Acceptances→Patients`, which is 3 hops), (b) `MAX_BRIDGE_PATHS` total, and (c) the token ceiling (§6). Sort candidate paths by ascending hop count (short paths are both cheaper and more likely correct), then by total edge confidence descending, and admit until a cap trips.

**De-duplicate bridge tables:** a bridge table appearing on several pairwise paths is added to the survivor set **once**.

---

## 3. Bridge-table inclusion — the crux of the HR failure

The retriever's stage 5 (`_graph_expand`) currently pulls **1-hop FK neighbors** of survivors into the candidate set, then stage 6 (LLM-prune) can drop them again, and stage 7 renders within budget. Two gaps:

1. **1-hop expand is not enough for 3-hop paths.** `MonitorMeasurements`'s 1-hop neighbor is `Monitors`; `Patients`'s neighbors are `Acceptances`/wards/etc. Neither expansion reaches *across* to close the `Measurements↔Patients` gap unless both `Monitors` **and** `Acceptances` survive pruning — which is exactly what failed.
2. **Bridge tables get pruned** because the LLM-prune / token-budget stage ranks them low (they contribute no SELECT/WHERE columns).

**Recommendation — a "bridge-protect" step between graph-expand and prune:**

```
survivors_after_recall = recall_tables ∪ recall_columns' tables
bridge_nodes = ⋃ over survivor pairs: intermediate nodes on BFS_shortest_path (len ≤ MAX_BRIDGE_HOPS)
protected = survivors_after_recall ∪ bridge_nodes
# LLM-prune / token-budget may drop *non-protected* tables first;
# bridge_nodes are only dropped if the path they serve is itself dropped.
```

Render each bridge node's table with **PK/FK columns only** (not its full column list — it exists to be joined *through*, not selected *from*), and label it in the prompt:

```
- Table "staging"."Shared"."Monitors" (tableId: staging.Shared.Monitors)
  role: BRIDGE / junction — needed only to join MonitorMeasurements to Acceptances; do not SELECT business columns from it
  join columns: "Id", "AcceptanceId"
```

This directly implements the *Plugging Schema Graph* instruction "only join tables that contribute … avoid unnecessary joins" while still guaranteeing the connecting tables are present ([2506.04427](https://arxiv.org/html/2506.04427v1)). It also matches *Join-Aware Multi-Table Retrieval* (Chen et al.), whose whole thesis is that retrieval scored by *answerability* must include **bridging tables needed to connect** the answer tables, not just the top semantically-similar tables ([arXiv 2404.09889](https://arxiv.org/pdf/2404.09889)).

---

## 4. Join cardinality + directionality — preventing fan-out / wrong-grain

`joingraph.json` edges carry `joinCardinality` (`one-to-one | many-to-one | one-to-many | many-to-many`) and a `from`/`to` direction (`from` holds the FK, `to` holds the PK). **Surface both**, because:

- Wrong-grain aggregation (double-counting after a 1:N fan-out) is a named top error class in clinical NL→SQL — "patient↔encounter↔observation joins … ambiguous 'patient' resolution is a top error source" (`docs/research/NL2SQL_RESEARCH.md` §6). A `COUNT(DISTINCT Patients.Id)` vs `COUNT(*)` decision hinges on knowing the join fans out.
- The FK **direction** tells the model which side is the "one" — critical for choosing the anchor table and for `LEFT JOIN` vs `INNER JOIN` reasoning.

**Concise rendering** — a compact tag appended to each edge, plus an arrow encoding direction (FK-side → PK-side):

```
"MonitorMeasurements"."DeviceId" = "Monitors"."Id"        [N:1]   -- many measurements per monitor
"Monitors"."AcceptanceId"        = "Acceptances"."Id"      [N:1]
"Acceptances"."PatientId"        = "Patients"."Id"         [N:1]
```

`N:1` from left to right is unambiguous and 3 tokens. For the multi-hop path line, carry the chain cardinality so the model sees the net grain:

```
Path (measurement → patient):  "MonitorMeasurements" →(N:1) "Monitors" →(N:1) "Acceptances" →(N:1) "Patients"
  net: many measurements map to one patient — safe to filter on measurement rows, DISTINCT patients when counting.
```

The whole path here is N:1 at every hop, so counting patients needs `COUNT(DISTINCT ...)`; the annotation says so in one clause. Add a one-line rule to the preamble: *"When a join is 1:N or N:1 and you aggregate the 'one' side, use COUNT(DISTINCT …) / guard against row fan-out."*

---

## 5. Semantic / lookup hints — connecting "heart rate" → code → join

The HR case needs **three** facts chained: (1) "heart rate"/"HR" → the coded value `MeasurementTypeId = 2`; (2) that code lives in `MonitorMeasurements`; (3) `MonitorMeasurements` reaches `Patients` via the bridge path. The glossary already carries (1): `_glossary_hit_from_map` handles `kind == "coded-measurement"` producing a `GlossaryHit(resolved_column_id, time_column_id, unit)`. But `GlossaryHit` is, like `join_hints`, **built and never rendered** into the prompt.

**Recommendation — a `SEMANTIC HINTS` block** that renders each glossary hit and *names the table the coded value sits on*, so the model can connect the lookup to the join graph:

```
SEMANTIC HINTS (resolve NL terms to columns/coded values; use these exactly):
- "heart rate" / "HR"  →  filter "MonitorMeasurements"."MeasurementTypeId" = 2
                          value column: "MonitorMeasurements"."Value" (unit=bpm)
                          time column:  "MonitorMeasurements"."MeasuredDate"   (use for the "last 3 hours" bound)
                          this measurement lives on "MonitorMeasurements" → join to patients via the JOIN GRAPH path below
```

This is the schema-linking "value linking" the literature calls out as second only to table/column linking (M-Schema adds example values for exactly this reason; BIRD gains from database-content/value hints). Wiring the *hosting table name* into the hint is the connective tissue between the glossary and the join graph — without it the model knows the code but not where it lives.

If the coded value lives in a **separate lookup/enum table** (the `MeasurementTypeRef`-style pattern in the fixture) rather than a literal on the fact table, render it as both a hint *and* a join-graph edge, and prefer the literal-filter form (`MeasurementTypeId = 2`) when the code is stable, since it avoids an extra join.

---

## 6. Token budget + scaling to ~1,200 tables

The graph render must stay bounded regardless of schema size. Everything is scoped to the survivor set (≤ `max_tables`, typically 3–8 after prune), so the graph render is a function of survivors, **not** of the 1,200 tables. Policy, in strict priority order:

1. **Tier-1 edges among survivors** — always include (small, high value). Est. ~15–25 tokens/edge in `A.col = B.col [N:1]` form.
2. **Bridge paths**, admitted **shortest-first**, until any cap trips:
   - `MAX_BRIDGE_HOPS = 3` (covers the HR 3-hop path; raise to 4 only if eval shows longer real paths).
   - `MAX_BRIDGE_PATHS` (e.g. 6) — total pairwise paths rendered.
   - `JOIN_GRAPH_TOKEN_CEILING` (e.g. 15% of `token_budget`) — hard stop; the existing `_estimate_tokens` (chars/4) already exists to price this.
3. **Bridge-table stubs** (PK/FK columns only) cost far less than full tables; count them against the same table token budget in stage 7, but mark them protected (§3) so they are not the first dropped.

**Directional preference under budget:** when two paths tie on length, prefer the one whose edges are `origin=declared` / higher `confidence` (an inferred `confidence=0.86` edge is a weaker join than a declared FK). This is the Dijkstra-with-`weight = 2 − confidence` upgrade — cheap, and it makes the model prefer trustworthy joins.

At 1,200 tables the BFS itself is bounded: the join graph has ~1,160 edges (sparse), so a BFS per survivor pair is microseconds. Precompute an adjacency map once at `load()` time (alongside the BM25 indices) rather than scanning `edges` linearly on every retrieve.

---

## 7. Failure-mode coverage — which choices fix which failure

| Failure mode | Concrete instance | Representation choice that fixes it |
|---|---|---|
| **Wrong join column** | `Monitors.Id = Patients.Id` (invented predicate) | §1 JOIN GRAPH edges in exact `A.col = B.col` form — the model copies the predicate instead of guessing. Empirically the single biggest lever ([openreview](https://openreview.net/pdf?id=5sOZNkkKh3)). |
| **Missing bridge table** | `Monitors`, `Acceptances` pruned away | §2 BFS shortest paths + §3 bridge-protect: the connecting tables are pulled in and shielded from pruning ([2404.09889](https://arxiv.org/pdf/2404.09889)). |
| **Wrong grain / fan-out** | counting measurement rows as patients | §4 `[N:1]` cardinality tags + the DISTINCT rule in the preamble. |
| **Silent 0 rows** | wrong join returns 0, not error | Combination: correct predicate (§1) + present bridges (§3) means the query joins on real keys; the cardinality guard (existing) can additionally flag a 0-row result as suspicious. The prompt-level fix is preventing the bad join in the first place. |
| **Unnecessary joins / hallucinated tables** | joining tables the query doesn't need | §3 bridge labeling + the "avoid unnecessary joins" instruction ([2506.04427](https://arxiv.org/html/2506.04427v1)). |

---

## 8. Concrete build spec (implementer-ready)

### 8.1 Rendered prompt section — HR query, real tables

Given survivors `MonitorMeasurements` and `Patients` (from recall) + protected bridges `Monitors`, `Acceptances`, the `JOIN GRAPH` + `SEMANTIC HINTS` sections render as:

```
---

SEMANTIC HINTS (resolve NL terms exactly; prefer literal code filters over extra joins):
- "HR" / "heart rate"  →  "MonitorMeasurements"."MeasurementTypeId" = 2
     value:  "MonitorMeasurements"."Value"        (unit=bpm; "above 120" → Value > 120)
     time:   "MonitorMeasurements"."MeasuredDate"  (use for "last 3 hours")
     hosted on "MonitorMeasurements"; to reach patients, follow the JOIN GRAPH path below.

---

JOIN GRAPH (use these exact join predicates; direction is FK-side → PK-side, [card] is row multiplicity):

Edges among selected tables:
  "MonitorMeasurements"."DeviceId"     = "Monitors"."Id"           [N:1]
  "Monitors"."AcceptanceId"            = "Acceptances"."Id"        [N:1]
  "Acceptances"."PatientId"            = "Patients"."Id"           [N:1]

Multi-hop path (measurement → patient), all hops N:1 — one patient per measurement, so COUNT(DISTINCT "Patients"."Id") when counting patients:
  "MonitorMeasurements" →(DeviceId=Id, N:1) "Monitors" →(AcceptanceId=Id, N:1) "Acceptances" →(PatientId=Id, N:1) "Patients"

BRIDGE tables (present only to connect the above — do not SELECT business columns from them):
  - "staging"."Shared"."Monitors"     join cols: "Id", "AcceptanceId"   (+ "MeasuredDate" available)
  - "staging"."Shared"."Acceptances"  join cols: "Id", "PatientId"

---
```

A model given this writes the correct query — it copies each predicate, filters `MeasurementTypeId = 2` and `Value > 120`, bounds `MeasuredDate >= now() - INTERVAL '3 hours'`, and counts `DISTINCT Patients.Id` — returning the true 3,434 instead of 0.

### 8.2 Algorithm — select edges + bridge paths from `joingraph.json`

```
INPUT:  survivor_table_ids (from retrieve()), joingraph (adjacency map precomputed at load)
CONFIG: MAX_BRIDGE_HOPS=3, MAX_BRIDGE_PATHS=6, JOIN_GRAPH_TOKEN_CEILING

1. tier1_edges = [e for e in joingraph.edges if e.from in survivors and e.to in survivors]
2. bridge_paths = []; bridge_nodes = set()
   for (s_i, s_j) in unordered_pairs(survivors) with no tier1 edge between them:
       path = bfs_shortest_path(adjacency, s_i, s_j)         # undirected reachability
       if path is not None and path.hop_count <= MAX_BRIDGE_HOPS:
           bridge_paths.append(path)
           bridge_nodes |= set(path.intermediate_nodes)
3. rank bridge_paths by (hop_count asc, sum_confidence desc); keep first MAX_BRIDGE_PATHS
   (optional: weight edges 2 - confidence and use Dijkstra to prefer declared/high-confidence joins)
4. admit tier1_edges (always), then bridge_paths while running token estimate < JOIN_GRAPH_TOKEN_CEILING
5. emit: JoinGraphRender{ edges: tier1_edges, paths: admitted_paths, bridge_nodes }
```

Bridge nodes feed back into stage 7 render as **protected, PK/FK-only** tables (§3).

### 8.3 SchemaContext / RenderedTable additions

- `RenderedTable`: add `role: str = "primary"` (`"primary" | "bridge"`) and a `join_columns: list[str]` (PK/FK names) so a bridge table renders as a stub. `_render_table` gates the column list on `role`.
- New dataclass `JoinPath{ nodes: list[str_ref], edges: list[JoinHint], net_cardinality: str, from_ref: str, to_ref: str }`.
- `SchemaContext`: add `join_paths: list[JoinPath]` (alongside existing `join_hints`) and keep `glossary_hits` (already present) — but **render both** in `assemble_prompt`.
- `HybridRetriever`: add `_bridge_expand(survivors) -> (bridge_nodes, join_paths)` called between graph-expand and prune; mark bridge nodes protected in the token-budget loop; precompute `self._adjacency` in `load()`.
- `prompt.py`: add `_render_join_graph(edges, paths, bridge_nodes)` and `_render_semantic_hints(glossary_hits, tables)`; insert both sections into `assemble_prompt` between SCHEMA CONTEXT and CARDINALITY WARNINGS. (Repair prompt inherits them via `assemble_repair_prompt` calling `assemble_prompt`.)

### 8.4 Token-budget rule (one sentence)

*Always render Tier-1 edges among survivors; then admit shortest-first bridge paths (≤ 3 hops) and their PK/FK-only bridge-table stubs until either `MAX_BRIDGE_PATHS` or `JOIN_GRAPH_TOKEN_CEILING` (~15% of `token_budget`) is reached, preferring declared/high-confidence edges on ties.*

---

## 9. Ranked recommendations — accuracy impact vs effort

| # | Recommendation | Accuracy impact | Effort | Notes |
|---|---|---|---|---|
| 1 | **Render `SchemaContext.join_hints` in the prompt** (Tier-1 edges, `A.col = B.col [N:1]`) | **Very high** | **Low** — data already computed; wire `_render_join_graph` into `assemble_prompt` | Fixes wrong-join-column outright for directly-connected survivors. Ship first. |
| 2 | **BFS bridge paths + bridge-protect + bridge labeling** | **Very high** (fixes the HR class specifically) | **Medium** — new `_bridge_expand`, `JoinPath`, adjacency precompute, `RenderedTable.role` | The actual fix for multi-hop-through-non-survivors. |
| 3 | **SEMANTIC HINTS block (render glossary_hits, name hosting table)** | **High** for coded/temporal questions | **Low–Medium** — render existing `glossary_hits` + resolve hosting table | Connects "HR"→code→table→join; also fixes value-linking failures. |
| 4 | **Cardinality/direction tags + DISTINCT preamble rule** | **Medium–High** (grain/fan-out class) | **Low** — data already on edges | Add `[N:1]` tag + one preamble sentence. |
| 5 | **Confidence-weighted path selection (Dijkstra upgrade)** | **Low–Medium** | **Low** | Only matters once inferred edges are common; safe to defer. |

**Build order:** 1 → 4 (both trivial, both high value) → 2 → 3 → 5.

---

## Sources

- Gao et al., *How to Prompt LLMs for Text-to-SQL: A Study in Zero-shot, Single-domain, and Cross-domain Settings* — FK relationships in the prompt "consistently outperform" prompts without them. [openreview](https://openreview.net/pdf?id=5sOZNkkKh3), [arXiv 2305.11853](https://arxiv.org/pdf/2305.11853), [summary](https://www.wobby.ai/insights/what-we-learned-about-prompting-llms-for-text-to-sql)
- *SchemaGraphSQL: Efficient Schema Linking with Pathfinding Graph Algorithms for Text-to-SQL on Large-Scale Databases* — FK graph + classical path-finding → SOTA on BIRD. [arXiv 2505.18363](https://arxiv.org/abs/2505.18363)
- *Plugging Schema Graph into Multi-Table QA* — graph-derived minimal join paths; +51.26 / +39.19 F1; "avoid unnecessary joins" instruction. [arXiv 2506.04427](https://arxiv.org/html/2506.04427v1)
- *Is Table Retrieval a Solved Problem? Exploring Join-Aware Multi-Table Retrieval* — bridging tables must be retrieved to connect answer tables. [arXiv 2404.09889](https://arxiv.org/pdf/2404.09889)
- M-Schema — dedicated `【Foreign keys】` section, `table1.col1=table2.col2` line format; outperforms DDL/code representation. [repo](https://github.com/XGenerationLab/M-Schema); XiYan-SQL (M-Schema-based top BIRD system) [arXiv 2411.08599](https://arxiv.org/pdf/2411.08599)
- *A Survey of NL2SQL with Large Language Models* — schema linking as a critical module; graph-based schema encoding. [arXiv 2408.05109](https://arxiv.org/html/2408.05109v1)
- Internal: `docs/NL2SQL_SPEC.md` §1.4–1.5 (keys/joingraph schema), §4 (retriever/SchemaContext); `docs/research/NL2SQL_RESEARCH.md` §2.2 (retrieve-then-graph-expand), §3.2a (cardinality), §6 (patient/encounter grain).
