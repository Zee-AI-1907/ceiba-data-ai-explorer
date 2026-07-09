# DuckDB Federation Pushdown — Root Cause & Alternatives

**Status:** Research complete, empirically verified against the real 344M-row staging DB (`CeibaHospitalDB`, PG 15.15, read-only, via SSH tunnel).
**Author:** NL→SQL runtime investigation (task #49).
**TL;DR:** DuckDB's `postgres` scanner **does** push filters, projections, and `LIMIT` down to Postgres — that part works. What it does **not** push down is **aggregates and joins**. On our canonical HR query that inversion is fatal: DuckDB filters each table *independently*, streams **~58 million** matching `MonitorMeasurements` rows across the wire, and hash-joins them locally — while native Postgres drives from the tiny `Monitors.MeasuredDate` index and touches only a few thousand rows. Two fixes both validated end-to-end: **(A) route single-source queries to native execution** (762 ms via DuckDB's own `postgres_query()` passthrough, or 1049 ms via psycopg — vs >35 s timeout), and **(B)** keep DuckDB only for genuine cross-source joins, and even there constrain the driving side.

---

## 1. The Problem

The canonical query "patients with HR above 120 in the last 3 hours" is generated correctly by the pipeline. Run natively on Postgres it returns **21 patients in ~1 s** (393 ms warm). Run through the DuckDB federation engine (`ceiba_nl2sql/engine/duckdb_engine.py`) the *identical logical query* **times out past 35 s**. Federation was the last blocker to a working end-to-end system.

We needed to know: *is this a fixable pushdown-configuration issue, or a fundamental limit of DuckDB's postgres scanner?* And if fundamental — what are the alternatives, given we genuinely need cross-DB queries where filters must be pushed as far as possible?

---

## 2. Method

All probes ran read-only against the real staging DB. No PHI left the DB; no LLM was involved (ground-truth SQL was already known). Probes escalate from cheap single-table to the full multi-hop join, each with a wall-clock deadline. For every probe we captured DuckDB's `EXPLAIN` physical plan (which annotates each `POSTGRES_SCAN` with the `Filters:` / `Projections:` it pushed) and compared DuckDB wall-clock vs native psycopg.

Relevant facts about the data:
- `Shared.MonitorMeasurements` ≈ **344,225,600 rows** (`DeviceId`, `MeasurementTypeId`, `Value double precision`, `Id bigint`).
- `Shared.Monitors` (`Id`, `AcceptanceId`, `MeasuredDate timestamptz`) — **time lives here, not on measurements**.
- `Shared.Acceptances` (`Id`, `PatientId`).
- Indexes present: `IX_MonitorMeasurements_DeviceId`, `IX_MonitorMeasurements_MeasurementTypeId`, `IX_Monitors_MeasuredDate`, `IX_Monitors_AcceptanceId`, `PK_Acceptances`. **No composite index** on `(MeasurementTypeId, Value)` — so the measurement filter alone is not selective.

---

## 3. What DuckDB DOES push down (verified)

`EXPLAIN` on a single-table filtered query shows the predicate landing inside `POSTGRES_SCAN`:

```
│       POSTGRES_SCAN       │
│        Projections:       │   <- only needed columns fetched
│     MeasurementTypeId     │
│           Value           │
│          Filters:         │   <- filter pushed to the remote WHERE
│    MeasurementTypeId=2    │
│        Value>120.0        │
│      ~58,265,693 rows     │
```

- **Filter pushdown: YES.** Simple column-vs-constant predicates (`=`, `>`, etc.) are pushed to the remote Postgres `WHERE`.
- **Projection pushdown: YES.** Only referenced columns are fetched.
- **LIMIT pushdown: YES.** `SELECT Id,Value ... WHERE Value>120 LIMIT 10` returned in **450 ms** — DuckDB pushed the `LIMIT` and stopped early.

So the handoff's framing ("DuckDB doesn't push down filters") was **imprecise** — it *does*. The real gap is elsewhere.

---

## 4. What DuckDB does NOT push down (the actual root cause)

### 4.1 Aggregates are not pushed
`EXPLAIN` of `SELECT count(*) ... WHERE MeasurementTypeId=2 AND Value>120`:

```
┌───────────────────────────┐
│    UNGROUPED_AGGREGATE    │   <- count runs IN DUCKDB
│        count_star()       │
└─────────────┬─────────────┘
┌─────────────┴─────────────┐
│       POSTGRES_SCAN       │   <- ~58M rows streamed to DuckDB first
│   Filters: MeasurementTypeId=2, Value>120.0 │
│      ~58,265,693 rows     │
```

