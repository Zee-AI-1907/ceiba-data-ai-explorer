# P1 — FK Join-Subgraph Tool + Tool-Calling Surface (implementation plan)

**Status:** hardened via 4-dimension adversarial review (workflow `wf_c1d3f272-e02`, 2026-07-10). Blockers folded in. Needs user ratification of the open items in §Open-for-user before T1 starts.
**Spec:** `docs/superpowers/specs/2026-07-10-fk-join-subgraph-tool-and-tool-calling-surface-design.md` (see §Corrections).
**Branch:** `remediation/phase-0-foundation`.

## Summary
All four reviews converged on the same code-verified facts:
1. **The reused BFS is hop-capped at 3** (`retriever.py:49 MAX_BRIDGE_HOPS=3`) and **path-capped at 6** (`:50 MAX_BRIDGE_PATHS=6`), so it CANNOT reconnect the 4–5-hop endpoints the tool exists to fix. The spec's worked example (MonitorMeasurements→Monitors→Acceptances→Patients) is exactly 3 edges, which masked the gap.
2. **The OpenAI client seam physically cannot carry a tool loop:** `LlmCompletion` is a frozen 3-field dataclass with no `tool_calls` (`llm.py:114-123`); `complete()`'s empty-content guard raises on every tool-call turn (`:312-313`); `call_llm` takes a single string (`:140-151`).
3. **The reused hint/render machinery is bundle-coupled instance methods**, and `_render_join_graph` keys every node against the SHARED `tables` list (`prompt.py:330-333`), so a declared/bridge table not already surfaced renders degraded.
4. **Self-repair silently reverts to the survivor-fed graph** (`pipeline.py:565-566`).

Correction to the spec: **tools and `response_format` DO coexist** in one `chat.completions` call — the real constraint is per-turn (a turn yields EITHER `tool_calls` OR final content), so a LOOP is required regardless. Do not strip `response_format` globally; omit it on planning turns, attach `SQL_GENERATION_RESPONSE_FORMAT` on the final generation turn.

**PHI posture (confirmed safe):** the tool returns schema relations only (table/FK-column names + cardinality); no `allowed_values`/`topCategories`. Egress class `schema-metadata` is always-allowed and BAA-independent by existing design — restate this one sentence for the KVKK reviewer, and assert in tests the output never carries sample values.

## Design changes folded in (from review)
- Add `@dataclass(frozen=True) ToolCall{id,name,arguments}` and `LlmTurn{text:str|None, tool_calls:list[ToolCall], finish_reason:str, usage:TokenUsage, model:str}` to `llm.py`. The low-level tool method returns `LlmTurn`; the loop wrapper collapses the final (no-tool) turn to `LlmCompletion`. `LlmCompletion` unchanged → single-shot path untouched.
- New `OpenAiLlmClient.complete_messages(messages, *, tools=None, tool_choice='auto', response_format=None) -> LlmTurn`: reads `message.tool_calls` FIRST; null content valid when tool_calls present; raises only when NEITHER tool_calls NOR content. Own `_build_tool_params`; own error handling (the R3 `'response_format'`-substring fallback at `llm.py:299` would never match a tools-400). OPTIONAL on the `LlmClient` Protocol (duck-typed via `hasattr`) so existing stubs stay valid.
- New parallel choke point `call_llm_with_tools(llm, messages, tools, handlers, egress_class, *, max_rounds, response_format=None) -> LlmCompletion`: asserts egress on EVERY outbound round, loops `complete_messages` → run handlers → append `{'role':'tool',...}` messages → continue; sums usage across all rounds.
- `build_join_subgraph` takes explicit `max_hops` (propose **6**, NOT the inherited 3) and a scaled `max_paths`; connector is an **anchor-BFS CONNECTED subgraph** over the named set (not top-6 pairwise). Resolves each input id (bare-name/quotedRef/canonical `<sourceId>.<schema>.<Table>`), returns explicit `unknown_tables` + per-unconnected-pair `unreachable` notes. Never fail-closed-silent.
- `join_hints` computed over (named ids ∪ admitted bridge_nodes) to match `retrieve()` render form.
- Tool path builds/AUGMENTS the `RenderedTable` list with minimal `role='bridge'` stubs (PK/FK-only columns), NOT the instance `_render_table` (avoids profiles/topCategories/PHI).
- Declared subgraph threaded into `assemble_repair_prompt` too ("self-repair unchanged" was wrong for this flag).
- Plan/tool phase SKIPPED when `route_is_simple(context)` and only on clients implementing `complete_messages`; else byte-identical flag-off path.
- Distinct plan-turn prompt (tableId-bearing inventory + question, tools enabled, NO SQL response_format, NO survivor JOIN GRAPH).
- Loop bounding: hard `max_rounds` (GenerateOptions, default 3) → terminate into generation; duplicate-call short-circuit; `finish_reason=='length'` → escalate cap once or fail loud.
- Metering: `call_llm_with_tools` appends EVERY turn to `metered_calls`; `UsageSummary.llm_calls` → "1 + plan turns + repair rounds".
- Tool-capability probe alongside `probe_model_async` (`live_benchmark.py:209`): trivial `tools=[...]` + `tool_choice='required'`, assert a `tool_calls` response; skip-and-log incapable cells.

