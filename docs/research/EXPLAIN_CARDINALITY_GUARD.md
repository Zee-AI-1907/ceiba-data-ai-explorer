# EXPLAIN-Estimate Cardinality Guard — Research & Recommendation

> **Question.** Should the NL→SQL system replace (or augment) its current *syntactic*
> cardinality guard (`ceiba_nl2sql/guard/cardinality.py`) with the database
> optimizer's own **EXPLAIN estimate** — running `EXPLAIN` (never `ANALYZE`) on the
> already-read-only-guarded candidate SQL and rejecting/repairing when the estimated
> scanned rows are enormous?
>
> **The user's intuition to test.** "The estimate might be UNDER-represented but rarely
> over-represented" — i.e. optimizer row estimates skew *low*, which is the safe
> direction for an availability guard: if even the optimistic estimate is huge, the
> real cost is *definitely* huge (confident reject); a low estimate that's actually a
> bit higher is a tolerable miss.
>
> **TL;DR verdict.** The intuition is *correct about optimizers in general* and *correct
> for Postgres*, but it does **not** hold for the layer this system currently plans on.
> **DuckDB's EXPLAIN over the attached-Postgres foreign scan does NOT reflect the
> pushed-down filter** — it reports (roughly) the *full* table cardinality regardless of
> the `WHERE`, computed from Postgres page counts. So a DuckDB-side EXPLAIN estimate is
> **useless as a selectivity signal** for exactly the tables this guard exists to
> protect. **The idea is sound, but it must be implemented against the Postgres side**
> (`EXPLAIN (FORMAT JSON)` over the read-only staging DSN), whose per-node `Plan Rows`
> *does* reflect `pg_statistic`-based selectivity. Recommendation: **augment, not
> replace** — keep the cheap syntactic pre-check, make the **Postgres-side scan-node
> estimate** the authoritative signal, and **fail closed** on the large tables.

---

## 0. Context recap (verified against the code, not assumed)

- `guard/cardinality.py` is a **syntactic** guard. For each `is_large_time_series` table
  it requires a selective predicate — (a) a time-bound on the table's own time column,
  (b) a selective equality/IN on an indexed/FK/PK column, or (c) a parent-join time
  bound via `time_via`. Otherwise → `reject`. It is admittedly brittle: it had to
  enumerate predicate *shapes* (`_COMPARISON_TYPES`, JOIN-ON-vs-WHERE discrimination,
  CAST unwrapping, alias resolution, comma-join equivalence) and just absorbed a batch
  of false-negative fixes. It cannot see *multiplicative* blow-ups (a cartesian/fan-out
  join where every table is individually "bounded" but the join product is billions).
- `engine/duckdb_engine.py` already has `explain(sql)` that runs `EXPLAIN <sql>` and
  returns `{ok, plan}` / `{ok:false, error}` — used today only for *validation* (does it
  parse/bind). It runs against DuckDB with **`ATTACH … READ_ONLY`** Postgres sources
  (`staging`, `mock`), hardened with `enable_external_access=false` +
  `lock_configuration=true`.
- The huge tables — `Shared.MonitorMeasurements` (~337M), `Shared.VentilatorMeasurements`
  (~271M), `Shared.Monitors` (~60M) — live in the **attached Postgres**, scanned *through*
  DuckDB's `postgres` scanner. This federation topology is the crux of the whole analysis.

---

## 1. Does the estimate exist, and how do we get it — for BOTH engines in play?

### 1a. DuckDB (native)