The `count` sits *above* the scan, in DuckDB. Postgres does not receive `count(*)`; it receives `SELECT MeasurementTypeId, Value WHERE ...` and streams **58 million rows** back. That single-table count **timed out at 40 s** through DuckDB. (Native `count` = sub-second.)

### 4.2 Joins are not pushed — each scan is independent
`EXPLAIN` of the full HR query shows DuckDB building a `HASH_JOIN` tree *locally*, fed by three independent `POSTGRES_SCAN`s:

```
UNGROUPED_AGGREGATE  count(DISTINCT PatientId)
└─ HASH_JOIN  DeviceId = Id                       (~11.6M rows, in DuckDB)
   ├─ POSTGRES_SCAN MonitorMeasurements
   │     Filters: MeasurementTypeId=2, Value>120.0
   │     ~58,265,693 rows          ◄──────────── streamed over the wire
   └─ HASH_JOIN  AcceptanceId = Id                (in DuckDB)
      ├─ POSTGRES_SCAN Monitors
      │     Filters: MeasuredDate >= '...'::TIMESTAMPTZ
      │     ~9,845,110 rows
      └─ POSTGRES_SCAN Acceptances  (~13,053 rows)
```

**This is the killer.** Because the join happens in DuckDB, the join key cannot constrain the remote scan. The `MonitorMeasurements` scan is pushed *only* its own local filter (`MeasurementTypeId=2 AND Value>120`) — which matches **58M rows** — because the selective predicate (`MeasuredDate >= now()-3h`) lives on a *different table* (`Monitors`) and there is no way to communicate "only the ~3,862 devices seen in the last 3 hours" to the measurements scan. All 58M rows cross the wire; the query dies.

Result: **HR federated run → TIMEOUT at 35,671 ms.**

### 4.3 Why native Postgres is ~35,000× faster (the mechanism)
Native `EXPLAIN` reveals the plan DuckDB *can't* express:

```
Aggregate
└─ Nested Loop
   ├─ Nested Loop
   │  ├─ Parallel Bitmap Heap Scan on Monitors        rows≈3,862
   │  │     Recheck: MeasuredDate >= now()-'3h'
   │  │     └─ Bitmap Index Scan IX_Monitors_MeasuredDate
   │  └─ Index Scan IX_MonitorMeasurements_DeviceId    rows≈1 per device
   │        Index Cond: DeviceId = m.Id
   │        Filter: Value>120 AND MeasurementTypeId=2
   └─ Index Scan PK_Acceptances (Id = m.AcceptanceId)
```

Postgres **drives from the most selective table first** (`Monitors` via the `MeasuredDate` index → ~3,862 recent rows), then does an **index nested-loop** into `MonitorMeasurements` using `IX_MonitorMeasurements_DeviceId` — probing only the rows for those ~3,862 devices. It **never touches the 58M HR rows**. This is a cross-table optimization (join-order + index nested loop) that is fundamentally unavailable to DuckDB's federation model, where each remote table is scanned in isolation and joined afterward.

---

## 5. The Fixes (both validated end-to-end)

### 5.1 Fix A — Route single-source queries to native execution [primary, task #48]
When **every table referenced belongs to one source**, do not federate — send the whole SQL to that source's Postgres in a single round trip and stream back only the result. Two mechanisms, both verified returning the correct answer (**21 patients**):

| Path | Latency | Notes |
|---|---|---|
| Native `psycopg` execution | **1,049 ms** | Requires a native PG client + connection mgmt. |
| DuckDB `postgres_query('pg', '<sql>')` passthrough | **762 ms** | Runs the SQL *verbatim on the remote PG* and streams the result; **no new dependency** — DuckDB is already loaded and attached. `EXPLAIN` shows a single `POSTGRES_QUERY` node, `~1 row`. |

**Recommendation: use `postgres_query()` passthrough** for the single-source path. It reuses the existing attached, hardened, read-only DuckDB connection (no second driver, no second connection pool, no second read-only-enforcement surface), and it lets Postgres do full native planning (join order, index nested loops, aggregate pushdown — all of §4.3). The engine already knows each table's `source_id`; routing is: *if `len(distinct sources) == 1` → `postgres_query(alias, rewritten_sql)`; else → federated path.*

Rewrite needed: strip the DuckDB catalog qualifier (`pg.Shared.X` → `"Shared"."X"`) so the string is valid native Postgres. `sqlglot` (already a dependency) can do this qualifier rewrite reliably.

