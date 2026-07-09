# Cross-Source Query-Splitting Federation — Research + Prototype

**Status:** Prototype validated end-to-end against the real 344M-row staging DB (`CeibaHospitalDB`, PG 15.15, read-only, via SSH tunnel), simulating two backends by attaching it twice under distinct DuckDB aliases.
**Author:** NL→SQL runtime investigation (task #57).
**TL;DR:** For genuine cross-source joins (tables from ≥2 backends in one query), splitting the query into maximal single-backend subtrees, pushing each via `postgres_query()`, materializing into DuckDB temp tables, and running only the residual cross-source join in DuckDB **works and is correct** — validated at **~1.2–1.4s vs a >40s timeout** for the canonical HR query. But plain "maximal subtree" splitting is **not sufficient by itself**: when the selective predicate sits on the *other* side of the cross-source join from a huge unfiltered table, a naive split still pushes an unbounded scan and hangs just like the status quo. The fix — a manual **semi-join**: execute the selective side first, harvest its join keys, inject them as an `IN (...)` predicate into the big side's pushdown — is also prototyped and validated (**~4.8–5.5s vs the same timeout**). Both findings are grounded in real timed experiments below, including the failure case reproduced on purpose.

---

## 1. Problem recap

[`DUCKDB_PUSHDOWN.md`](./DUCKDB_PUSHDOWN.md) established that DuckDB's `postgres` scanner pushes filters/projections/LIMIT to the remote Postgres but **not aggregates or joins** — each attached table is scanned independently and joined locally in DuckDB. For the canonical query ("patients with HR>120 in the last 3 hours"), that means the ~58M-row `MonitorMeasurements` scan (filtered only on `MeasurementTypeId=2 AND Value>120`, since the actually-selective time filter lives on a *different* table, `Monitors`) streams across the wire and the query times out.

That doc's **Fix A** (route single-source queries to `postgres_query()` passthrough) solves this when every table in the query belongs to one backend — validated at 762ms. It does **nothing** for a genuine multi-backend query, because `postgres_query()` executes one SQL string against exactly one attached source; it cannot itself span two attachments.

This document researches and prototypes the missing piece: **what do we do when the tables genuinely live on two different backends?**

---

## 2. Design: the query splitter

### 2.1 Algorithm

1. **Parse** the LLM-generated (DuckDB-dialect, catalog-qualified) SQL with `sqlglot`.
2. **Tag** every table reference with a backend. In the real system this is the DuckDB ATTACH alias already present as the table's catalog qualifier (`staging.Shared.X` → backend `staging`) — the generated SQL is already catalog-qualified per `DUCKDB_PUSHDOWN.md` Fix A, so **the SQL text itself is the authoritative backend tag**; no side channel is needed.
3. **Partition** the FROM/JOIN table list into maximal single-backend components via **union-find over the join graph**: two tables merge into the same component iff (a) a join predicate directly connects them **and** (b) they belong to the same backend. This is the "maximal single-source subtree, split at the node closest to the root" framing from the brief, specialized to the flat FROM/JOIN chains the pipeline actually generates (no nested subqueries in the benchmark workload).
4. **If exactly one backend** is referenced overall: no split needed, whole query via `postgres_query()` (Fix A, unchanged).
5. **If more than one backend:** for each single-backend component,
   a. Build a standalone `SELECT` containing exactly that component's tables/joins, projecting every column the *rest* of the query needs (aliased `"<table_alias>__<column>"` to avoid cross-table collisions), and carrying every WHERE-conjunct that references *only* that component's aliases (predicate pushdown into the native query).
   b. Execute it via `postgres_query('<backend_alias>', '<native SQL>')` and materialize the result into a DuckDB `TEMP TABLE`.
   c. **Rewrite** the original tree in place: drop the component's JOIN nodes, replace `alias.col` references throughout the tree (SELECT list, WHERE, GROUP BY, ORDER BY, and any join ON conditions) with `temp_alias.alias__col`, and point the FROM/JOIN topology at the materialized temp table.
   d. Any join ON-condition that connects this component to *another*, not-yet-materialized component ("the cross-component join edge") is **salvaged into the residual WHERE** rather than dropped — this is essential; see §4.1 for the bug this fixes.
6. Execute the now-fully-local **residual** query (a join of temp tables) in DuckDB.

### 2.2 Tree/rewrite mechanics

The two structural primitives:
- **`splitter.partition_by_backend`** — the union-find partitioning (§2.1 step 3).
- **`executor._build_pushdown_sql`** / **`executor._rewrite_component_as_temp_table`** — build each component's native-dialect pushdown SQL, and mutate the original `sqlglot` tree to reference the materialized temp table instead of the original tables.

One correctness subtlety, found and fixed during prototyping (not obvious from the design brief): a join whose *introduced table* belongs to the component being materialized, but whose **ON-condition also reaches into another component**, is the cross-component join edge itself. The naive implementation dropped this join (and its predicate) entirely when removing the component's JOINs from the tree — silently turning the join into an unconstrained cross join. Fixed by salvaging that ON-condition into the residual WHERE (after the same alias→temp-table column rewrite) before discarding the join node. Caught by the first end-to-end run: the residual came back as `21` before the fix... no — it came back as **6,465** (a cartesian-style over-count) instead of the correct **21**; the fix made it exact. See §4.1.

---

## 3. Prototype

**Location:** `/private/tmp/claude-501/-Users-egeapak-Projects-ceiba-ceiba-data-ai-explorer/04d41914-3cc2-41b9-a809-c17297eecc1b/scratchpad/query_splitter/` (scratch dir; not copied into the repo).

| File | Role |
|---|---|
| `splitter.py` | Table→backend tagging, union-find join-graph partitioning into maximal single-backend components. |
| `executor.py` | Builds each component's native pushdown SQL (column-need analysis, predicate pushdown, catalog-qualifier stripping, `identify=True` case-preserving quoting), materializes via `postgres_query()` into a DuckDB temp table, rewrites the tree. |
| `run_split.py` | Top-level `split_and_execute(sql, con)` orchestration + single-backend passthrough fast path; instrumented `SplitStats` (per-pushdown rows/ms, residual sql/ms, total ms). |
| `semijoin.py` | The selectivity-aware variant: `find_cross_component_edges`, native-Postgres `EXPLAIN`-based row estimation for component ordering, `split_and_execute_semijoin` (harvest-and-inject IN-list). |
| `exp1_baseline.py` … `exp6_collision_and_types.py` | The six experiments below. |

**How to run:** each `expN_*.py` is a standalone script; set `PGDSN` to the staging libpq DSN and run with the repo's `prep/.venv` Python (has `duckdb`, `psycopg`, `sqlglot`). E.g. `PGDSN='...' /path/to/prep/.venv/bin/python exp2_split.py`.

**Scope / non-goals (documented honestly, not hidden):** this is a research prototype tuned to the query shapes the pipeline actually generates — a single `SELECT` with a flat `FROM` + N `JOIN`s, simple comparison predicates in `WHERE`, `GROUP BY`/aggregates, `DISTINCT`, `LIMIT`. It does **not** handle CTEs, set operations, window functions, or (demonstrated in §4.3) correlated subqueries.

---

## 4. Experimental results

All experiments ran against the real staging Postgres (`CeibaHospitalDB`), simulating two backends by `ATTACH`ing it twice under aliases `db_a` / `db_b`, with tables assigned to one or the other per experiment. Correct answer for the canonical query throughout: **21 patients**.

### 4.1 Naive federation baseline (status quo, now cross-backend) — exp1

Backends: `db_a` = `MonitorMeasurements`+`Monitors`, `db_b` = `Acceptances`. `EXPLAIN` confirms DuckDB builds the same independent-scan hash-join tree as the single-catalog case in `DUCKDB_PUSHDOWN.md` §4.2 (~58.2M-row `MonitorMeasurements` scan feeding a local `HASH_JOIN`), regardless of the two tables being under different attach aliases:

```
RESULT: TIMEOUT (>40.0s)
```

Confirms the pathology is identical whether the two tables are in one attached catalog or two — DuckDB's federation model doesn't distinguish.

### 4.2 Plain split (maximal single-backend subtrees) — exp2

Same backend split as above. The splitter correctly partitions into `{mm, mo}` (`db_a`) and `{a}` (`db_b`):

```
pushdown -> db_a: 2843 rows in 764.6ms   (MonitorMeasurements ⋈ Monitors, time+value filtered)
pushdown -> db_b: 9466 rows in 452.7ms   (all of Acceptances — no pushable predicate here)
residual sql: SELECT COUNT(DISTINCT _split_tmp_2_a.a__PatientId) AS n
              FROM _split_tmp_1 AS _split_tmp_1_a
              CROSS JOIN _split_tmp_2 AS _split_tmp_2_a
              WHERE _split_tmp_1_a.mo__AcceptanceId = _split_tmp_2_a.a__Id
residual ms: 10.5
total ms: 1227.9
result: [(21,)]
```

**Correct (21) in ~1.2s vs a >40s timeout.** Reproduced twice (1227.9ms and 1416.7ms across runs); result stable.

Before the ON-condition-salvage fix (§2.2), the same query returned **6,465** — the cross-component join predicate `mo.AcceptanceId = a.Id` was silently dropped when its JOIN node was discarded, degrading the residual to an unconstrained `CROSS JOIN` with no WHERE at all. This is exactly the class of silent-correctness bug the design brief warns is a "hard problem" (predicates spanning the component boundary) — encountered for real, not hypothetically, on the very first end-to-end run.

### 4.3 The semi-join failure case (the hard part) — exp3, exp4

**exp3 — reproducing the failure.** Deliberately place the boundary so the selective predicate is on the *other* side: `db_a` = `MonitorMeasurements` alone (filter: `MeasurementTypeId=2 AND Value>120`, no time bound — matches ~58M rows), `db_b` = `Monitors`+`Acceptances` (filter: `MeasuredDate >= now()-3h`, ~3,862 rows). The splitter correctly identifies the components:

```
component mm: aliases={'mm'} backend=db_a
component a:  aliases={'mo', 'a'} backend=db_b

db_a (weak-filter) pushdown SQL:
  SELECT ... FROM "Shared"."MonitorMeasurements" AS "mm"
  WHERE "mm"."MeasurementTypeId" = 2 AND "mm"."Value" > 120

Materializing db_a component (expect ~58M rows, SLOW)...
TIMEOUT materializing db_a's naive component after 20s -- interrupting
```

**Confirmed: plain "maximal single-source subtree" splitting is not sufficient.** The split-point selection is syntactically correct (this genuinely is the maximal single-backend subtree containing `mm`), but it ships an unbounded ~58M-row pushdown because the predicate that would have constrained it lives in a sibling component. This is precisely the scenario the design brief anticipated and asked to be demonstrated — reproduced here on purpose, with a real 20s+ hang as evidence.

**exp4 — the semi-join fix.** Same pathological backend split. `semijoin.py`'s `split_and_execute_semijoin`:
1. Builds each component's *base* pushdown SQL (no extra predicate yet).
2. Gets a row estimate for each via a **native Postgres `EXPLAIN (FORMAT JSON)`** on that pushdown SQL (no `ANALYZE` — reuses the same safe, timeout-bounded, read-only probe pattern as `guard/explain_estimate.py`).
3. Executes components in **ascending estimate order**.
4. Before pushing any component that shares a cross-component join edge with an **already-materialized** component, harvests that component's distinct join-key values from its DuckDB temp table and injects `<col> IN (<keys>)` into the not-yet-pushed component's SQL.

```
estimates: {'mm': 2741875.0, 'mo': 9182.0}
pushdown -> db_b: 75878 rows in 1244.1ms
  SELECT ... FROM "Shared"."Monitors" AS "mo" JOIN "Shared"."Acceptances" AS "a" ON ...
  WHERE "mo"."MeasuredDate" >= NOW() - INTERVAL '3 HOURS'
pushdown -> db_a: 2961 rows in 1295.6ms
  SELECT ... FROM "Shared"."MonitorMeasurements" AS "mm"
  WHERE "mm"."MeasurementTypeId" = 2 AND "mm"."Value" > 120
    AND "mm"."DeviceId" IN (223658348, 223658351, ... /* ~2,700+ ids */)
residual sql: SELECT COUNT(DISTINCT _split_tmp_1_a.a__PatientId) AS n
              FROM _split_tmp_2 AS _split_tmp_2_a
              CROSS JOIN _split_tmp_1 AS _split_tmp_1_a
              WHERE _split_tmp_2_a.mm__DeviceId = _split_tmp_1_a.mo__Id
residual ms: 5.9-9.9
total ms: 4733.0-5472.8
result: [(21,)]
```

**Correct (21) in ~4.7–5.5s vs a >20s (and, extrapolating from exp1, >40s) timeout.** Reproduced across two runs (4733ms, 4811.9ms, 5472.8ms) — correct every time. Note the EXPLAIN estimate itself is a good ordering signal here: `mo` (join of `Monitors`⋈`Acceptances`, estimate 9,182) correctly sorts before `mm` (estimate 2.74M) — matching the real cardinalities in `DUCKDB_PUSHDOWN.md`'s native-Postgres plan (§4.3: Postgres drives from `Monitors`'s ~3,862-row `MeasuredDate` index scan first).