- `EXPLAIN <sql>` (no `ANALYZE`) **does** expose an estimated cardinality per operator
  **without executing** the query. The estimate comes from base-table statistics +
  per-operator heuristics; only `EXPLAIN ANALYZE` *runs* the query. ([DuckDB EXPLAIN][ex],
  [DuckDB profiling][prof], [duckdb#10523][10523])
- **Machine-readable form:** `EXPLAIN (FORMAT json) <sql>` returns a JSON tree whose nodes
  carry `name`, `children`, and an `extra_info` object with an **`"Estimated Cardinality"`**
  string field. ([duckdb#9928][9928], [duckdb metrics/output][metrics]) (Historically the
  JSON *EXPLAIN ANALYZE* output was missing EC — irrelevant here, we never run ANALYZE.)
- **`EXPLAIN ANALYZE` is disqualified outright**: it executes the statement. On a 337M-row
  table that is precisely the catastrophic scan the guard exists to prevent. Use plain
  `EXPLAIN` only.

### 1b. The make-or-break subtlety — DuckDB's estimate over the Postgres foreign scan

This is where the elegant idea meets reality. **How does DuckDB estimate the cardinality
of a `postgres_scan` (the attached-Postgres table)?**

From the `duckdb-postgres` extension source, the table function's cardinality callback
`PostgresScanCardinality` computes:

```cpp
// src/postgres_scanner.cpp  (PostgresScanCardinality)
auto row_size          = ROW_META_DATA_SIZE + bind_data.types.size() * 8; // ~8 B/col heuristic
auto rows_per_page     = MaxValue<idx_t>(1, POSTGRES_PAGE_SIZE / row_size);
auto estimated_cardinality = bind_data.pages_approx * rows_per_page;       // pages × rows/page
return make_uniq<NodeStatistics>(estimated_cardinality);
```

Two decisive facts fall out of that code:

1. **It is a *page-count* estimate.** `pages_approx` comes from Postgres `pg_class.relpages`
   (a cheap metadata read, no scan), multiplied by a *fixed* rows-per-page heuristic
   (8 bytes/column assumption). It is a rough proxy for the *full* table row count.
   ([DuckDB postgres scanner blog][scanner] confirms `relpages`/`pg_class` is the source
   and "is merely an estimate".)
2. **It does NOT reflect the pushed-down filter.** The cardinality is a pure function of
   `pages_approx` and column count. The `WHERE` predicate — even when DuckDB pushes it down
   to Postgres via `filter_pushdown` — never enters this calculation. DuckDB's own
   selection-pushdown moves the *filter* to Postgres for *execution*, but the *planning-time
   cardinality* DuckDB reports for the scan node is still ≈ the full table.

**Consequence:** For `SELECT … FROM Shared."MonitorMeasurements" WHERE "RecordedAt" >= now()
- INTERVAL '1 hour'`, DuckDB's `EXPLAIN` "Estimated Cardinality" on the postgres-scan node
will be ~337M **whether or not the time filter is present**. It cannot distinguish the
bounded query from the unbounded one. That is the *entire* signal the guard needs, and
DuckDB throws it away for foreign scans.

> **Verdict on the DuckDB layer:** the DuckDB-side EXPLAIN estimate is **unreliable as a
> selectivity guard for the attached-Postgres tables** — the exact tables in scope. It is
> still useful for *pure-DuckDB* cardinality effects (a cartesian join of two federated
> scans multiplies the two full-table estimates — see §1d), but not for post-filter
> selectivity. **Do not gate the big tables on the DuckDB estimate.**

### 1c. The Postgres layer — this is where the idea actually works

Run `EXPLAIN (FORMAT JSON) <sql>` **on the Postgres side**, against the real read-only
staging DSN, **without `ANALYZE`**. Postgres:

- **Never executes** the query when `ANALYZE` is omitted — it only plans. Confirmed
  empirically below: the JSON has no `"Actual Rows"` key. Safe on 337M rows.
- Produces per-node **`"Plan Rows"`** derived from **`pg_statistic`** (histograms, MCVs,
  n_distinct) — so it **does** reflect the pushed-down filter's selectivity.
  ([PG EXPLAIN][pgex], [PG row-estimation examples][pgrow], [pgMustard][pgm])

**Empirical confirmation (live, read-only, against the OrbStack mock Postgres 16 that
mirrors the staging schema — `public."MeasurementsMock"`, 483 rows, 40 distinct patients,
7-day `RecordedAt` span):**

| Query | Scan node | `Plan Rows` | Interpretation |
|---|---|---|---|
| `SELECT * FROM M` (full) | Seq Scan | **483** | baseline = full table estimate |
| `… WHERE "patientRef" = 1` | Seq Scan | **13** | equality selectivity from `pg_statistic` |
| `… WHERE "RecordedAt" >= now()-INTERVAL '1 day'` | **Index Scan** | **42** | time-bound selectivity (chose the index) |
| `SELECT * FROM M LIMIT 10` | Limit→**Seq Scan** | Limit=10, **Seq Scan=483** | **LIMIT masks the scan cost** |
| `SELECT * FROM M a, M b` (cartesian) | Nested Loop | **233,289** | = 483² — multiplicative blow-up caught |
| any of the above (no `ANALYZE`) | — | `"Actual Rows"` key absent | **proves no execution** |

Every load-bearing claim holds on real Postgres: the estimate exists, reflects the filter,
is derived from statistics, catches join blow-ups, and — critically — **the inner scan-node
estimate ignores the outer `LIMIT`** (see §3).

### 1d. Recommendation for question 1

**Explain on the Postgres layer.** The DuckDB layer's foreign-scan estimate is
filter-blind and therefore worthless as the selectivity signal. A *belt-and-suspenders*
DuckDB EXPLAIN can still catch pure-DuckDB cartesian blow-ups (two federated scans joined
with no condition → 337M × 271M in the DuckDB estimate), but the **authoritative** guard
must read Postgres `Plan Rows`.

---

## 2. Estimate reliability, and the user's under/over intuition

**The intuition is right in general and right for Postgres.** The canonical result is
Leis et al., *"How Good Are Query Optimizers, Really?"* (VLDB 2016) and its 2017 VLDBJ
extension:

- Cardinality estimation is the dominant error source (cost model contributes ≤~30% error;
  cardinality errors span *many orders of magnitude*). ([Leis 2016][leis], [Leis 2017][leis2])
- Errors are **predominantly one-sided: systematic UNDER-estimation**, and the
  **underestimation grows with the number of joins** — because optimizers assume predicate
  and join-key independence, and real data is correlated ("no system was able to detect
  join-crossing correlations"; errors of factor 1000+ are common). ([Leis 2016][leis])
- **Single-table selection estimates are substantially more accurate** than multi-join
  estimates. This matters a lot: the primary guard target — a `WHERE` filter on ONE big
  table — is exactly the *accurate* regime. The dangerous regime (multi-join
  underestimation) is the one where the guard must be *conservative*.

**What this means for a threshold guard ("reject if estimated scan rows > N"):**

- A **huge estimate is reliably huge** → *confident reject.* If the optimizer (which skews
  low) *still* says 337M rows, the truth is ≥ that. This is the direction the user
  identified, and it is exactly why the guard is sound.
- A **small estimate MIGHT be wrong-low** (correlated multi-join underestimate) → a small
  estimate does **not** guarantee a small real scan. So the guard is **strong at catching
  definitely-bad queries, weaker at *certifying* a query is truly small.**

**Is that asymmetry acceptable?** Yes — *for an availability guard.* Its job is to stop
*catastrophic* scans of 100M+ row tables, not to be an exact cost oracle. A guard that
never lets through a query the optimizer *knows* is enormous, and occasionally lets through
a query the optimizer under-estimated (which then hits the engine's **execution deadline**
+ **`max_rows` clamp** in `duckdb_engine.execute()` — the real backstop), is a good guard.
The deadline/row-cap is the safety net for the under-estimated tail; EXPLAIN is the
cheap up-front filter for the obvious catastrophes. **Defense in depth, not a single
oracle.**

> One caveat on "rarely over-represented": Postgres *can* over-estimate too (stale
> `pg_statistic` after bulk loads, default selectivity `0.005`/`0.0033` for un-analyzed or
> opaque predicates, functional/expression predicates it can't reason about). Over-estimates
> only cause **false rejects** (a genuinely-small query blocked) — annoying, not dangerous,
> and repairable by the self-repair loop. The dangerous direction (under-estimate → false
> accept) is the rarer one, per Leis. Net: the error asymmetry *favors* the guard.

---

## 3. Threshold & policy design

**Read the SCAN-node estimate on the big tables, not the top-level row estimate.** This is
the single most important design rule, and the empirical table in §1c proves why:
`SELECT * FROM M LIMIT 10` reports **top-level `Plan Rows` = 10** but the inner **Seq Scan
`Plan Rows` = 483**. A `LIMIT` bounds *output* rows, not *scanned* rows; Postgres applies
it as a `Limit` node *above* the scan. On the real tables, `… FROM MonitorMeasurements
LIMIT 1000` would show a top-level 1000 and an inner scan estimate of ~337M. **Gating on the
top-level estimate would be trivially defeated by any `LIMIT`** — precisely the "a LIMIT
after a full scan still scans" hazard the current guard's Fix-C hardening already worries
about. So:

- Walk the JSON plan tree; for each node whose `Relation Name` (or the
  `postgres_scan`/scan target) is one of the configured large tables, read that node's
  **`Plan Rows`** (and optionally `Total Cost`).
- Also read the **root** `Plan Rows` to catch join fan-out/cartesian blow-ups (the
  cartesian test showed 233,289 = 483² at the Nested Loop root even though each leaf scan
  was small).

**Threshold — hybrid absolute + per-table, applied to the SCAN node:**

- Recommended policy per large-table scan node:
  - `Plan Rows` ≤ **`SCAN_WARN` (e.g. 1M)** → **pass** (the filter is doing its job).
  - `SCAN_WARN` < `Plan Rows` ≤ **`SCAN_REJECT` (e.g. 10M)** → **repair** (feed the estimate
    back to the self-repair loop: "your scan of MonitorMeasurements is estimated at N rows;
    add a tighter time bound / patient scope").
  - `Plan Rows` > `SCAN_REJECT` → **reject** (unbounded/near-full scan; not silently
    repairable — the correct window is a business decision).
- Prefer **relative-to-table-size** over a single global absolute, because the tables span
  337M → 22K. A good formulation: reject if `scan_est > max(SCAN_REJECT_ABS,
  FRACTION × table_reltuples)` — e.g. `FRACTION = 0.10` means "reading >10% of a 337M-row
  table (>33.7M rows) is rejected regardless of the absolute floor". This auto-scales:
  it's strict on the giants and lenient on `ICD10s`. `table_reltuples` is already cheap to
  read from `pg_class` (or is implicit in the full-scan `Plan Rows`).
- **Root-estimate blow-up guard:** reject if the **root** `Plan Rows` exceeds a separate
  cap (e.g. **`JOIN_BLOWUP_REJECT = 50M`**) even if each individual scan is bounded — this
  is the multiplicative-fan-out case the syntactic guard is *blind* to and the biggest
  win of the EXPLAIN approach.

Tune the three constants against the eval harness (§7). `Total Cost` can be a secondary
signal but is unit-less across configs; `Plan Rows` is the interpretable primary.

---

## 4. Replace vs augment the syntactic guard?

**Augment — defense in depth. Do not delete the syntactic guard.** Rationale:

1. **They catch different failure classes.**
   - Syntactic guard: "does a selective predicate of a *recognized shape* exist?" — cheap,
     no DB round-trip, no dependency on statistics freshness. Blind to selectivity *value*
     and to join fan-out.
   - EXPLAIN guard: "what does the optimizer *estimate* the scan/result to be?" — sees real
     selectivity and multiplicative blow-ups, but depends on a live DB, `pg_statistic`
     freshness, and a round-trip.
2. **Ranked authority:** make the **Postgres EXPLAIN scan-node estimate the authoritative
   signal** and demote the syntactic check to a **cheap pre-filter / fallback**:
   - Run the syntactic guard first (in-process, ~free). If it *rejects*, you can short-circuit
     and skip the round-trip (a query with literally no bound is going to lose anyway) — or
     still EXPLAIN to produce a better repair hint. If it *passes/repairs*, proceed to EXPLAIN
     for the authoritative decision.
   - EXPLAIN can **overturn a syntactic pass** (query had a "selective" equality on a column
     that turns out non-selective → 200M-row estimate → reject). EXPLAIN can also **rescue a
     syntactic reject** into a pass *only if you trust the estimate* — recommended **not** to
     let EXPLAIN silently override a syntactic reject on the big tables (keep the strict
     conjunction there; see fail-closed below).
3. **Fail-open vs fail-closed when EXPLAIN is unavailable/errors:**
   - If `explain()` returns `{ok:false}` (planner error, DSN down, timeout) → **fail CLOSED
     for the large tables** (fall back to the syntactic verdict, and if the syntactic guard
     also can't confirm a bound, reject). An availability guard that fails *open* on the
     337M-row table defeats its own purpose. For queries touching *no* large table, failing
     open (pass) is fine.
   - This is exactly the posture the current guard already takes on unparseable SQL
     ("fail closed → reject"), so it's consistent with the codebase's existing stance.

---

## 5. Cost & latency

- `EXPLAIN` **without `ANALYZE` is planning-only** — milliseconds. It is *one extra DB
  round-trip per candidate*, including per self-repair round. For an interactive NL→SQL
  system with a 55s execution budget, a sub-100ms planning round-trip per candidate is
  negligible.
- **Federated-planning caveat:** planning a query that touches the attached Postgres *may*
  probe the foreign side. On the **Postgres-side** EXPLAIN (recommended), the probes are the
  normal planner metadata reads (`pg_class.relpages` recheck, `pg_statistic` lookups) —
  cheap, no table scan (confirmed: no `Actual Rows`, and PG docs note the `relpages` recheck
  is "a cheap operation, not requiring a table scan"). On the **DuckDB-side** EXPLAIN, binding
  the `postgres_scan` opens a connection and reads `pg_class` for `pages_approx` — also cheap,
  but recall it's the wrong signal anyway (§1b).
- **Bound the round-trip:** run the guard EXPLAIN under a short **statement_timeout**
  (e.g. `SET LOCAL statement_timeout = '2s'`) so a pathological planning case can't stall the
  pipeline; on timeout → fail closed (§4).
- **Caching:** the estimate is deterministic for a given SQL string + statistics epoch; a
  small LRU keyed on normalized SQL avoids re-EXPLAINing identical repair candidates.

---

## 6. Safety

- **Neither engine executes the query under EXPLAIN-without-ANALYZE.** Postgres: confirmed
  empirically (`"Actual Rows"` key absent → the executor never ran). DuckDB: `EXPLAIN`
  (no `ANALYZE`) is documented planning-only; **`EXPLAIN ANALYZE` is forbidden** (it runs
  the query) and must never be used by the guard. ([PG EXPLAIN][pgex], [DuckDB EXPLAIN][ex])
- The candidate SQL is already **read-only-guarded** (`sqlGuard`/`guard_sql`) upstream, the
  Postgres connection is `default_transaction_read_only=on` + `SET SESSION … READ ONLY`, and
  the DuckDB attach is `READ_ONLY` + `enable_external_access=false`. EXPLAIN adds no new
  data-touch surface. The only new I/O is planner catalog reads.
- **Do not** wrap the candidate in anything that could execute (no `EXPLAIN ANALYZE`, no
  materialized CTE probing, no `EXPLAIN (ANALYZE, TIMING)`). Plain `EXPLAIN (FORMAT JSON)`
  only.

---

## 7. Concrete recommendation & integration

**Build it. Augment the syntactic guard with a Postgres-side EXPLAIN-estimate guard as the
authoritative signal.** The DuckDB-side estimate is not trustworthy for the federated big
tables and should not be the gate.

### Exact commands

**Authoritative (Postgres side, over the read-only staging DSN):**
```sql
-- one round-trip, planning only, never executes:
EXPLAIN (FORMAT JSON, VERBOSE, COSTS) <candidate_sql>;
```
Wrap the guard call in `SET LOCAL statement_timeout = '2s';` (in the same read-only
transaction). Parse the JSON: recurse the plan tree, and for every node read `Node Type`,
`Relation Name` / scan target, `Plan Rows`, `Total Cost`. Assert no `Actual Rows` key
exists (sanity: proves no ANALYZE slipped in).

**Belt-and-suspenders (DuckDB side, for cartesian/pure-DuckDB blow-ups only):**
```sql
EXPLAIN (FORMAT json) <candidate_sql>;
-- read extra_info["Estimated Cardinality"] at the ROOT node only;
-- treat leaf postgres_scan EC as full-table (NOT a selectivity signal).
```

### Where in the pipeline

- Add a method to the Postgres-facing engine/adaptor (not `DuckDbEngine.explain`, which
  reads the filter-blind foreign-scan estimate) — e.g. a small `pg_explain_estimate(dsn,
  sql) -> PlanEstimate` that opens the read-only staging connection and returns the parsed
  tree. `DuckDbEngine.explain` stays as-is for bind/parse validation.
- In `generation/pipeline.py`, after `guard_sql` (read-only) and the existing
  `cardinality_guard_from_context` (keep it as the cheap pre-check), insert an
  **EXPLAIN-estimate stage**:
  1. Syntactic guard runs first (free). On its `repair`, apply the LIMIT repair as today.
  2. Run `EXPLAIN (FORMAT JSON)` on Postgres. Extract the max scan-node `Plan Rows` over
     the configured large tables + the root `Plan Rows`.
  3. Apply the §3 thresholds → `pass` / `repair` (feed the estimate into the self-repair
     prompt: "estimated to scan N rows of TABLE; tighten the filter") / `reject`.
  4. On EXPLAIN error/timeout → **fail closed for large-table queries** (defer to the
     syntactic verdict; reject if unbounded), fail open otherwise.
- **Compose with existing `time_via`/selective logic:** the syntactic guard already knows
  *which* tables are `is_large_time_series` and their `required_time_column` /
  `parent_time_bound`. Reuse that exact table set to decide *which scan nodes to inspect* in
  the plan and *which* trigger fail-closed. The two guards share configuration; they don't
  duplicate it.

### Robustness ranking vs the current heuristic

| Failure mode | Syntactic guard | Postgres EXPLAIN-estimate guard |
|---|---|---|
| No bound at all on a 337M table | catches (if shape recognized) | catches (estimate ≈ 337M) |
| "Selective" predicate that isn't actually selective (low-cardinality FK) | **misses** (shape looks fine) | **catches** (estimate stays huge) |
| Multiplicative join fan-out / cartesian | **misses** (each table individually bounded) | **catches** (root estimate explodes) |
| Novel predicate shape not enumerated | **misses** (false-negative) | **catches** (statistics don't care about shape) |
| Predicate on an un-analyzed / opaque expression | n/a | may over-estimate → false reject (safe direction) |
| Correlated multi-join under-estimate | n/a | may under-estimate → **false accept** (backstopped by execution deadline + max_rows) |
| DB down / EXPLAIN error | still works (in-process) | fails closed → defers to syntactic |

**Net:** the EXPLAIN-estimate guard is strictly *more robust* on the false-negative axis
(the dangerous one) for every recognized-shape gap that has bitten the syntactic guard,
at the cost of one cheap round-trip and a tolerable false-reject tail. The syntactic guard
remains valuable as a zero-latency, DB-independent pre-check and fail-closed fallback.

---

## Buildable recommendation (one paragraph)

Implement a **Postgres-side `EXPLAIN (FORMAT JSON)` cardinality guard** (no `ANALYZE`, wrapped
in `statement_timeout = 2s`, in the read-only staging transaction). Parse the plan tree and,
for each configured `is_large_time_series` table's **scan node**, read `Plan Rows`; reject if
`scan_est > max(10M, 0.10 × reltuples)`, repair (feed the number to the self-repair loop) if
`> 1M`, else pass; additionally reject if the **root** `Plan Rows` exceeds ~50M (join
fan-out). **Keep** `guard/cardinality.py` as a free syntactic pre-check and as the
**fail-closed fallback** when EXPLAIN is unavailable. **Do not** gate on the DuckDB-layer
estimate for the big tables — `PostgresScanCardinality` computes a page-count, filter-blind
full-table number and cannot tell a bounded query from an unbounded one. The user's
"under-estimates are the safe direction" intuition is correct and is the theoretical
justification (Leis et al.), but it only pays off on the *Postgres* estimate, whose
`Plan Rows` actually reflects `pg_statistic` selectivity — verified live: 483 → 13
(equality) → 42 (time-bound), with the inner scan estimate correctly ignoring an outer
`LIMIT`.

---

## Sources

- DuckDB, [EXPLAIN: Inspect Query Plans][ex] — plain EXPLAIN is planning-only; EC per operator.
- DuckDB, [Profiling][prof] / [EXPLAIN ANALYZE guide][prof2] — ANALYZE *executes*; EC vs actual.
- duckdb#10523, [How EC is calculated][10523] — EXPLAIN (no ANALYZE) shows only estimated EC from base-table stats + heuristics.
- duckdb#9928, [EC in JSON output][9928] & DuckDB [metrics/output formats][metrics] — `extra_info["Estimated Cardinality"]` in `EXPLAIN (FORMAT json)`.
- DuckDB `duckdb-postgres`, `src/postgres_scanner.cpp` `PostgresScanCardinality` — page-count estimate (`pages_approx × rows_per_page`), **filter-blind** ([extension repo][pgext-repo]).
- DuckDB, [Querying Postgres Tables Directly (Postgres scanner)][scanner] — uses `pg_class.relpages`; filter/projection pushdown.
- DuckDB `duckdb-postgres` [Query Optimization (DeepWiki)][dw-opt] / [Data Scanning (DeepWiki)][dw-scan] — filter + LIMIT/OFFSET pushdown; `duckdb_bind_set_cardinality`.
- PostgreSQL docs, [EXPLAIN][pgex] — ANALYZE executes; without it, estimates only.
- PostgreSQL docs, [Row Estimation Examples][pgrow] — `pg_class.relpages`/`reltuples` recheck is cheap (no scan); `pg_statistic`-driven `Plan Rows`.
- pgMustard, [Reading Postgres Query Plans][pgm] — `Plan Rows` (estimate) vs `Actual Rows` (ANALYZE only).
- Leis et al., [*How Good Are Query Optimizers, Really?*][leis] (VLDB 2016) & [VLDBJ 2017 extension][leis2] — systematic one-sided **under-estimation** growing with joins; single-table estimates far more accurate; errors of 1000×+.
- *Empirical, this session:* live `EXPLAIN (FORMAT JSON)` (no ANALYZE) against OrbStack mock Postgres 16 mirroring the staging schema — confirmed filter selectivity in `Plan Rows` (483→13→42), inner scan estimate ignores outer `LIMIT` (Limit=10 / Seq Scan=483), cartesian self-join root estimate = 483² = 233,289, and absence of the `Actual Rows` key (no execution).

[ex]: https://duckdb.org/docs/stable/guides/meta/explain
[prof]: https://duckdb.org/docs/1.0/dev/profiling
[prof2]: https://duckdb.org/docs/current/guides/meta/explain_analyze
[10523]: https://github.com/duckdb/duckdb/issues/10523
[9928]: https://github.com/duckdb/duckdb/issues/9928
[metrics]: https://deepwiki.com/duckdb/duckdb/9.2-metrics-and-output-formats
[scanner]: https://duckdb.org/2022/09/30/postgres-scanner
[pgext-repo]: https://github.com/duckdb/duckdb-postgres
[dw-opt]: https://deepwiki.com/duckdb/duckdb-postgres/4.1-query-optimization
[dw-scan]: https://deepwiki.com/duckdb/duckdb-postgres/2.1-data-scanning
[pgex]: https://www.postgresql.org/docs/current/sql-explain.html
[pgrow]: https://www.postgresql.org/docs/current/row-estimation-examples.html
[pgm]: https://www.pgmustard.com/blog/2018/09/21/reading-postgres-query-plans-for-beginners
[leis]: https://www.vldb.org/pvldb/vol9/p204-leis.pdf
[leis2]: https://15799.courses.cs.cmu.edu/spring2025/papers/13-cardinalities1/leis-vldbj2017.pdf