## Blockers (resolve before the gated steps)
- **B1 (gates T9 / live A/B, not T1–T8):** the runtime models `gpt-5.4-mini/-nano`, `gpt-5.6-luna` post-date the knowledge cutoff — live-verify against the real key that each honors `tools=`/`tool_choice=` AND that strict json_schema `response_format` coexists with tools on these snapshots. Nano/mini reasoning tiers historically have the weakest tool-calling reliability.
- **B2 (gates T1):** ratify connector semantics — anchor-BFS connected subgraph (plan default) vs union of pairwise paths.
- **B3 (gates T9):** resolve the model-set mismatch — the handoff referenced `sol`, but `RUNTIME_MODELS` = mini/nano/luna and `pricing.py` prices only luna/terra.
- **B4 (gates T1):** confirm `max_hops=6` / scaled `max_paths`, and that the 4–5-hop unit test uses a hand-built adjacency dict (mock-v1's longest chain is only 3 hops).

## Tasks (dependency-ordered)

| Task | Title | Depends |
|------|-------|---------|
| **T1** | Extract pure module-level `build_join_subgraph` (raised hop/path caps, anchor-BFS connected connector, id-resolution, unknown/unreachable reporting); delegate retriever internals to it | none |
| **T2** | Add `ToolCall`/`LlmTurn` types + `complete_messages` client method (own param builder + error handling; scripted stub support) | none |
| **T3** | Add `call_llm_with_tools` egress choke point (assert egress every round, sum usage) | T2 |
| **T4** | Bound the loop (`max_rounds`, duplicate-call short-circuit, `finish_reason=='length'` handling) | T3 |
| **T5** | Render augmentation: minimal bridge `RenderedTable` stubs into `assemble_prompt`'s tables arg | T1 |
| **T6** | Plan-turn prompt (`assemble_plan_prompt`) + tool registry `{name, json_schema, handler}` in new `generation/tools.py` | T1, T2 |
| **T7** | Pipeline wiring: GenerateOptions flags, gated plan phase, `route_is_simple` skip, subgraph into initial AND repair prompts, per-turn metering | T4, T5, T6 |
| **T8** | Pipeline/e2e egress + metering + PHI assertions | T7 |
| **T9** | Tool-capability probe + skip-and-log + A/B harness axis | T2, T7 |

**T1 detail** — module-level `build_join_subgraph(table_ids, *, adjacency, get_table_ref, edges, max_hops, max_paths) -> (join_hints, join_paths, bridge_nodes, unknown_tables, unreachable_pairs)`. Lift the JoinPath-assembly body from `_bridge_expand` (`retriever.py:770-790`) and the edge-scan from `_build_join_hints` (`:914-929`). Anchor-BFS: sort resolved ids, anchor = first, BFS each other id to the connected tree, collect bridges; unreachable ids → `unreachable_pairs`. `join_hints` over (named ∪ bridges). Re-point `HybridRetriever._bridge_expand`/`_build_join_hints` to delegate with the retriever's own caps so its output is unchanged.
Tests (`test_retriever.py`): `test_build_join_subgraph_reconnects_4_hop_endpoints`, `_reconnects_5_hop_endpoints`, `_connected_over_three_named_tables`, `_unknown_table_reported`, `_unreachable_pair_reported`, `_resolves_bare_name_and_quotedref`, `_deterministic_ordering`, `_hints_cover_bridge_edges`; regression `test_retriever_output_unchanged_after_delegation`.

**T2–T9 detail:** see the workflow synthesis (reproduced in the review notes appended below); each task carries exact files, approach, named tests, and a `superpowers:requesting-code-review` gate. Flag-off byte-identity and helper purity are review-gated at T1/T7.

## Open for user (ratify before/at implementation)
1. **Connector semantics (B2):** anchor-BFS CONNECTED subgraph over the named set (recommended — it delivers the "connect all named tables" load-bearing property) vs the UNION of pairwise shortest paths (documented as not-a-tree).
2. **Caps (B4):** `max_hops=6` (must exceed the deepest 5-edge chain for the 14-table staging diameter) and `max_paths` scaled to named-set size. 4–5-hop unit test via hand-built adjacency (mock-v1 tops out at 3 hops).
3. **`tool_choice` on the plan turn:** `'required'` (one guaranteed plan call per flag-on query) vs `'auto'` (model decides — some queries skip the tool). Affects cost.
4. **Self-join & cross-source semantics:** `bfs_shortest_path` returns None for `start==end` (self-FK never a connector) while tier-1 hints WOULD emit a self-edge — state intended behavior. Decide whether a `cross_source=true` bridge hop is admissible when downstream SQL runs against a single source (flag/exclude/admit).
5. **Runtime model set (B3):** confirm mini/nano/luna (the `sol` reference appears unbacked).
6. **Max tool-call rounds default (3)** and whether the A/B harness varies it.

## Corrections to the spec
The spec's §4/§8.3 "tools and response_format do not mix" is a misdiagnosis (they coexist; the loop is what's required); §3's "reuse the BFS machinery" understates the work (hop cap, pairwise-not-connected, bundle-coupling); §5's "self-repair unchanged" is wrong for this flag. This plan supersedes those sections. The spec's PHI/egress and toggle claims are confirmed correct.
