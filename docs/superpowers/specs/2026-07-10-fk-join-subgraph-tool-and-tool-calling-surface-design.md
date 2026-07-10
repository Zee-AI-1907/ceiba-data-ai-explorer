# FK Join-Subgraph Tool + Extensible Tool-Calling Surface — Design

**Status:** approved design (brainstormed 2026-07-10); HARDENED by a 4-dimension adversarial review — see the implementation plan `docs/superpowers/plans/2026-07-10-p1-join-subgraph-tool-implementation.md`, which supersedes §4/§8.3 (tools+response_format DO coexist — the loop, not a split, is what's required), §3 (the reused BFS is hop-capped at 3 and computes pairwise-not-connected paths; more work than "factor out"), and §5 (self-repair must thread the declared subgraph, not stay unchanged). The PHI/egress and toggle claims here are confirmed correct.
**Branch:** `remediation/phase-0-foundation`.
**Priority:** P1 (top-of-list next-session priority — join errors on 4–5-hop queries are the #1 failure mode).

---

## 0. TL;DR

Give the driving LLM a **static, deterministic tool** it calls with the list of tables it thinks it
needs; the tool returns the ground-truth FK relations *among those tables* plus the bridge tables
required to connect them, rendered in the existing `JOIN GRAPH` notation. Deliver it through a
**minimal but genuine tool-calling loop** (OpenAI `chat.completions` `tools=`), designed as an
**extensible registry** so more tools (column stats, glossary, etc.) drop in later. The join-subgraph
helper is tool #1.

This flips the top failure mode: instead of the *retriever* guessing which tables to surface (which
breaks on long chains), the **model declares intent** and receives ground-truth relations it cannot
misremember.

Literature warrant: this is SchemaGraphSQL's two-stage recipe (ask the model for the tables → run
classical path-finding → hand back the join sequence), which reached SOTA on BIRD
(`docs/research/JOINGRAPH_SURFACING.md` §1, arXiv 2505.18363).

---

## 1. Problem

The prompt already renders a per-query `JOIN GRAPH` (`prompt.py:312` `_render_join_graph`): edges among
survivor tables, BFS bridge paths, bridge-table promotion, cardinality tags, and anti-`Id=Id` guidance.
But it is **survivor-scoped** — the edge/path set is computed from whatever the *retriever* ranked for
the query. On 4–5-hop queries this breaks down when:

- the retriever does not surface both endpoints of a long chain, so no connecting path is computed;
- pairwise bridge paths between survivors do not compose into the full traversal the query needs;
- the token budget drops the longer paths.

The FK data itself is complete and correct (`keys.json` / `joingraph.json`); it is *underutilized*
because table selection is delegated to retrieval heuristics rather than to the model that is actually
writing the SQL.

## 2. Goals / Non-Goals

**Goals**
- A pure, deterministic helper that, given an arbitrary set of table ids, returns the FK subgraph among
  them + the bridge tables/paths needed to connect them, in the existing render notation.
- A minimal, genuine tool-calling loop on the existing OpenAI client, structured as an extensible
  registry so future tools require no re-architecture.
- Toggleable end-to-end so it A/B's cleanly against today's retriever-fed `JOIN GRAPH`.

**Non-Goals**
- Not replacing the retriever or the survivor-scoped `JOIN GRAPH` — the tool augments; the existing
  render remains the fallback for the non-tool path.
- Not solving 1,200-table production scale in this iteration; the benchmark target is the 14-table
  staging schema. (Scale is noted as a follow-up in §8.)
- Not building tools beyond `get_join_subgraph` now — only the registry seam that makes them cheap
  later.

## 3. Component A — `build_join_subgraph(table_ids)` (pure Python, static)

**Contract.** Input: a list of table ids/names the model declares. Output: a structure carrying (a) FK
edges among the named tables, (b) BFS shortest connector paths that join otherwise-disconnected named
tables, pulling in the intermediate **bridge** tables, and (c) the one-hop FK neighbors of the named set,
flagged "also in scope" so the model can pull in a table it forgot.

**Connector scope decision.** Not one-hop-only. If the model names only the endpoints of a long chain
(e.g. `MonitorMeasurements`, `Patients`), one-hop expansion does not reconnect them — the connecting
path runs `MonitorMeasurements → Monitors → Acceptances → Patients`. The helper therefore computes
**BFS shortest paths to connect the named tables to each other** (the guarantee), and *additionally*
lists one-hop neighbors as scope hints (the convenience). This is the load-bearing correctness property.

**Reuse.** The edge/path/BFS machinery already exists in the retriever
(`_build_join_hints`, `JoinPath`, the BFS bridge-path finder). Factor it out of the retriever into a
standalone unit keyed by an *arbitrary* table set instead of the survivor set, so both the retriever and
the tool call the same code. Render via the existing `_render_join_graph` notation so downstream output
is byte-identical in form to what the model already sees today.

**Determinism.** No LLM, no network — pure function over the bundle's FK graph. Fully unit-testable
against fixture bundles.

## 4. Component B — tool registry + tool-calling loop

**Client.** Extend `OpenAiLlmClient` (`generation/llm.py`) with a tool-enabled path that accepts
`tools=[...]` and a registry of Python handlers. On a `tool_calls` response it executes the named
handler with the model-supplied arguments, appends the tool result message, and loops until the model
stops calling tools. The final turn emits SQL via the **existing** structured `response_format`
(`SQL_GENERATION_RESPONSE_FORMAT`) — tools first, structured SQL last (they do not mix cleanly in one
call).

**Interface.** The current `LlmClient` Protocol is `complete(prompt) -> LlmCompletion` (single-shot).
Add a richer entry point (e.g. `complete_with_tools(messages, tools) -> LlmCompletion`) rather than
overloading `complete`, so the existing single-shot path (and every stub/recorded test client) is
untouched. `StubLlmClient` / `RecordedLlmClient` gain a scripted tool-call analogue for hermetic tests.

**Registry.** A tool is `{name, json_schema, handler}`. `get_join_subgraph` is registered as tool #1;
its handler wraps `build_join_subgraph`. Adding a tool later = one registry entry + one handler.

**Egress/PHI.** The join-subgraph tool returns **schema relations only** (table + FK column names +
cardinality) — no row data, no patient-derived values — so it stays on the non-patient egress class.
The BAA/egress gate (`call_llm`) remains the choke point; the tool loop routes through it. (A review
dimension will confirm no schema-name leakage concern under HIPAA/KVKK.)

## 5. Component C — pipeline wiring (toggleable)

A planning phase where the model may call `get_join_subgraph` before generating, gated by a new
`GenerateOptions` flag (mirroring `strict_join_steering`, default off) so the benchmark can A/B it
against the retriever-fed `JOIN GRAPH`. When the flag is off, behavior is exactly as today. The
self-repair loop and cardinality/PHI gates are unchanged; the tool phase sits *before* generation and
feeds its rendered subgraph into the generation prompt.

## 6. Data flow

```
question
  └─ (plan turn, tools enabled)
        model → get_join_subgraph(tables=[...declared...])
        helper → build_join_subgraph → { edges, bridge paths, 1-hop neighbors }  (static, deterministic)
        model ← rendered JOIN GRAPH subgraph  (existing notation)
        [model may call again]
  └─ (generation turn, response_format=SQL)
        prompt + declared subgraph → { sql, description }
  └─ validate → cardinality/PHI gates → self-repair (unchanged)
```

## 7. Testing

- **Unit (helper):** `build_join_subgraph` over fixture bundles — edges among named set; BFS reconnects
  endpoints of a 4–5-hop chain; one-hop neighbors flagged; disconnected tables handled; deterministic
  output; render matches `_render_join_graph` form.
- **Unit (client):** tool-call loop executes handler, appends result, loops, then emits structured SQL;
  stub/recorded clients script a tool call; the single-shot `complete` path is unaffected.
- **Pipeline:** flag off = byte-identical to today; flag on = model's declared tables drive the rendered
  subgraph; egress class stays non-patient through the tool loop.
- **Live A/B (staging):** the 4–5-hop reference queries (`live_bench_queries.py`) — tool-on vs
  retriever-fed, judged by reading the SQL (the human is the judge; `joins_ok` is directional only).

## 8. Open items for the review agents

1. **gpt-5.x tool-calling live-verify.** Chat Completions supports `tools=`, but confirm the specific
   snapshots the key has (luna/mini/nano) honor it, and how reasoning-model token accounting interacts
   with the tool loop.
2. **Reuse audit.** How survivor-coupled is `_build_join_hints`/`JoinPath` today — can it be factored to
   an arbitrary table set without disturbing the retriever's callers?
3. **`tools` + `response_format`.** Confirm the tools-first / structured-last split is necessary and
   whether any single-call combination is viable on these models.
4. **Bound the loop.** Max tool-call rounds; behavior if the model names a nonexistent table (helper
   returns "unknown table" so the model can correct — do NOT fail closed silently).
5. **Scale note (follow-up, not this iteration).** At 1,200 tables the model cannot enumerate tables
   blind; a retrieval-primed candidate list likely precedes the tool call. Out of scope now, recorded so
   the interface does not foreclose it.

## 9. Rollout

Behind the `GenerateOptions` flag; ship dark, A/B on staging, promote if it beats the retriever-fed
`JOIN GRAPH` on the multi-hop reference queries by human judgment.
