# FK Relation Validation — Guide, Embed, Validate join predicates against the FK graph

Status: research + design (no production code changed by this document).
Owner scope: `prep/prep/enrich/joingraph.py`, `ceiba_nl2sql/retrieval/retriever.py`,
`ceiba_nl2sql/generation/prompt.py`, `ceiba_nl2sql/guard/*`, `ceiba_nl2sql/generation/pipeline.py`.
Related: [`JOINGRAPH_SURFACING.md`](JOINGRAPH_SURFACING.md), [`EXPLAIN_CARDINALITY_GUARD.md`](EXPLAIN_CARDINALITY_GUARD.md),
[`SEMANTIC_HINTS.md`](SEMANTIC_HINTS.md), `NL2SQL_SPEC.md` §1.4/§1.5/§5.4.

---

## Problem

The pipeline generates read-only SQL from natural language over federated clinical
Postgres DBs (via DuckDB `ATTACH`). A cheap model (`gpt-5.4-nano`) produced a
**silent-wrong** answer on a multi-hop join: it emitted a join predicate on the
wrong key — an `Id = Id` self-key collapse (or a join to a plausible-but-wrong
table's key) — and returned a numerically plausible but semantically incorrect
count. Because the SQL parsed, guarded clean (read-only), and explained without
error, nothing in the pipeline caught it. The row count was wrong, not the query.

The invariant we must protect, using the repo's own naming convention:

> `<PK-table>.Id` maps to `<other-table>.<PK-table-singular>Id`.
> e.g. `Acceptances.Id ↔ Monitors.AcceptanceId`. It must **NEVER** map to
> `Patients.Id`, `Patients.PatientId`, or any similarly-named-but-wrong key.

A join predicate that violates the actual FK graph — `X.Id = Y.Id` where no such
FK exists, or `X.PatientId = Y.Id` where `X.PatientId` actually references
`Patients`, not `Y` — must be caught. There is currently **no** guard that inspects
join/WHERE equi-predicates against the FK graph at all.

Three levers, in the order data flows through the system:

1. **Embed** — encode column-role + FK-target constraints into the bundle so each
   join edge is unambiguous and the naming convention is captured as data.
2. **Guide** — surface those constraints to the LLM in the prompt so it *picks*
   the right predicate (partly done today; see §Guide).
3. **Validate** — parse the generated SQL and check every equi-predicate against
   the FK graph, rejecting or flagging violations (**the missing piece**).

---

## Current State

### How the join graph is built (prep)

`prep/prep/enrich/joingraph.py` builds `joingraph.json` from three edge sources
(module docstring, `joingraph.py:1-29`):

- **Declared edges** — `build_declared_edges` (`joingraph.py:152-180`) is a 1:1
  lift of `keys.json.foreignKeys` into the edge shape, `origin="declared"`,
  `confidence=1.0`. Cardinality is inferred from PK membership by
  `_declared_cardinality` (`joingraph.py:132-149`): if the source FK columns are
  the source table's full PK → `one-to-one`, else `many-to-one`.

- **Inferred name-match edges** — `build_inferred_name_match_edges`
  (`joingraph.py:233-295`). For every table `T` with a **single-column PK named
  `C`**, every *other* table with a column also named `C` gets an inferred edge
  `T'.C -> T.C`. This is the **`col-eq-pk`** strategy: it matches
  `<other>.C == <PK-table>.C` where `C` is the PK column name.

  **Critical gap for our invariant.** `_GENERIC_PK_NAME_DENYLIST`
  (`joingraph.py:191`) blocks bare `id`/`pk`/`key`/etc.  `_confidence_for_match`
  (`joingraph.py:200-230`) returns `None` for a bare `Id` match unless it also
  hits `_SHARED_ID_SPACE_HINTS` (`joingraph.py:197`). So:
  - The convention `Acceptances.Id ↔ Monitors.AcceptanceId` is **not** produced by
    this pass. Name-match only matches *identical* column names (`C == C`), i.e.
    it would produce `Monitors.Id -> Acceptances.Id` style edges (both named `Id`)
    — which is exactly the WRONG `Id = Id` shape — except those are suppressed by
    the denylist. It never derives the correct `Monitors.AcceptanceId -> Acceptances.Id`.
  - So today, the correct FK `Monitors.AcceptanceId → Acceptances.Id` exists in the
    graph **only if it was a declared DB constraint** in `keys.json`. In clinical
    DBs declared FKs are frequently **absent** (see §Risks), so this edge may not
    exist at all — the model has nothing correct to be steered toward, and the
    validator has no edge to check against.

- **Curated cross-source correlations** — `CROSS_SOURCE_CORRELATIONS`
  (`joingraph.py:63-86`) + `build_curated_cross_source_edges` (`joingraph.py:298-342`):
  a hand-maintained allowlist of shared id spaces across sources
  (`staging.Shared.Acceptances.HospitalId → mock.public.HospitalRef.HospitalId`,
  conf 0.86). Only emitted when both endpoints exist in the built catalog.

`build_join_graph` (`joingraph.py:345-384`) merges all three (declared first, so
declared keys de-dupe inferred/curated), and every catalog table becomes a node
even with no edges.

The raw FK facts live in `keys.json` (`prep/prep/cli.py:238-256`): each FK carries
`fkId`, `fromTable`, `fromColumns`, `toTable`, `toColumns`, `constraintName`,
`origin="declared"`. This is the SPEC §1.4 shape. `joingraph.json` edges carry
`from/fromColumns/to/toColumns/joinCardinality/crossSource/origin/confidence`
(SPEC §1.5, `joingraph.py:100-110`).

### How the graph is consumed (runtime retrieval)

`ceiba_nl2sql/retrieval/retriever.py` loads `joingraph.json` via the bundle
(`loader.py:116,195`) and:

- Precomputes an **undirected** adjacency map at load time —
  `build_join_adjacency` (`retriever.py:335-345`) inserts each edge **twice** (both
  directions) so BFS can walk either way.
- `_graph_expand` (`retriever.py:672-680`) pulls FK neighbors into the survivor set.
- `bridge_expand` / `bfs_shortest_path` (`retriever.py:348-433`) find multi-hop
  bridge paths between survivor pairs with no direct edge.
- `_build_join_hints` (`retriever.py:812-833`) emits Tier-1 `JoinHint`s for edges
  **among** the rendered survivors, preserving each edge's **own** declared
  from/to direction (FK-side → PK-side), regardless of BFS walk direction
  (`retriever.py:700-716` comment). `SchemaContext.join_hints` / `join_paths`
  (`retriever.py:200-211`) carry these to the prompt.

Note: the retriever consumes `joingraph.json` edges directly; it does **not**
re-read `keys.json` or carry per-edge `origin`/`confidence` into `JoinHint`
(`JoinHint` is defined at `retriever.py:140-148` — no `origin`/`confidence`
fields). Those fields are available on the raw edge dict but dropped at
`JoinHint` construction.

### How it's rendered (prompt)

`ceiba_nl2sql/generation/prompt.py`:

- `_render_join_graph` (`prompt.py:228-308`) renders the **JOIN GRAPH** section:
  a header instructing "use these exact join predicates; direction is FK-side →
  PK-side" and explicit "do NOT default to matching Id = Id" (`prompt.py:251-255`),
  then per-edge lines, bridge paths, bridge-table stubs.
- `_render_join_edge_line` (`prompt.py:155-179`) already spells out the exact FK
  column and — when the FK column name differs from the PK column name — appends
  an anti-`Id=Id` comment: *"use the FK column `DeviceId`, NOT `X.Id = Y.Id`"*.
  This is the existing prompt-accuracy fix for the exact bug.
- **SEMANTIC HINTS** (`prompt.py:311-393`) maps NL terms → coded values → hosting
  table + join.

The pipeline forwards `join_hints`/`join_paths`/`glossary_hits` into both the
initial and repair prompts (`pipeline.py:448-451, 504-508`) — a previously-fixed
root cause was these being silently dropped.

**So Guidance exists** — but it is only as good as the edges in the graph. If the
correct `Monitors.AcceptanceId → Acceptances.Id` edge is absent (no declared FK,
not derivable by `col-eq-pk`), the prompt lists nothing to steer toward, and the
`Id = Id` warning only fires on edges that *are* present.

### How validation works today (guards)

The generation-time validation chain in `_validate_candidate`
(`pipeline.py:221-353`), run inside the self-repair loop (`pipeline.py:472-538`):

1. `guard_sql` (`sqltools/guard.py:404-561`) — read-only / single-statement /
   no-filesystem. **AST-based (sqlglot)**, dialect-aware. Does not inspect joins.
2. `cardinality_guard_from_context` (`guard/cardinality.py:660-675`) — large-table
   scan bounding. Walks the AST for time-bound / selective-equality / parent-join
   predicates. **Does not check whether a join predicate is a valid FK.**
3. Postgres `pg_explain_estimate` (`guard/explain_estimate.py`) — cardinality
   sanity from `Plan Rows`. Catches join **fan-out** blowups (`JOIN_BLOWUP_REJECT_ROWS`),
   but a wrong-key join that returns a *plausible* count (our bug) will not blow up
   the estimate — it is exactly the case this misses.
4. `engine.explain` — DuckDB dry-run bind/parse validation. A syntactically valid
   `Id = Id` join binds fine.

Each guard returns a verdict with `action ∈ {pass, repair, reject}` and a
`repair_hint`; a `reject`/failed-explain feeds the self-repair loop as an
`_AttemptFailure(error, failed_sql, hint)` (`pipeline.py:197-201`). The guards
already share the `_COMPARISON_TYPES` / AST-walk idioms and the
`_table_aliases_by_bare_name` alias resolver (`cardinality.py:284-299`) — a new
FK-predicate guard can reuse these directly.

**Conclusion:** the FK graph is built, surfaced, and rendered, but **never checked
against the emitted SQL.** A join on a non-existent or wrong FK edge passes every
current gate.

---

## Design

### Embed — make each join edge unambiguous, and capture the naming convention

The graph already carries directional, confidence-scored edges. Two additive
enhancements:

**E1 — Convention-based inferred edges (the real fix for the reported bug).**
Add a new inference strategy alongside `col-eq-pk`, call it **`col-eq-pk-suffix`**
(the `<PK-table-singular>Id` convention), in `joingraph.py`:

- For every table `T` whose single-column PK is `Id` (the surrogate-key case),
  compute the expected FK column name from the table's bare name: singularize
  the table name and append `Id` (`Acceptances` → `AcceptanceId`, `Patients` →
  `PatientId`, `Monitors` → `MonitorId`). Keep singularization deterministic and
  conservative: strip a trailing `s`/`es` with a small irregulars map; when
  unsure, ALSO accept the raw table name + `Id` (`AcceptancesId`) as a lower-conf
  candidate rather than guessing wrong.
- For every *other* table with a column named exactly that expected FK name, emit
  an inferred edge `Other.<Table>Id → T.Id`, `origin="inferred"`,
  `joinCardinality="many-to-one"`, with a confidence in ~0.80–0.88 (below declared
  1.0, comparable to the curated cross-source edges). Gate at the existing
  `min_confidence` (default 0.8, `prep.config.yaml enrich.inferJoinEdges.minConfidence`).
- This is strictly higher-signal than `col-eq-pk` for surrogate keys: `AcceptanceId`
  encodes *what* it references (unlike bare `Id`), so a false positive is far less
  likely. It directly produces the `Monitors.AcceptanceId → Acceptances.Id` edge
  the graph is missing today.

This runs in `build_join_graph` after declared edges (so a declared FK always
wins and de-dupes the inferred one) and before curated edges, mirroring the
existing ordering (`joingraph.py:357-369`).

**E2 — A column-role / FK-target index for the validator.** The validator needs
to answer two questions cheaply per predicate: (a) "is `X.col` a FK column, and if
so what does it reference?" and (b) "is `X.col = Y.col2` a known edge?". Rather
than invent a new artifact, derive this at bundle-load time from the edges the
retriever already loads:

- Build an in-memory **FK index** keyed by `(from_table_id, frozenset(from_cols))`
  → list of `{to_table, to_cols, origin, confidence, cardinality}`, and the
  symmetric `(to_table, to_cols)` → sources. This is the same undirected data
  `build_join_adjacency` already materializes (`retriever.py:335-345`), plus the
  `fromColumns`/`toColumns`/`origin`/`confidence` retained (not dropped as they
  are for `JoinHint`).
- Also index **PK columns** per table from `keys.json.primaryKeys` (already in the
  bundle, `loader.py:115`) so the validator can recognize the `Id`-PK side of an
  edge and distinguish "PK column" from "FK column" from "neither".

No new bundle file is required — this is a runtime projection of `joingraph.json`
+ `keys.json`, both already loaded. (If profiling later shows we want it
precomputed, it can be emitted as an additive `fkIndex` block in `joingraph.json`,
backward-compatible per the SPEC's additive-field convention — but start with the
runtime projection.)

**Confidence marking.** Keep the existing `origin`/`confidence` on edges. The
validator's reject-vs-warn policy (below) keys off exactly these: a violation of a
`declared` (conf 1.0) edge is a hard signal; the *absence* of any supporting edge
where only low-confidence inferred edges exist nearby is a soft signal.

### Guide — surface the constraints so the model picks correctly

Mostly in place (`prompt.py:155-179`, `251-255`). Two additive improvements that
make the FK constraints unambiguous and reduce the validator's work:

**G1 — Render `origin`/`confidence` on each edge.** Carry `origin` and
`confidence` through `JoinHint` (add two fields at `retriever.py:140-148`; populate
in `_build_join_hints`/`_bridge_expand`). Render declared edges as authoritative
("declared FK") and inferred edges as "inferred (name convention), confidence
0.83 — verify". This tells the model which predicates are safe and which to treat
with care, and lets the prompt de-emphasize a low-confidence edge rather than
present it as fact.

**G2 — For each PK table in the survivor set, list its "referenced-by" edges
explicitly** ("`Acceptances.Id` is referenced by `Monitors.AcceptanceId`,
`Beds.AcceptanceId`; join THROUGH those columns, never `Id = Id`"). This is a
small addition to `_render_join_graph` driven by the same FK index (E2). It directly
targets the failure mode: the model reached for `Id = Id` because it did not have
the referencing column in view.

Guidance alone is not a control — a cheap model can still ignore it. Hence Validate.

### Validate — the FK-predicate guard (the new control)

Add `ceiba_nl2sql/guard/fk_predicate.py`, a sqlglot-AST guard that mirrors the
structure of `cardinality.py` (same imports, `CardinalityVerdict`-shaped
`FkPredicateVerdict`, same alias-resolution helper). It runs in the
`_validate_candidate` chain.

**Inputs.** The candidate SQL, the resolved dialect, and an FK-context object built
from the bundle (E2's FK index + PK index) restricted to the survivor/rendered
tables — analogous to how `build_cardinality_guard_options` derives its policy from
`context.tables` (`cardinality.py:622-657`). A thin
`build_fk_predicate_guard_options(context)` builds it.

**Algorithm.**

1. Parse with `sqlglot.parse_one(sql, read=dialect)`; fail closed on
   `ParseError`/`TokenError` (same posture as `cardinality.py:452-461`).
2. Resolve alias → bare-table via `_table_aliases_by_bare_name`
   (reuse `cardinality.py:284-299`, extract to a shared `sqltools` helper).
3. Collect every **equi-predicate between two columns** (`exp.EQ` with both sides
   `exp.Column`) in JOIN…ON clauses **and** WHERE clauses (walk the whole AST, as
   the other guards do). For each, resolve each side to `(table_id, column)` using
   the alias map and the survivor tables' column ownership (from `context.tables`).
   - A predicate where a side is a literal, function, or unresolved column is
     **not a join predicate** — skip it (it's a filter, handled by the cardinality
     guard).
4. For each resolved column-column equi-predicate `(A.a) = (B.b)` where `A != B`
   (a cross-table join predicate), classify:
   - **Supported**: there is an FK-index edge `A.a → B.b` or `B.b → A.a` (either
     direction, since joins are symmetric). → OK.
   - **Self-key collapse (`Id = Id`)**: both columns are named `Id` (case-insensitive)
     AND `A != B` AND no edge connects them. → the headline bug. **Reject.**
   - **Wrong-target**: `A.a` is a *known FK column* (appears as a `fromColumn` of
     some edge) but the edge it belongs to points at a table other than `B` (or at
     `B` but on a different column than `b`). e.g. `Monitors.AcceptanceId =
     Patients.Id` when `AcceptanceId` references `Acceptances`. → **Reject** — this
     is a confident violation: the column has a declared/high-conf target and this
     predicate contradicts it.
   - **No supporting edge**: neither column is a known FK endpoint between these two
     tables, and no edge connects them. → **Warn** (see policy) — the graph may
     simply be missing the edge (absent declared FK, not covered by inference),
     which is common; rejecting here would false-reject legitimate joins over an
     incomplete graph.

**Reject-vs-warn policy.**

- **Reject** (feed self-repair with a precise hint): `Id = Id` self-collapse; and
  wrong-target where the offending column is a FK endpoint of a **declared** edge
  (conf 1.0) pointing elsewhere. These are high-confidence "this is wrong"
  signals. The repair hint names the correct predicate from the FK index:
  *"`Monitors.AcceptanceId` references `Acceptances.Id`, not `Patients.Id`; join
  `Monitors.AcceptanceId = Acceptances.Id`"*. This is the same hint-shaped feedback
  the cardinality guard already produces (`cardinality.py:394-427`).
- **Warn (do not reject)**: no-supporting-edge joins, and wrong-target where the
  contradicted edge is only **inferred** (conf < 1.0). Emit a structured warning
  (surfaced in `RetrievalSummary`/response, not blocking). Rejecting these risks
  false-rejecting a correct join the graph merely failed to model — the FK graph
  is known to be incomplete (see Risks). The warn set is the tuning corpus for
  later promotion to reject.
- **Fail closed on parse errors only.** An unparseable statement is already
  rejected upstream by `guard_sql`; this guard rejecting it too is harmless and
  consistent.

**Where it runs in the chain.** In `_validate_candidate` (`pipeline.py:221-353`),
**after** `guard_sql` (need a parseable read-only statement) and **before**
`engine.explain` — same tier as `cardinality_guard`. Recommended order:

```
guard_sql → cardinality_guard → fk_predicate_guard → pg_explain_estimate → engine.explain
```

Rationale: it's a cheap pure-AST check (no DB round-trip, like `cardinality_guard`),
and catching a wrong-key join *before* the Postgres EXPLAIN probe saves a network
round-trip on an already-doomed candidate. A `reject` returns an `_AttemptFailure`
exactly as the cardinality reject does (`pipeline.py:287-296`), so the existing
self-repair loop picks it up with zero loop changes — the repair prompt inherits
the JOIN GRAPH section (`assemble_repair_prompt` → `assemble_prompt`,
`prompt.py:510-559`), so the model re-sees the correct edges plus the specific hint.

**Warnings plumbing.** Add an optional `fk_warnings: list[str]` to the failure/
response path. Minimal version: attach to `RetrievalSummary` or a new field on
`SqlGenerateResponse` (`pipeline.py:132-147`), additive. Warnings do not gate.

---

## Integration points (file:line)

| Concern | File / function | Change |
|---|---|---|
| New convention inference | `prep/prep/enrich/joingraph.py` `build_join_graph:345` | Add `build_inferred_convention_edges` between declared and curated. |
| FK index projection | `ceiba_nl2sql/retrieval/retriever.py` `HybridRetriever.load:462` | Build FK index alongside `_adjacency:470`, from `join_graph.edges` + `keys.primaryKeys`. |
| Carry origin/confidence | `retriever.py` `JoinHint:140`, `_build_join_hints:812`, `_bridge_expand:684` | Add `origin`/`confidence` fields; populate from edge dict. |
| Prompt: edge provenance + referenced-by | `ceiba_nl2sql/generation/prompt.py` `_render_join_edge_line:155`, `_render_join_graph:228` | Render declared/inferred + confidence; add "referenced-by" block. |
| New guard | `ceiba_nl2sql/guard/fk_predicate.py` (new) | `fk_predicate_guard(sql, ...)` + `build_fk_predicate_guard_options(context)` + `fk_predicate_guard_from_context`. |
| Shared alias helper | `ceiba_nl2sql/sqltools/` (new small module) | Extract `_table_aliases_by_bare_name` from `guard/cardinality.py:284` for reuse. |
| Chain insertion | `ceiba_nl2sql/generation/pipeline.py` `_validate_candidate:221` | Insert FK guard after cardinality (`:285`), before explain (`:340`); reject → `_AttemptFailure`. |
| Warnings surface | `pipeline.py` `SqlGenerateResponse:132`, `_retrieval_summary:356` | Additive `fk_warnings`. |

The self-repair loop (`pipeline.py:488-538`) needs **no** change — it already
loops on any `_AttemptFailure` and re-prompts with hint + JOIN GRAPH.

---

## Risks & open questions

- **Declared FKs are often absent in the clinical DB.** `keys.json.foreignKeys`
  comes from DB constraints (`cli.py:241-256`, `origin="declared"`). Many clinical
  schemas omit enforced FKs. So the graph leans on **inference**, and the validator
  must therefore treat "no supporting edge" as **warn, not reject** — otherwise it
  false-rejects legitimate joins. This is the central trade-off: the guard's
  strength is bounded by graph completeness.
- **Inference can create the wrong edge.** `col-eq-pk` already risks
  false-positive edges on generic names (mitigated by `_GENERIC_PK_NAME_DENYLIST`,
  `joingraph.py:191`). The new `col-eq-pk-suffix` convention is higher-signal but
  can still misfire on non-standard pluralization or a coincidental column name.
  Mitigation: keep convention edges at inferred confidence (< declared), and make
  the validator's **reject** tier fire only on **declared** contradictions +
  `Id = Id` collapse; convention-edge contradictions are warn-tier until the warn
  corpus proves them safe to promote. A wrong inferred edge should never cause a
  hard reject of a correct query.
- **Singularization is heuristic.** `Acceptances → Acceptance`, but
  `Diagnoses → Diagnosis`, `Statuses → Status` need irregulars. Keep the map small
  and accept both singular+`Id` and raw+`Id` as candidates; never guess a form that
  isn't present as an actual column.
- **Composite keys.** The `col-eq-pk*` strategies only apply to single-column PKs
  (`joingraph.py:252-254`). Composite-FK validation is out of scope for v1; the
  validator should treat a multi-column join conservatively (require *all* pairs to
  match a single edge's column lists, else warn).
- **Alias resolution to column ownership.** The validator must map `mm."Id"` →
  `MonitorMeasurements.Id`. `_table_aliases_by_bare_name` gives alias→table; column
  ownership comes from `context.tables[*].columns`. Ambiguity (same column name on
  two joined tables, unqualified in SQL) → treat as unresolved → skip that side
  (don't guess). The prompt already pushes the model to qualify columns.
- **Self-joins and derived tables.** A legitimate self-join (`t1.parent_id =
  t2.id` on the same base table under two aliases) must not trip the `A != B`
  cross-table rule — key the "different table" test on **resolved table_id**, and a
  self-referential FK edge (from_table == to_table in the graph) supports it.
- **Cross-source edges.** Cross-source joins (`crossSource=true`) are already
  modeled as edges; the validator treats them identically. No special case.
- **Interaction with existing anti-`Id=Id` prompt guidance.** The prompt fix
  (`prompt.py:174-178`) and this guard overlap by design — Guide reduces how often
  the guard must reject; Validate catches what Guide doesn't. Not redundant.

---

## Recommended phased implementation

**Phase 1 — Validate (highest value, self-contained, no prep rebuild).**
Ship `fk_predicate.py` with the reject tier limited to `Id = Id` self-collapse and
declared-edge wrong-target, everything else warn. Wire into `_validate_candidate`
after the cardinality guard. Extract the shared alias helper. This catches the
reported bug against whatever edges already exist, with the lowest false-reject
risk, and needs no bundle rebuild.

**Phase 2 — Embed the convention edges.** Add `col-eq-pk-suffix` inference in
`joingraph.py` so the correct `<Table>Id → <Table>.Id` edges exist even without
declared FKs. Rebuild the bundle. Now the validator's "supported" set covers the
convention, shrinking the warn set and enabling more confident rejects.

**Phase 3 — Guide upgrades + FK index precompute.** Carry `origin`/`confidence`
into `JoinHint`, render provenance + "referenced-by" blocks
(`prompt.py`), and (optionally) precompute the FK index as an additive
`joingraph.json` block if the runtime projection shows up in profiling.

**Phase 4 — Promote warn→reject from the corpus.** After collecting `fk_warnings`
from real/benchmark traffic, promote the warn categories that prove safe
(e.g. convention-edge contradictions with no legitimate counter-examples) to the
reject tier. Tune `min_confidence` and the reject threshold from data, the same way
`EXPLAIN_CARDINALITY_GUARD.md` tunes its row thresholds.

---

## Test plan (mirrors existing guard tests)

- Unit-test `fk_predicate_guard` against hand-built FK-index dicts (no bundle),
  exactly as `cardinality.py`'s pure helpers are tested (`test_retriever.py`
  pattern): `Id=Id` reject, declared wrong-target reject, inferred wrong-target
  warn, no-edge warn, valid FK pass, self-join pass, composite-key handling,
  literal-filter-not-a-join skip.
- Unit-test `build_inferred_convention_edges`: `Acceptances`+`Monitors.AcceptanceId`
  → edge; irregular plural; no misfire on unrelated column; declared FK de-dupes it.
- Integration: a benchmark question that previously produced the `Id=Id` wrong count
  now rejects and self-repairs to the correct FK join within the repair budget.