**Note on the driving estimate:** the harvested-key count (~2,700–2,900 device IDs) is larger than the ~3,862-row `Monitors` estimate might suggest for 1:1 devices, because `Monitors` rows aren't 1:1 with distinct `DeviceId`s over a 3-hour window (repeat readings). The `IN`-list still bounds the `MonitorMeasurements` scan to the actually-relevant device set instead of a full 58M-row unfiltered scan — that bound is what makes the difference between 1.3s and a 20s+ hang for that one pushdown.

**Cost of the fix:** the semi-join path is **slower than the plain split** (4.7–5.5s vs 1.2–1.4s) because it does 2 sequential round trips plus an `EXPLAIN` probe per component, vs 2 *independent* (could be parallelized) pushdowns in the plain-split case. It is only needed when the plain split's split-point placement is bad; see §5 for when to invoke it.

### 4.4 Column-name collisions & type fidelity — exp6

Requested `mm.Id` (bigint) and `mo.Id` (integer) simultaneously, across a 3-way split (`{mm,mo}` on `db_a`, `{a}` on `db_b`), with a `timestamptz` column and a `LIMIT` on the outer query:

```
temp table _split_tmp_1 schema:
  mm__DeviceId  INTEGER
  mm__Id        BIGINT
  mm__MeasurementTypeId INTEGER
  mm__Value     DOUBLE
  mo__AcceptanceId INTEGER
  mo__Id        INTEGER
  mo__MeasuredDate TIMESTAMP WITH TIME ZONE
temp table _split_tmp_2 schema:
  a__Id         INTEGER
```