### 5.2 Fix B — For genuine cross-source joins, constrain the driving side
Fix A does nothing for a *real* multi-DB join (tables in different sources). There, DuckDB federation is unavoidable, and §4.2's problem returns. Mitigations, in order of leverage:

1. **Push a semi-join / IN-list manually.** Execute the selective side first (e.g. the recent `Monitors` on source-A → a few thousand `Id`s), then inject those keys as a pushed `WHERE DeviceId IN (...)` into the big-table scan on source-B. This reproduces the native index-nested-loop shape across sources. Feasible because the selective side is small; this is the single highest-value cross-source optimization.
2. **Order scans by estimated selectivity** using the EXPLAIN cardinality guard we already have (`guard/explain_estimate.py`) — drive from the smallest estimated result.
3. **Set `pg_experimental_filter_pushdown` / verify scanner version.** DuckDB 1.5.x already pushes simple filters (confirmed); ensure we're not on a version that regresses this. Complex expressions (function calls, casts the scanner doesn't recognize) silently fall back to no-pushdown — keep generated predicates simple (column `op` constant).
4. **Bounded materialization guard.** Before executing a federated plan, use the EXPLAIN estimate to *reject* plans whose largest `POSTGRES_SCAN` exceeds a row budget with no join constraint — fail fast instead of timing out (ties into task #47).

---

## 6. Alternatives to DuckDB federation (if cross-source needs outgrow §5.2)

| Option | Pushdown quality | Cost / fit |
|---|---|---|
| **DuckDB + `postgres_query()` per-source, join in DuckDB** (status quo + Fix A/B) | Filters/proj/limit auto; aggregates & joins only when whole subquery is single-source | **Best immediate fit.** Zero new infra. Recommended now. |
| **Trino / Presto** (already the stubbed `QueryEngine` target) | Mature cross-source join pushdown, dynamic filtering (runtime semi-join pushdown — exactly §5.2.1 automatically), cost-based join reordering across connectors | Heavyweight (coordinator + workers, JVM). Justified only when genuine multi-source analytical joins become common. The `QueryEngine` seam already exists to swap this in. |
| **Postgres FDW (`postgres_fdw`) with a coordinator PG** | `postgres_fdw` does push down joins/aggregates between foreign tables *of the same remote server* and remote WHERE; can be good | Requires a coordinator Postgres and FDW setup per source; operationally heavier than DuckDB, lighter than Trino. |
| **Application-level federation (manual semi-join orchestration)** | Whatever we implement (i.e. §5.2.1) | Most control, most code. A targeted version of §5.2.1 in the engine is effectively this, scoped to the patterns we actually generate. |

**Verdict:** DuckDB is the right engine *now*. The single-source path (the overwhelming majority of real queries, including every benchmark query) becomes fast with Fix A at zero infra cost. Reserve Trino for when multi-source analytical joins are a real, recurring workload — the `QueryEngine` interface is already designed to make that swap non-disruptive.

---

## 7. Recommended implementation order

1. **[task #48] Fix A — single-source native routing via `postgres_query()`.** Highest value, lowest risk, validated (762 ms). Hooks: `engine/duckdb_engine.py` (add a `run_native(source_alias, sql)` path) + `generation/pipeline.py` (detect single-source from the retrieved tables' `source_id`, rewrite qualifiers with `sqlglot`, choose path). Keep the federated path for multi-source.
2. **[task #47] Federated materialization guard.** Reject/repair federated plans whose driving scan is huge and unconstrained (extends the EXPLAIN guard).
3. **Fix B.1 — manual cross-source semi-join** when/if multi-source joins appear. Design first; not needed for current single-source workload.
4. **Trino** only on demonstrated multi-source analytical demand.

---

## 8. Corrections to prior notes

- The handoff/benchmark note "DuckDB's postgres-scanner estimate is filter-blind" refers to the *cardinality estimate* (`pages × rows_per_page`), which is a separate observation and remains true for estimation. **Filter *execution* pushdown, however, works** — the earlier phrasing conflated estimate-blindness with execution-pushdown. This doc supersedes the "filters aren't pushed" framing: filters ARE pushed; **aggregates and joins are not**, and that (not filter pushdown) is what causes the timeout.
- The federated `MonitorMeasurements` scan matching "58M rows" is the count *without* the time filter (which lives on `Monitors`); native avoids it entirely by join-order + index nested loop. This is the crux.