- **Collisions:** `mm__Id` (BIGINT) and `mo__Id` (INTEGER) coexist without conflict — the `"<alias>__<column>"` projection-aliasing scheme resolves same-named columns across component tables. Confirmed working, not just designed.
- **Type fidelity:** `bigint → BIGINT`, `integer → INTEGER`, `double precision → DOUBLE`, `timestamp with time zone → TIMESTAMP WITH TIME ZONE` all round-tripped through `postgres_query()` → DuckDB `TEMP TABLE` unchanged; the returned Python row carried a correctly tz-aware `datetime` (`tzinfo=<DstTzInfo 'Europe/Istanbul' ...>`).
- **`LIMIT`:** survived untouched through the rewrite (it's outside the FROM/JOIN/WHERE surface the splitter mutates) and applied correctly to the residual (5 rows requested, 5 returned).
- **Identifier casing:** Postgres folds unquoted identifiers to lowercase; this schema is PascalCase (`Shared.MonitorMeasurements`). Pushdown SQL is rendered with `sqlglot`'s `identify=True` so every identifier is quoted and case is preserved — without this, every pushdown would fail to find the (differently-cased) remote objects.

### 4.5 Single-backend recognition (no unnecessary split) — exp5

All three tables under one alias (`db_a`): the splitter correctly takes the `plan: single-backend` fast path (Fix A passthrough, no materialization):

```
plan: single-backend
pushdown -> db_a: 1 rows in 689.3ms
total ms: 728.7
result: [(21,)]
```

---

## 5. Hard problems & how they were handled

1. **Split-point selection can still be catastrophic (§4.3).** A syntactically-maximal single-backend subtree is not the same as a *cheap* one. **Handled** via the semi-join fix: order components by a native-Postgres `EXPLAIN` row estimate (reusing `guard/explain_estimate.py`'s safe, no-ANALYZE, timeout-bounded probe pattern) and drive from the smallest, injecting its keys into siblings before they're pushed. This is the single highest-value optimization demonstrated (turns a 20s+/40s+ hang into ~5s).

2. **Predicates spanning the component boundary.** A join ON-condition connecting two different components must not be discarded when its introducing JOIN node is removed — it has to be salvaged into the residual WHERE (after the column rewrite retargets it at the materialized temp table). **Handled**, but only after it produced a real silent-wrong-answer bug on the first end-to-end run (§4.1: 6,465 instead of 21). This is worth over-emphasizing for the real implementation: a correctness bug here is *silent* — the query still returns a number, just the wrong one. Any production version of this needs either an assertion that every original join predicate has a live home in the rewritten tree, or a differential check against a reference plan in tests.

3. **Correlated subqueries.** Explicitly **not handled**, and confirmed to fail *silently* rather than loudly: an `EXISTS (SELECT ... WHERE mo.AcceptanceId = a.Id AND mm.Value > 120)` correlated subquery's inner tables (`mo`, `mm`) are invisible to `_find_from_tables` (which only walks the outer `SELECT`'s `FROM`/`JOIN`s), so the splitter would treat the query as single-component (just the outer table `a`) and push an **incomplete** query — the correlation predicate is silently dropped rather than erroring. Any production integration must either (a) detect subqueries/CTEs up front and fall back to the (slow but correct) naive federated path, or (b) recursively apply the same splitting algorithm to each nested `SELECT` — out of scope for this prototype, flagged as a follow-on design task.

4. **Column-name collisions when materializing.** **Handled** and verified (§4.4) via `"<table_alias>__<column>"` projection aliasing.

5. **Temp-table naming/lifecycle.** Prototype uses a module-global incrementing counter (`_split_tmp_N`) and DuckDB `TEMP TABLE`, which is connection-scoped and auto-cleaned on `close()`/`dispose()`. A production version needs this to be **per-query-execution** scoped (not a shared global counter — concurrent requests on one `DuckDbEngine` instance would collide) and should explicitly `DROP TABLE` each temp table after the residual executes (or after the result is fully materialized to the caller) rather than relying on connection lifetime, since `DuckDbEngine` is long-lived (one instance, many queries) per `duckdb_engine.py`'s design.

6. **Type fidelity across the round trip.** **Handled** and verified (§4.4) — Postgres → `postgres_query()` → DuckDB temp table preserves bigint/integer/double/timestamptz faithfully.

7. **Case-sensitive identifiers.** **Handled**: `sqlglot`'s `identify=True` on the postgres-dialect render, consistent with the existing `guard/explain_estimate.py` transpile convention (strip the DuckDB catalog-alias segment; here we additionally force full quoting).

8. **Cost/row-count driven ordering.** **Handled** by reusing the existing EXPLAIN cardinality machinery (§4.3) — no new estimation mechanism was built; this ties directly into the repo's existing `guard/explain_estimate.py`.

---

## 6. When splitting is (and isn't) worth it — heuristic

| Situation | Recommended path |
|---|---|
| All referenced tables share one backend | **Fix A** — whole-query `postgres_query()` passthrough. No splitting logic engages at all (validated: 689–762ms). |
| ≥2 backends, but each component's pushdown has its own strong local filter (both sides small/selective independently) | **Plain split** (§4.2) — two (parallelizable) pushdowns + a cheap local join of small materialized results. ~1.2–1.4s validated. Do not pay for the semi-join machinery (extra EXPLAIN round trip, sequential ordering) when it isn't needed. |
| ≥2 backends, and at least one component's pushdown is unselective (its filtering predicate lives in a sibling component) | **Semi-join split** (§4.3/4.4) required — plain split hangs (20s+ demonstrated). Detect via the same EXPLAIN estimate already computed for ordering: if any component's *base* (pre-injection) estimate exceeds the existing cardinality-guard thresholds (`SCAN_WARN_ROWS` / `SCAN_REJECT_ABS_ROWS` in `guard/explain_estimate.py`), route it through the harvest-and-inject path instead of a bare pushdown. |
| Query contains correlated subqueries / CTEs / set ops the splitter doesn't parse for table discovery | **Fall back to naive federated execution** (status quo) or reject with a repair hint — do NOT silently push an incomplete split (§5.3). |
| Cross-source join has no equi-join predicate the splitter can extract (e.g., only an inequality or a computed expression) | No semi-join key to inject; fall back to plain split (both full components materialized) or naive federation, whichever is estimated cheaper. |

In short: **always split when >1 backend is referenced** (never worse than plain federation, and typically far better); **add the semi-join ordering step whenever the EXPLAIN estimate flags an unselective component** — which is exactly the existing cardinality-guard signal, so no new instrumentation is needed to decide.

---

## 7. Comparison to Trino

`DUCKDB_PUSHDOWN.md` §6 already scoped this; restated with the new evidence:

- **Trino's dynamic filtering** does automatically, at the engine level, exactly what §4.3/4.4's semi-join fix does by hand: build a filter from the build side of a join and push it to the probe side's connector *during* execution, without a human choosing split points or writing IN-lists. It also does cost-based join reordering across connectors natively.
- **What we hand-rolled here is a special case of that**, scoped to the specific join shapes (`sqlglot`-parseable flat FROM/JOIN chains) the pipeline actually generates. It cost real engineering (§5.2's silent-bug risk, §5.3's correlated-subquery gap) to get right even for that narrow scope.
- **Recommendation stands:** hand-rolled splitting is the right call *now* — it required zero new infrastructure (no coordinator/workers/JVM), reuses the DuckDB connection and the existing EXPLAIN-guard machinery, and the validated numbers (1.2s plain split, ~5s semi-join) comfortably beat the >40s timeout for the actual current workload (which is dominated by single-source queries per `DUCKDB_PUSHDOWN.md`, with cross-source joins the exception). Adopt Trino when: (a) correlated-subquery / CTE cross-source queries become common (§5.3 is unsolved by hand-rolling without materially more engineering), (b) more than two real backends are joined routinely (the union-find generalizes, but the semi-join ordering degenerates to needing a real query optimizer once there are >2-3 components with interdependent selectivity), or (c) join patterns diversify beyond what a flat FROM/JOIN `sqlglot` walk can discover.

---

## 8. Recommendation + phased integration path

**Recommendation:** adopt the plain split (§2, §4.2) as the default cross-source path once task #48 (Fix A single-source routing) ships, since it shares the same `postgres_query()` mechanism and catalog-qualifier-stripping convention. Add the semi-join ordering (§4.3/4.4) as a second phase gated by the existing EXPLAIN-guard thresholds — it's more code and slower per-query, so it should only engage when the guard flags an unselective component, not unconditionally.

**Phased path into the real engine:**

1. **Phase 1 — plain split, opt-in on a feature flag.**
   - `engine/duckdb_engine.py`: add a `run_split(sql, table_backend_map)` method alongside the `run_native()` path from Fix A (`postgres_query()` is already the primitive both need). Port `splitter.partition_by_backend` + `executor._build_pushdown_sql`/`_rewrite_component_as_temp_table` — these are the tree-mechanics core and are dialect-agnostic (they only depend on `sqlglot`, already a dependency).
   - `generation/pipeline.py`: extend the existing single-source detection (task #48) to also detect the *count of distinct backends* from the retrieved bundle's per-table `source_id` (already available — this is literally the same signal Fix A uses, just checked for `>1` instead of `==1`).
   - **Correctness gate before shipping:** add the assertion from §5.2 — every column/join-predicate alias in the original parsed tree must have a corresponding reference in the rewritten tree (no silently-dropped predicates). Given how easily this broke in the prototype, treat it as a hard release blocker, not a nice-to-have.
   - Fix temp-table lifecycle (§5.5) to be per-execution-scoped with explicit cleanup, not a module/connection-global counter.

2. **Phase 2 — semi-join ordering, gated by the existing cardinality guard.**
   - Wire `semijoin.estimate_via_native_explain` in as an extra call site of the *already-implemented* `guard/explain_estimate.py::pg_explain_estimate` (same probe, reused, not reinvented) per component's base pushdown SQL.
   - If any component's estimate exceeds `SCAN_WARN_ROWS`, route through harvest-and-inject before materializing; otherwise take the cheaper plain-split path.

3. **Phase 3 — fall back safety net for unsupported shapes.**
   - Before attempting any split, check for `exp.Subquery`/CTEs/set-ops in the parsed tree (the gap identified in §5.3); if present, skip splitting and go straight to the naive federated path (current status quo — slow but at least not silently wrong) or reject with a repair hint via the existing guard vocabulary (`pass`/`repair`/`reject`/`defer`).

4. **Trino** only if/when §7's adoption triggers are actually observed in production query patterns.

Prototype code remains at the scratch path listed in §3 for reference; nothing from it was copied into the repo.
