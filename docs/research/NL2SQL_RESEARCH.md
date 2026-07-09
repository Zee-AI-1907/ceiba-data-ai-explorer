# NL→SQL for Federated Clinical Data — Ideas + Tradeoffs Research

**Status:** Design research (no implementation). Decision-grade. Feeds a spec + implementation plan being written in parallel.
**Date:** 2026-07 · **Author:** data-science research pass
**Scope:** A driving LLM turns clinical NL ("patients admitted yesterday at hospital X", "patients whose HR was > 120 in the last 3 hours") into **read-only** SQL against **possibly multiple federated databases**, plus a **database-agnostic preparation toolchain** that, pointed at a set of databases, emits RAG/embedding/schema-context artifacts that plug into the driving LLM to raise accuracy and speed.

> ### ⚠ Grounding reality check — the real staging DB (drives everything below)
> A real read-only staging DB is now profiled, and it changes the difficulty class of this problem. **Read §0.1 before the rest of the report** — it is the reason schema *retrieval at scale* and *cardinality-aware prompting* are promoted to the top of the rankings.

---

## 0.1 The real target: `CeibaHospitalDB` (Postgres 15.15, read-only staging)

Measured facts that shape the design:

- **Engine/topology:** Postgres 15.15 at `localhost:55432`, read-only enforced. A **local companion Postgres (OrbStack)** with mock data correlating to staging is available, so the design must support a **two-source federation topology: `staging CeibaHospitalDB` + `local mock DB`** — this is the concrete multi-DB test bed.
- **Schema scale (the dominant constraint):** schema `Shared` has **942 tables**; `public` 110, `ICU` 66, `NICU` 49, `VEM` 46 — **~1,200 tables across 5 schemas.** Naive "inject the whole schema into the prompt" is *physically impossible*. Retrieval / schema-linking that scales to ~1,000+ tables is the make-or-break requirement, not a nice-to-have.
- **Time-series volume (the second dominant constraint):** `Shared."MonitorMeasurements"` ~**337M rows**, `Shared."VentilatorMeasurements"` ~**271M**, `Shared."Monitors"` ~**60M**. Generated SQL **must** push down time-bounds/predicates and `LIMIT`, or a single unbounded query melts the DB. **Row-count/cardinality metadata in the artifacts is not cosmetic — it is a safety and cost control** that steers the LLM to filter before scanning.
- **Identifiers:** PascalCase, quoted, multi-schema (`Shared."MonitorMeasurements"`, `ICU."..."`). Dialect + quoting handling is real and per-schema.
- **Clinical tables present:** `Shared."ICD10s"`, `Shared."Laboratories"`, `Shared."BloodGasMeasurements"`, ICU SAPS/SOFA parameter tables, NICU incubators — real code-system and scoring semantics to model (§2.4, §3.2).

**Net effect on the report:** three things move up. (1) **R1 schema retrieval** must be engineered for ~1,200 tables (two-stage recall→precision, hierarchical, §2.3) — a top-4 keyword scorer over a hand-list is not even in the running. (2) **Cardinality-aware prompting** (new R2′, §3.2a) becomes a first-class accuracy *and* safety lever because of the 337M-row tables. (3) The **federation engine + eval harness** are specified against the concrete `staging + local-mock` two-Postgres topology (§1.5, §6.3).

---

## 0. How this maps onto what already exists

The repo already contains most of the *runtime skeleton* this research is meant to upgrade. Reading it first grounds every recommendation below.

| Concern | Today (in repo) | What this research proposes |
|---|---|---|
| Schema → LLM | `lib/schemaInjector.ts` + `lib/dbRouter.ts`: **hardcoded** table list, keyword-overlap scoring, top-4 tables | Replace with an **artifact-driven, embedding-based retriever** produced by a generic prep tool |
| Clinical terms | `lib/clinicalContext.ts`: hardcoded abbreviation + time-range maps | Generalize into a **versioned glossary/synonym artifact** (still authored, but data not code) |
| SQL safety | `lib/sqlGuard.ts`: hand-written lexer, read-only allowlist, single-statement, H25 table-allowlist seam | Keep as-is; it is good. Wire the **table-allowlist seam** to the artifact's known-tables set |
| Execution | `lib/trinoClient.ts`: Trino REST, timeouts/deadline (H23) | Keep Trino as *default* engine, but hide it behind an **engine abstraction** (§1) so it is swappable |
| Routing | `dbRouter.ts` picks `telehealth` vs `eclinics` by keyword score | Replace with **retrieval-based source selection** driven by the join graph + embeddings |
| PHI egress | `lib/phiScrubber.ts`: schema+aggregates only; `OPENAI_BAA_SIGNED` hard gate; `buildAggregateProfile` never emits PHI values | This is the **compliance contract the prep tool must obey**: artifacts embed schema/metadata only, **never raw patient values** |
| SQL-gen route | `app/api/sql-generate/route.ts`: sends NL + static schema fragment to `gpt-4o-mini`, JSON out, treats output as untrusted | The natural insertion point for retrieved context, exemplars, self-repair loop |

**The single most important existing fact:** the codebase already enforces the egress boundary this research must respect — *schema/metadata to the LLM is OK; patient-row-derived data is gated behind `OPENAI_BAA_SIGNED` + residency* (`phiScrubber.ts` header, `sql-generate/route.ts` egress comment). Every artifact the prep tool emits must be classified against that boundary. The prep tool's hard invariant: **artifacts are built from `information_schema`-class metadata and synthetic/aggregate descriptors only; no raw cell from a patient row is ever persisted into an artifact.**

---

## 1. Federation / query engine (alternatives evaluated)

The user explicitly wants alternatives to Trino evaluated. The workload is: **multi-source, read-only, interactive (NL-driven) analytical queries over clinical/PHI data**, with the engine's **catalog metadata feeding the RAG prep tool**.

### 1.1 The candidates, on the dimensions that matter

| Engine | Multi-source federation | Read-only enforcement | Interactive latency | Cost / ops burden | Embeddable | PHI fit | Metadata exposure for prep tool |
|---|---|---|---|---|---|---|---|
| **Trino / Presto** | **Best-in-class** — connectors for Postgres, MySQL, SQL Server, Mongo, Kafka, Iceberg, etc.; cross-catalog joins | File/system access control can grant `read-only` per catalog; run as a genuinely read-only principal | Good for federated analytics; JVM cluster, not sub-second | Medium-high: JVM coordinator+workers to run/patch | No (external service) | Good — mature, self-hostable in-region; no data copy | **Excellent** — `information_schema` + `system.metadata`, `SHOW CATALOGS/SCHEMAS/TABLES`, `DESCRIBE` uniform across all sources |
| **StarRocks** | Good via external catalogs (Iceberg/Hive/JDBC); federation is secondary to its own storage | Role/priv model | **Excellent** — ~16× Trino concurrency, sub-second | Medium-high; shines when you also ingest | No | OK | Good, but federation-metadata less uniform than Trino |
| **Dremio** | Good, **Iceberg-centric**; lakehouse-first | Fine-grained | Good, reflections/caching | Medium (product) | No | OK; lakehouse assumption is a poor fit for live OLTP clinical DBs | Good, but oriented to lake sources |
| **DuckDB (+ `postgres`/`mysql` scanners, DuckLake)** | **Good & underrated** — `ATTACH` Postgres/MySQL/SQLite, cross-attach joins; reads live rows at query time | Process-level: run read-only, attach `READ_ONLY` | **Excellent** for small/medium result sets; vectorized | **Lowest** — in-process, single binary, zero cluster | **Yes** — in-process (also `pg_duckdb` inside Postgres) | Good *if* co-located in-region; watch cross-region reads | Good — `information_schema`, `duckdb_columns()`, `PRAGMA` after ATTACH |
| **Apache Calcite** | It's a *framework*, not a server — SQL parser + optimizer + JDBC adapters you embed | You build it | You build it | High *engineering* cost (you're building an engine) | **Yes** (library) | You own it | It's a parser/planner — can *produce* dialect + validate, but you assemble metadata |
| **PostgreSQL FDW (`postgres_fdw`/`multicorn`)** | Moderate — one Postgres reaches out to remote sources; cross-source joins are pushed/pulled with sharp perf cliffs | Native Postgres roles/`GRANT` — strong, familiar | Variable; join pushdown limited, easy to foot-gun | Low-medium if you already run Postgres | N/A (it's Postgres) | Good — mature RBAC, row-level security | Good — standard `information_schema` |
| **Proxy/pooling layer (PgBouncer, query router, caching proxy)** | **None** — not a federation engine | Enforces *connection identity* (read-only role), not query semantics | Removes connection-setup latency; caching cuts repeat cost | Low | N/A | Good — keeps a read-only role hot | N/A (transparent) — sits *in front of* an engine |

### 1.2 Ranked recommendation

1. **Keep Trino as the default federation engine** (the repo already integrates it). It is the only candidate that is *simultaneously* broad-federation, uniform-metadata, self-hostable-in-region, and read-only-enforceable at the connector. For "join telehealth + eclinics + a future third DB," nothing beats its connector breadth, and its uniform `information_schema`/`system.metadata` is a gift to the prep tool. Its weakness (JVM ops, not sub-second) is tolerable for NL-driven analytics where the LLM round-trip already dominates latency.

2. **Adopt DuckDB as a second, embeddable engine** — for two distinct jobs: (a) the **prep/eval toolchain's local execution + synthetic-data engine** (attach a source read-only, profile it, run golden-set queries on synthetic data with zero cluster); (b) a **fast path** for single-source or already-extracted/synthetic result sets. DuckDB's `ATTACH ... (READ_ONLY)` and in-process model make it the lowest-ops way to *introspect and test* any Postgres/MySQL/SQLite source, which is exactly what the DB-agnostic prep tool needs. This is the highest-leverage secondary bet.

3. **Put a thin proxy/pooling + cache layer in front of the engine** (not instead of it). Two concrete wins: **(a)** a read-only connection identity kept hot (PgBouncer-style for the Postgres connectors, or Trino's own read-only principal) so the "genuinely read-only DB role" that `sqlGuard.ts`'s header flags as *the primary control* is actually enforced at the connection, not just in-app; **(b)** a **result/plan cache** keyed like the existing `tenantCacheKey` so repeated NL queries (very common in dashboards) skip both the LLM and the engine. This is where a caching proxy earns its keep for "interactive latency."

4. **StarRocks / Dremio: defer.** Revisit StarRocks only if you hit a high-concurrency, sub-second, user-facing wall (its 16× concurrency edge is real) *and* you're willing to ingest/mirror data (a PHI-residency decision). Dremio only if you pivot to an Iceberg lakehouse. Neither beats Trino on *live multi-source federation*, which is the stated need.

5. **Calcite: use as a library, not an engine.** Its real value here is **dialect validation + SQL parsing/AST** (see §3 dialect handling and §6 static checks), not as the executor. A Calcite-based parse/validate step can catch dialect-invalid SQL *before* it reaches Trino, complementing (not replacing) `sqlGuard.ts`.

6. **`postgres_fdw`/`multicorn`: only as a fallback** for a Postgres-only, no-new-infra deployment. It gives federation "for free" if you already run Postgres, with strong native RBAC — but join pushdown cliffs and per-source DDL make it a poor general answer versus Trino.

### 1.3 When to prefer a pooling/proxy layer vs a full federation engine

- **Single source, or sources never joined together** → you may not need a federation engine at all. A **pooling/caching proxy in front of each database** (read-only role + result cache) plus per-source routing is lighter and lower-latency. This is the "one hospital, one DB" edge deployment.
- **Cross-source joins, or an open-ended set of source types** → you need a **federation engine** (Trino). The proxy still sits *in front of it* for connection reuse + caching.
- **Rule of thumb:** proxy = *connection identity + latency/cost*; federation engine = *query semantics across sources*. They are complementary layers, not alternatives. Always run the read-only role at the connection layer regardless — it is the control that makes an `sqlGuard` bypass harmless.

### 1.4 The swappable-engine abstraction (what it must expose)

Keep the engine behind an interface so Trino/DuckDB/others are interchangeable. Based on what `trinoClient.ts` and the prep tool both need, the abstraction should expose exactly these capabilities:

```
interface QueryEngine {
  // --- runtime (read path) ---
  execute(sql, { catalog, schema, maxRows, deadlineMs }): Promise<{ columns, rows, rowCount }>
  dialect(): SqlDialect                 // 'trino' | 'duckdb' | 'postgres' ...  → drives §3 dialect gen
  capabilities(): {                     // so the generator/guard can adapt
    supportsCrossCatalogJoin: boolean
    identifierQuote: '"' | '`'
    intervalSyntax: 'ansi' | 'postgres' | 'trino'
    supportsExplain: boolean
  }
  // --- prep/introspection path (DB-agnostic) ---
  listCatalogs(): Promise<string[]>
  listSchemas(catalog): Promise<string[]>
  listTables(catalog, schema): Promise<TableMeta[]>
  describeTable(ref): Promise<{ columns: ColumnMeta[], primaryKey, foreignKeys }>
  sampleAggregate(ref, cols): Promise<AggregateProfile>   // reuses buildAggregateProfile contract — NO raw PHI
  explain(sql): Promise<PlanOrError>                       // dry-run / validate without returning rows
}
```

Two hard rules for the abstraction: **(1)** every read goes through `execute`, which enforces the deadline/row-cap budget already in `trinoClient.ts`; **(2)** `sampleAggregate` is the *only* way the prep tool touches data, and it returns the same PHI-suppressed `AggregateProfile` shape `phiScrubber.ts` already defines — so the compliance boundary is structurally enforced, not by convention.

### 1.5 Reconsidering the ranking for the ACTUAL topology (two Postgres instances)

The generic ranking in §1.2 assumed heterogeneous sources. The measured topology is **two Postgres 15 instances** (`staging CeibaHospitalDB` + `local mock`). When *all sources speak the same wire protocol*, the calculus shifts — federation genericity matters less, and lower-ops options rise:

- **DuckDB (`postgres` scanner, `ATTACH ... READ_ONLY`) becomes the pragmatic first choice for the near-term two-Postgres case.** `ATTACH` both Postgres DBs read-only, cross-attach join in one in-process engine, predicates push down to Postgres. Zero cluster, trivial to run in OrbStack alongside the mock DB, and it is *already* the prep/eval engine (§5.1, §6.3) — so one component covers introspection, federation, and evaluation. This is the lowest-ops way to get real multi-DB federation working against the actual DBs *this week*.
- **`postgres_fdw` is now genuinely viable** (it was a fallback in §1.2 when sources were heterogeneous): both sources are Postgres, so one Postgres can `IMPORT FOREIGN SCHEMA` the other and cross-join with native RBAC and predicate pushdown. Cheapest if you want zero new engines. Watch the join-pushdown cliffs on the 337M-row tables — FDW can pull huge intermediate results if a predicate doesn't push; the cardinality artifacts (§3.2a) must steer the LLM hard toward pushable filters.
- **Trino stays the right *strategic* default** once a genuinely heterogeneous third source appears (SQL Server, Mongo, a lake) or you need its uniform metadata across many source types at prep time. Its connector breadth is wasted on two Postgres DBs but is exactly what future-proofs the architecture — which is why the engine abstraction (§1.4) matters: start on DuckDB against the two Postgres DBs, promote to Trino when heterogeneity or scale demands it, **without changing the runtime or the artifacts.**

**Revised near-term recommendation:** **DuckDB-first for the two-Postgres reality**, Trino behind the same abstraction as the growth path. Enforce the read-only role at *both* Postgres instances (the primary control) regardless of engine. This also means the current `trinoClient.ts` should become one implementation of the `QueryEngine` interface, with a DuckDB implementation beside it — not a rewrite.

---

## 2. Schema-aware RAG for NL→SQL

Goal: represent DB schema so the driving LLM sees *only* the relevant tables/columns/joins for a given NL query, within the context budget, and **never raw patient values**. This replaces the keyword-overlap scorer in `schemaInjector.ts`.

### 2.1 What to embed vs what to keep as structured metadata

Split the artifact into an **embedded (vector) layer** and a **structured (deterministic) layer**. Retrieval picks candidates; structured metadata assembles the exact prompt.

**Embed (dense vectors), one document per unit:**
- **Column documents** — the workhorse. `"{table}.{column}: {type}. {synonyms}. {NL description}. {non-PHI value hints}"`. Column-level (not just table-level) linking is what recent work identifies as the accuracy bottleneck.
- **Table documents** — `"{table}: {what one row means}. Columns: … . Joins to: …"`. A one-sentence "grain" description ("one row = one admission event") is disproportionately valuable for clinical schemas.
- **Glossary/synonym documents** — clinical term → column mappings (§2.4), embedded so "vitals" retrieves `VitalSigns.*`, "admitted" retrieves `Acceptances.AcceptanceDate`.
- **Exemplar documents** — NL-question → SQL pairs (feeds §3 few-shot). Embed the *question*; carry the SQL as payload.

**Keep as structured metadata (JSON, not embedded):**
- **Foreign-key / join graph** (adjacency list of `A.col → B.col`, with join cardinality). Deterministic — you never want a fuzzy vector deciding a join key.
- **Primary keys, types, nullability, units.**
- **Cardinality + synthetic value profiles** (from `buildAggregateProfile`): distinct counts, numeric min/max/mean, low-cardinality non-PHI category labels. These are *descriptors*, safe to persist; raw values are not.
- **Exact identifier quoting per table** (the repo already carries `eclinics."Shared"."Acceptances"` — keep it literal).

**Never embed / never persist:** raw patient row values, high-cardinality identifier columns' values, free-text notes content. `buildAggregateProfile` already draws this line (`kind: 'phi-suppressed'`, `HIGH_CARDINALITY_ABSOLUTE`) — the prep tool reuses that exact logic.

### 2.2 Retrieval strategy: hybrid, not pure dense

Recommendation: **hybrid (dense embeddings + BM25/lexical), with dense as primary.** Rationale grounded in the schema-linking literature and the clinical domain:
- **Dense** captures "vitals"→`VitalSigns`, "admitted"→`AcceptanceDate` (semantic).
- **BM25/lexical** captures exact identifiers, ICD/LOINC codes, and abbreviations that embeddings garble (e.g. a query mentioning `APACHEScore` or an exact code should hit the literal column). The repo's `CLINICAL_ABBREVIATIONS` expansion (`clinicalContext.ts`) should run *before* both, feeding expanded terms to each retriever.
- **Fusion:** reciprocal-rank fusion over the two result sets, then a structured expansion step: for every retrieved column/table, pull its **FK neighbors from the join graph** into the candidate set (a column is useless without its joinable partners). This "retrieve then graph-expand" is the pattern that ER-based and two-step clinical text-to-SQL work converge on.

### 2.3 Table/column selection to fit the context window

Two-stage, mirroring current best practice (schema-linking as a first-class stage):
1. **Recall stage** — hybrid retrieval returns top-K columns/tables (generous K, e.g. 30–50 columns) + graph-expanded FK neighbors.
2. **Precision stage** — an LLM (cheap model) or a cross-encoder re-ranks/prunes to the minimal table set, then the structured layer renders *only those* tables with full column detail + the join edges among them. This is where the "~65% token reduction" the repo already brags about becomes principled rather than keyword-luck.

For large schemas (hundreds of tables), skip sending the full schema entirely — recent large-scale schema-linking work (LinkAlign-style) exists precisely because dumping the schema stops working past a few dozen tables. The current top-4-tables heuristic is a crude version of this; the artifact makes it accurate.

#### 2.3a Scaling to ~1,200 tables (the `CeibaHospitalDB` reality)

942 tables in `Shared` alone means the recall stage cannot even *list* tables to the LLM. Concrete scaling measures, in order of leverage:

1. **Hierarchical / coarse-to-fine retrieval.** First retrieve at the **schema + table level** (embed the ~1,200 table docs, return top ~15–25 tables), *then* retrieve columns only within those tables. Two cheap ANN lookups beat one flat lookup over tens of thousands of column docs and keep the candidate set small. (This is where an ANN index matters — see the vector-store note below.)
2. **Cluster/domain tagging in the artifact.** Group tables by schema (`ICU`, `NICU`, `VEM`, `Shared`, `public`) and by clinical domain (monitoring, labs, ventilation, admissions, scoring). Retrieval can first pick a domain, then tables within it — pruning 1,200 → dozens before ranking. The 5-schema split is a free first-level partition.
3. **Table-importance prior.** Not all 942 tables are query targets; many are lookup/junction/audit tables. Rank tables partly by a **centrality/importance score** (FK in-degree, row count, whether it carries a timestamp or a code column) so the retriever favors the ~50–100 tables real questions actually hit. Store this score in the artifact.
4. **LLM re-rank on names+grain only (cheap model).** The precision stage sends the cheap model just the candidate table *names + one-line grain sentences* (not full column lists) to pick the final 3–6 tables, then the structured layer expands only those to full columns + join edges. Keeps the expensive context small.
5. **Vector-store implication:** at ~1,200 table docs + tens of thousands of column docs across many DBs, brute-force (sqlite-vec) still works for a *single* DB but gets borderline; this is the case that argues for **LanceDB or DuckDB-vss with ANN** (§4.1). Re-rank affects R1 and R-vector-store choice — noted in §4 and §7.

The through-line: **never rank all columns flat.** Partition (schema/domain) → retrieve tables → retrieve columns within survivors → graph-expand FKs → LLM-prune. Each stage divides the ~1,200-table space by an order of magnitude.

### 2.4 Business-glossary / synonym / code-system layer

This is where clinical NL→SQL lives or dies. Model it as **structured, versioned data in the artifact** (not code, unlike today's `clinicalContext.ts`):
- **Clinical term → column synonyms:** "vitals/obs" → `VitalSigns`; "admitted/admission" → `Acceptances.AcceptanceDate`; "ventilated" → `CriticalPatients.VentilatorStatus`. Seeded by the abbreviation map already in the repo, then extended.
- **Code-system mapping (ICD-10 / LOINC / SNOMED / RxNorm):** map NL concepts to the code columns that exist (`Diagnoses.ICD10Code`, `DrugAlerts.DrugGUID`). Two options: (a) a **lightweight local lookup** of common codes shipped in the artifact; (b) a **terminology service** call (OMOPHub/John Snow Labs-style) at prep time to expand a concept into its code set. For a first version, ship a curated local map for the most common concepts; treat full terminology-server integration as a later accuracy lever. **PHI note:** code *systems* are reference data, not PHI — safe to embed/ship.
- **Units & temporal semantics** (clinical-critical): record each numeric column's unit (bpm, mmHg, °C) and each timestamp column's meaning, so "HR > 120" maps to `HeartRate` in bpm and "last 3 hours" maps to the right timestamp column (`VitalSigns.RecordedAt`, not `AcceptanceDate`). See §3 for the temporal query concern.

---

## 3. NL→SQL technique landscape (2025–2026)

Grounded in current benchmarks: on **BIRD**, frontier LLMs sit ~54–68% execution accuracy on realistic enterprise schemas; schema linking + few-shot + execution feedback pushes a GPT-4-class model from ~60% to ~76%. On **MIMICSQL** (clinical), best reported execution accuracy is ~66% (GPT-4o) — clinical schemas are *harder*, which is the whole motivation for this prep tool.

### 3.1 What actually moves accuracy, ranked by impact

1. **Schema linking (biggest lever).** Getting the *right minimal set of tables/columns + join keys* into context is the dominant factor. This is exactly what §2's retriever + join graph delivers. Everything else is secondary to this.
2. **Execution-guided self-correction / repair loop.** Generate SQL → run `EXPLAIN`/dry-run (or execute on synthetic data) → on error, feed the error message back for one or two repair rounds. Consistently recovers column/type/dialect errors that would otherwise be hard failures. Cheap to add given the repo already treats model SQL as untrusted and re-parses it.
3. **Few-shot exemplar selection.** Retrieve the *k* most similar NL→SQL pairs from an exemplar store (embed the question, §2.1) and include them. DAIL-SQL-style skeleton/structure exemplars help most. Build the exemplar store from the golden set (§6) and from validated production queries.
4. **Decomposition / plan-then-write.** For compound clinical questions ("patients admitted yesterday at X *whose* HR was > 120"), decompose into sub-intents (cohort filter + temporal vital filter + join) before writing SQL. Meaningful gains on hard questions; adds latency, so gate it on detected question complexity (complexity-aware routing).
5. **Constrained decoding / grammar & dialect handling.** Ensure output is valid for the *chosen engine's* dialect (Trino ≠ Postgres ≠ DuckDB — the abstraction's `dialect()` from §1.4 drives this). Even without full grammar-constrained decoding, a **parse+validate gate** (Calcite or a dialect-aware parser) before execution catches invalid SQL. Note the current prompt says "Generate PostgreSQL queries" while the executor is Trino — a real dialect mismatch to fix; the generator must be told the *engine's* dialect.
6. **Self-consistency / multi-candidate + rank.** Generate N candidates, keep those that parse + pass the guard + execute on synthetic data, rank by agreement. Higher cost; use for high-stakes queries.

### 3.2a Cardinality-aware prompting (promoted to first-class by the 337M-row tables)

`Shared."MonitorMeasurements"` ~337M rows, `VentilatorMeasurements` ~271M, `Monitors` ~60M. An unbounded `SELECT ... FROM "MonitorMeasurements"` — or a join that scans it without a time predicate — is a DB-melting, budget-blowing, `trinoClient.ts`-deadline-tripping event. Making the LLM *filter before it scans* is simultaneously an **accuracy**, **latency**, **cost**, and **safety** lever. Measures:

- **Ship row-count + cardinality into the artifact and into the prompt.** Annotate each table with its approximate row count and flag "large time-series" tables. When such a table is retrieved, inject an explicit instruction: *"`MonitorMeasurements` has ~337M rows; you MUST include a time-bound predicate on `RecordedAt` (or equivalent) and a `LIMIT`; do not scan unbounded."* This is the single highest-value use of cardinality metadata.
- **Make the guard/validator enforce it, not just the prompt.** Extend the pre-execution gate (Calcite/dialect parse, §3.1.5) with a **cardinality policy check**: if the query touches a flagged large table with no predicate on its indexed time/partition column, *reject or auto-repair* (feed back "add a time bound"). The `sqlGuard.ts` H25 seam already exists for table-level policy; a cardinality policy is its natural sibling. This is a real safety control because the read-only role prevents writes but does **not** prevent a ruinous full scan.
- **Surface index/partition columns in the artifact** so the LLM filters on a column the DB can actually use (a time bound on an unindexed column still scans). Introspect indexes at prep time (stage [2], §5).
- **Prefer aggregate/windowed shapes for time-series questions.** "HR > 120 in the last 3 hours" should generate a bounded window scan with `RecordedAt >= now() - interval '3 hours'`, not a full-table filter. The temporal artifact (§2.4) must map the fact ("HR") to `MonitorMeasurements` *and* its time column, so the window lands on the right column.

This section is why cardinality metadata (mentioned as "nice" in §2.1) is reclassified as **load-bearing** for this DB.

### 3.2 Healthcare-specific concerns (these break generic NL→SQL)

- **Temporal queries** ("last 3 hours", "yesterday", "within 24h of admission"): the hardest clinical pattern. Needs (a) the right timestamp column per fact (event time vs admission time), (b) correct dialect interval syntax, (c) relative-to-now vs relative-to-event windows. The repo's `TIME_RANGE_HINTS` is a start but hardcodes `AcceptanceDate` — generalize to per-column temporal hints in the artifact, and make the generator pick the column by the *fact* being filtered.
- **Units:** "HR > 120" is only correct if `HeartRate` is bpm. Persist units in the artifact (§2.4) so the generator doesn't compare across mismatched units.
- **Patient / encounter modeling:** clinical questions are usually "patients *where* some event…", requiring patient↔encounter↔observation joins. The join graph must encode these grains explicitly; ambiguous "patient" resolution is a top error source in clinical NL2SQL.
- **Code systems:** "diabetics" → an ICD-10 code set, not a string match on a description. §2.4's code mapping is what makes this work.
- **PHI in the loop:** the generator sees *schema + synthetic descriptors only*. Result rows returned to the user are separate from what the LLM sees — consistent with the existing egress gate.

### 3.3 Evaluation metric

Adopt **execution accuracy (EX)** as primary (does the generated SQL return the same rows as the golden SQL on synthetic data), Spider/BIRD-style, plus static checks (§6). Exact-match is too brittle (many correct SQLs). This is the number the whole prep pipeline optimizes.

---

## 4. Vector store / embedding choices for the RAG artifacts

The artifacts must be **portable, versioned, "ready to plug in" build outputs** — this constraint dominates the choice.

### 4.1 Vector store

| Option | Portable single-file artifact? | In-process (no server)? | Fits TS/Next runtime? | Scale ceiling | Verdict |
|---|---|---|---|---|---|
| **sqlite-vec** | **Yes — one `.db` file** | Yes | Yes (bindings) | ~1M vectors, brute-force (no ANN yet as of early 2026) | **Recommended default.** Schema artifacts are *tiny* (hundreds–thousands of vectors), so brute-force is fine and the single-file portability is exactly the "artifact bundle" requirement |
| **LanceDB** | Yes — a directory (Arrow) | Yes (in-process) | Yes (node) | Very large, on-disk ANN | **Recommended if artifacts grow** (many DBs, large exemplar stores) or you want ANN + multimodal later |
| **DuckDB-vss** | Yes — one `.duckdb` file | Yes | Yes | Medium | Compelling **if you already adopt DuckDB (§1.2)** — vectors + schema tables + synthetic data in one file |
| **pgvector** | No — needs a Postgres | No (server) | Yes | Large (pgvectorscale: 50M @ high recall) | Only if you already run Postgres for the app and want one system; loses the "portable file artifact" property |
| Hosted (Pinecone/etc.) | No | No | — | Huge | **Rejected** — a network dependency and a data-egress surface for a portable, in-region artifact |

**Recommendation (revised for the ~1,200-table scale):** the "schema vectors are tiny" assumption weakens once one DB alone has ~1,200 table docs plus tens of thousands of column docs, multiplied across DBs and an exemplar store. sqlite-vec's brute-force (no ANN as of early 2026) is *acceptable per single DB* but borderline at multi-DB + column-level scale, especially with the hierarchical two-lookup retrieval of §2.3a.
- **Preferred default now: DuckDB-vss** — because DuckDB is already the recommended near-term engine for the two-Postgres topology (§1.5) and the prep/eval executor (§5.1, §6.3). One `.duckdb` file then holds vectors (with an ANN/HNSW index), the structured schema/join-graph tables, the synthetic fixtures, and the eval scaffolding — a single portable artifact, one dependency.
- **LanceDB** if you want the strongest on-disk ANN and a clean columnar store independent of the query engine, or if artifacts/exemplars grow large across many tenants/DBs.
- **sqlite-vec** remains fine for a *small single-DB* deployment or an edge/one-hospital bundle; keep it as the lightweight option, not the default at this scale.
- **pgvector** only if consolidating on the app's Postgres; loses portability.

### 4.2 Embedding model

- **The vectors cover schema metadata + synonyms + exemplar questions — NOT patient data** — so embedding via an API is *not* a PHI egress event (it's the same class of data the app already sends: table/column names). Still, prefer a model you can also run locally so the *same* embeddings can be regenerated in-region if policy tightens.
- **Recommendation:** a **local open embedding model** (e.g. a strong open-weights text-embedding model runnable via a small Python or ONNX/Transformers.js step in the prep tool) as the default, with an API embedder as an optional faster path. Rationale: (a) reproducibility — artifacts must be rebuildable deterministically and versioned; (b) no per-build API dependency; (c) keeps the *option* of in-region-only builds without re-architecting.
- **Hard rule (restate):** never embed a raw patient value. If a future feature wants "value-aware" retrieval, embed *synthetic* or *aggregate descriptors*, never real cells. `buildAggregateProfile` is the sanctioned source.

---

## 5. The DB-agnostic prep pipeline shape

Pointed at a set of databases, emit a **versioned artifact bundle** the runtime loads. Pipeline stages:

```
  [1] CONNECT           read-only, per source (Trino catalog, or DuckDB ATTACH READ_ONLY, or JDBC)
        ↓
  [2] INTROSPECT        information_schema / DatabaseMetaData:
                        tables, columns, types, nullability, PKs, FKs, indexes
        ↓
  [3] PROFILE           per column: distinct count, numeric min/max/mean,
                        low-cardinality NON-PHI category labels
                        → via buildAggregateProfile (NO raw PHI values persisted)
        ↓
  [4] ENRICH            join graph (from FKs + inferred name-match edges w/ confidence),
                        glossary/synonyms, code-system maps, units, table "grain" sentences
        ↓
  [5] EMBED             column/table/glossary/exemplar docs → vectors (local model)
        ↓
  [6] BUILD INDEX       write vector store (sqlite-vec / duckdb-vss) + structured JSON
        ↓
  [7] EMIT BUNDLE       versioned, hashed artifact:  schema.json + joingraph.json +
                        glossary.json + profiles.json + vectors.db + manifest(version, source
                        fingerprints, builder version, embedding model id)
```

### 5.1 DB-agnostic introspection — how to stay generic across Postgres / MySQL / SQL Server / …

Three viable routes, in preference order:

1. **Introspect *through* the federation engine (Trino).** Trino already normalizes every connector's metadata into a uniform `information_schema` + `system.metadata` + `SHOW`/`DESCRIBE`. Pointing the prep tool at Trino means **one introspection code path for all source types** — the biggest genericity win, and it reuses the existing connection. This should be the default when Trino is present.
2. **DuckDB `ATTACH` per source** (`postgres`, `mysql`, `sqlite` scanners) — read-only, then read `information_schema`/`duckdb_columns()`. Great for the *standalone* prep tool and for engines-not-yet-in-Trino, and it doubles as the synthetic-data + eval executor (§6). Lowest ops.
3. **Direct per-dialect introspection** via each DB's `information_schema` (ANSI-ish across Postgres/MySQL/SQL Server) or JDBC `DatabaseMetaData` (uniform PK/FK/column API across drivers). Most control, most per-dialect code — use only for a source neither Trino nor DuckDB can attach.

**Language choice for the prep tool — recommendation: a small Python toolchain, justified.** The app is TS/Next, and a TS-native prep tool (Node DB drivers + Transformers.js + sqlite-vec bindings) is *viable* and keeps one language. But Python wins here because: (a) **SQLAlchemy/`inspect` + DuckDB give the broadest, most battle-tested cross-DB introspection** with the least per-dialect code; (b) the **embedding + eval + synthetic-data + statistics** ecosystem (evaluation harness, data profiling, synthetic generators) is far richer in Python; (c) the prep tool is a **build-time, offline** process — it does not need to share the runtime's language, and its *output* (JSON + a vector file) is language-neutral and consumed by the TS runtime. The seam is the **artifact bundle**, not the language. If keeping one language is a hard org constraint, TS-native is acceptable with more per-dialect introspection work and a thinner eval ecosystem.

### 5.2 Artifact bundle contract

- **Versioned + fingerprinted:** manifest carries a semantic version, a fingerprint of each source's schema (so the runtime can detect drift and warn), the builder version, and the embedding model id (so vectors are never mixed across models).
- **Portable:** JSON + one vector file; no server dependency; loadable by the TS runtime at boot or lazily per tenant (mirrors the existing per-tenant cache-key design).
- **Compliance-classified:** every file is metadata/synthetic only. A build-time assertion (reusing the PHI allowlist in `phiScrubber.ts`) must fail the build if any raw PHI-column value would be written into an artifact. Make this a **CI gate**, not a convention.
- **Hot-swappable:** the runtime loads a bundle by version; rebuilding on schema change produces a new version the runtime can pick up without redeploy.

---

## 6. Evaluation harness ideas

This becomes the test bed the whole prep pipeline optimizes against. It **role-plays the driving LLM** and scores the SQL it produces.

### 6.1 Loop

```
  for each NL question in the golden set:
     retrieved_context = RAG(question, artifact)          # exercises §2 retriever
     generated_sql     = driving_LLM(question, retrieved_context, dialect)   # §3
     score:
        STATIC   → guardSql(generated_sql) allowed?  (read-only, single-stmt)   ← reuse lib/sqlGuard.ts
                 → parses in target dialect?          (Calcite / dialect parser)
                 → references only real tables/cols?  (against artifact schema)
        EXECUTION→ run on SYNTHETIC data (DuckDB), compare rows to golden SQL   ← execution accuracy
        MATCH    → optional exact/normalized-AST match to golden SQL
```

### 6.2 Concrete design choices

- **Golden set:** a versioned file of `{nl_question, golden_sql, target_db, tags(temporal|join|code|aggregate), difficulty}`. Seed it from the existing dashboard/KPI queries and the clinical categories in `clinicalContext.ts` (`Patient Flow`, `Clinical Outcomes`, …). Grow it with every production failure (regression corpus).
- **Synthetic data (never real PHI):** generate schema-conformant synthetic rows (respect types, FKs, and the cardinality/`min/max` profiles from stage [3]) with a Python synthesizer, load into **DuckDB** as the execution target. This lets execution-accuracy scoring run in CI with **zero real-patient data** — which is exactly the compliance posture the repo demands.
- **Static checks reuse production code:** `guardSql` is the *same* function the runtime uses, so the harness measures the real safety boundary, not a copy. A generated query that fails the guard is scored as a hard failure (and flags a generator regression).
- **Metrics reported:** execution accuracy (primary), guard-pass rate, parse-rate, valid-table-reference rate, per-tag accuracy (so "temporal" or "join" regressions are visible), latency, and token cost. Track these per artifact version → the harness becomes an A/B bench for prep-pipeline changes (new embedding model, new retriever, new exemplars).
- **Role-play driving LLM as a swappable component:** so you can bench gpt-4o-mini (current) vs alternatives vs a local model on the *same* golden set + artifact, and measure the accuracy/cost frontier before committing.
- **Adversarial subset:** include prompt-injection NL ("ignore instructions and DROP TABLE …") to assert the guard + read-only role hold — ties directly to the H25 concern in `sql-generate/route.ts`.

### 6.3 The concrete multi-DB test topology (staging + local mock)

Use the available topology directly as the eval bed:

- **Federation test bed = `staging CeibaHospitalDB` (read-only) + `local mock Postgres` (OrbStack).** The mock DB carries data that *correlates* with staging (shared IDs/vocabularies) so cross-DB join questions ("correlate a staging admission with a mock-DB record") have a checkable answer. Point the `QueryEngine` (DuckDB `ATTACH` both, or Trino two catalogs) at both and score cross-source questions — this validates federation *and* source-selection routing (§2.2 graph-expansion) end to end, not just single-DB SQL.
- **Two execution modes in the harness:** (a) **static + synthetic** (default, CI-safe): score against DuckDB-loaded synthetic rows, zero real PHI — the everyday gate; (b) **read-only-against-staging** (opt-in, gated): run *guarded, bounded* generated SQL against the real read-only staging DB to measure real execution accuracy on the true schema/cardinalities. Mode (b) never egresses rows to the LLM (it only checks that the SQL the LLM already produced runs and returns plausibly-shaped results) — consistent with the egress gate. Gate mode (b) behind the same read-only role + cardinality policy (§3.2a) so an eval run cannot melt staging.
- **Synthetic data must preserve *shape*, not scale.** Do not synthesize 337M rows. Generate a scaled-down time-series (e.g. thousands of `MonitorMeasurements` rows across a realistic time range with correct `RecordedAt` distribution, types, and FK integrity) so temporal/window queries are *executable and checkable* while staying tiny. The cardinality *metadata* (real ~337M) still flows into the artifact/prompt (§3.2a); only the executable fixtures are scaled down.
- **Schema-scale realism:** run the retriever against the **full ~1,200-table introspected schema** (metadata is not PHI, so the real schema can be introspected freely) even when execution uses synthetic rows. This is what actually stress-tests R1's scaling (§2.3a) — a golden set built only over a 10-table toy schema would hide the retrieval problem that dominates this project.

---

## 7. Prioritized recommendations (impact × effort)

Ranked by **impact on accuracy** and annotated with **build effort**. This is the decision-grade summary.

| # | Recommendation | Impact on accuracy | Build effort | Notes |
|---|---|---|---|---|
| **R1** | **Replace keyword schema injection with hierarchical, scale-aware retrieval** (partition→table→column→FK-expand→LLM-prune), hybrid dense+BM25, driven by an artifact (§2, **§2.3a**) | **Very high** — #1 lever, and *mandatory* at ~1,200 tables | **High** | The core. Must scale to 942-table `Shared`; top-4 keyword scorer is a non-starter here. Upgrades `schemaInjector.ts`/`dbRouter.ts` |
| **R2** | **Cardinality-aware prompting + a cardinality guard** for the 337M/271M/60M-row time-series tables: ship row counts, force time-bound predicates + LIMIT, reject/repair unbounded scans (**§3.2a**) | **High** — and it's a **safety/cost control** (prevents DB-melting scans) | **Low–Medium** | New, promoted by the staging profile. Extends the `sqlGuard.ts` H25 seam with a cardinality policy |
| **R3** | **Add an execution-guided self-repair loop** (generate → EXPLAIN/dry-run → feed error back → retry ≤2) (§3.1) | **High** | **Low–Medium** | Cheap given SQL is already treated as untrusted; recovers column/type/dialect errors |
| **R4** | **Build the DB-agnostic prep pipeline emitting a versioned artifact bundle** (§5): introspect the real ~1,200-table schema, profile cardinality, build hierarchical index + join graph | **High** (enables R1, R2) | **High** | Python toolchain; introspect via DuckDB `ATTACH`/Trino; artifact = JSON + duckdb-vss/LanceDB file |
| **R5** | **Stand up the evaluation harness** on the **staging + local-mock** topology (§6, **§6.3**): synthetic-execution default + gated read-only-against-staging; retriever tested over the *full* real schema | **High (indirect)** — gates every other change | **Medium** | Build *early*. Reuses `sqlGuard.ts`; synthetic data preserves time-series *shape*, not 337M scale |
| **R6** | **Fix the dialect mismatch** — generator must target the engine's dialect (Postgres/DuckDB/Trino per the topology), not a hardcoded "PostgreSQL"; add a parse/validate gate (§3.1.5) | **Medium–High** | **Low** | Prompt says PostgreSQL, executor was Trino — real bug; now sources are Postgres, so get the dialect from the abstraction |
| **R7** | **Few-shot exemplar store** (embed golden + validated production Q→SQL) (§3.1.3) | **Medium–High** | **Medium** | Grows with the golden set; compounds with R5 |
| **R8** | **Clinical glossary/synonym + code-system + units + temporal-column artifact** (§2.4), generalizing `clinicalContext.ts` from code to data; map facts→(table, time column) for `MonitorMeasurements` etc. | **Medium–High** (domain-specific) | **Medium** | Temporal/units correctness is where clinical NL2SQL fails; `ICD10s`/labs/SAPS-SOFA semantics live here |
| **R9** | **Engine abstraction (§1.4); DuckDB-first for the two-Postgres topology, Trino as growth path** (**§1.5**); adopt DuckDB for prep/eval + federation now | **Low (accuracy) / High (architecture)** | **Medium** | Unlocks R4/R5 execution; `trinoClient.ts` becomes one `QueryEngine` impl beside a DuckDB one |
| **R10** | **Read-only role at both Postgres instances + result/plan cache** in front of the engine (§1.3) | **Low (accuracy) / High (safety+latency)** | **Low–Medium** | Makes the read-only *primary control* real (per `sqlGuard.ts` header); pairs with R2's cardinality guard |
| **R11** | **Decomposition / complexity-aware routing** for compound clinical questions (§3.1.4) | **Medium (hard queries only)** | **Medium–High** | Add *after* R1–R5; gate on detected complexity to control latency |

**Suggested sequence:** **R5** (harness on staging+mock) + **R6** (dialect fix) first — cheap, and R5 measures everything after. Then **R4** (prep pipeline over the real ~1,200-table schema) → **R1** (scale-aware retrieval) as the accuracy core, with **R9** (DuckDB engine abstraction) supporting both. Land **R2** (cardinality guard) alongside R1 — it is low-effort and prevents a real operational hazard the moment queries hit the 337M-row tables. Then **R3** (self-repair) and **R8** (glossary/temporal/units) as high-ROI accuracy adds. **R7, R10, R11** as compounding follow-ups.

---

## 8. PHI / compliance constraints (threaded throughout — do not violate)

These are hard invariants, consistent with the existing `phiScrubber.ts` egress model and the `sql-generate/route.ts` egress comment.

1. **Artifacts are metadata + synthetic/aggregate only.** No raw patient-row value is *ever* persisted into an artifact or embedded into a vector. Enforce with a CI build gate reusing the `PHI_COLUMNS` allowlist and `buildAggregateProfile`'s `phi-suppressed` logic.
2. **Embedding schema metadata is fine; embedding patient data is not.** Sending table/column names/synonyms to an embedding API is the same egress class the app already permits. Sending patient cell values is not — and is blocked by (1).
3. **The `OPENAI_BAA_SIGNED` + residency gate stays authoritative** for anything patient-row-derived at *runtime*. The prep tool operates at build time on metadata, so it is not gated by BAA — but its *outputs* must be classifiable as non-PHI, which (1) guarantees.
4. **Synthetic data for evaluation, never real PHI.** Execution-accuracy scoring runs on generated synthetic rows in DuckDB, in-region, in CI.
5. **Read-only is enforced at three layers:** the DB/engine principal (primary control — `sqlGuard.ts` header calls this out as UNVERIFIED and it must be made real, R9), the in-app `guardSql` classifier (defense-in-depth, already good), and the artifact's known-tables allowlist wired into the H25 seam.
6. **The generator's SQL is untrusted output** — already the repo's stance. Retrieval/self-repair change *how* SQL is produced, never *whether* it is re-validated before execution. The `POST /api/query` guard + read-only role remain the security boundary.
7. **Data residency:** the local-embedding-model default (§4.2) preserves the option of fully in-region artifact builds; a hosted vector store is rejected partly to avoid a new egress/residency surface.
8. **Introspecting the real 942-table schema is allowed** — table/column/FK/index/cardinality *metadata* is not PHI, so the prep tool may point at read-only staging freely (that is exactly the boundary `sql-generate/route.ts` already permits). What it must never persist is a raw cell value.
9. **The gated "read-only-against-staging" eval mode (§6.3) does not egress rows to the LLM** — it only confirms the LLM's already-produced SQL runs; combined with the read-only role and the cardinality guard (R2), an eval run can neither write nor melt staging.
10. **The cardinality guard is a compliance-adjacent availability control:** the read-only principal stops writes but not a ruinous full scan of a 337M-row table. R2's predicate-required policy is what protects staging's availability — treat it as part of the safety boundary, not just an accuracy tweak.

---

## Sources

- [NL2SQL System Design Guide 2025 (Medium)](https://medium.com/@adityamahakali/nl2sql-system-design-guide-2025-c517a00ae34d)
- [LinkAlign: Scalable Schema Linking for Real-World Large-Scale Multi-Database Text-to-SQL (arXiv)](https://arxiv.org/pdf/2503.18596)
- [LitE-SQL: Lightweight Text-to-SQL with Vector-based Schema Linking and Execution-Guided Self-Correction (arXiv)](https://arxiv.org/pdf/2510.09014)
- [Memo-SQL: Structured Decomposition and Experience-Driven Self-Correction (arXiv)](https://arxiv.org/html/2601.10011)
- [TailorSQL: An NL2SQL System Tailored to Your Query Workload (arXiv)](https://arxiv.org/html/2505.23039v1)
- [BASE-SQL: open-source Text-to-SQL baseline (arXiv)](https://arxiv.org/pdf/2502.10739)
- [In-depth Analysis of LLM-based Schema Linking (EDBT 2026)](https://openproceedings.org/2026/conf/edbt/paper-24.pdf)
- [How to Improve Text2SQL Accuracy: Best Practices (AI2SQL)](https://builder.ai2sql.io/blog/text2sql-accuracy-best-practices)
- [Comparison of Open Source Query Engines: Trino and StarRocks (StarRocks)](https://www.starrocks.io/blog/comparison-of-the-open-source-query-engines-trino-and-starrocks/)
- [ClickHouse vs StarRocks vs Presto vs Trino vs Spark (Onehouse)](https://www.onehouse.ai/blog/apache-spark-vs-clickhouse-vs-presto-vs-starrocks-vs-trino-comparing-analytics-engines)
- [Top 10 Query Engines for Apache Iceberg (Estuary)](https://estuary.dev/blog/comparison-query-engines-for-apache-iceberg/)
- [DuckDB PostgreSQL Extension (DuckDB docs)](https://duckdb.org/docs/current/core_extensions/postgres/overview)
- [pg_duckdb (GitHub)](https://github.com/duckdb/pg_duckdb)
- [DuckLake integrated data lake and catalog format (GitHub)](https://github.com/duckdb/ducklake)
- [Getting Started with DuckLake (MotherDuck)](https://motherduck.com/blog/getting-started-ducklake-table-format/)
- [pgvector vs sqlite-vec (Grokipedia)](https://grokipedia.com/page/Comparison_of_sqlite-vec_and_pgvector)
- [Embedded Vector Databases 2026: sqlite-vec vs LanceDB, etc. (Shaharia Azam)](https://shaharia.com/blog/choosing-embeddable-vector-database-go-application/)
- [Best Vector Databases in 2026 (Firecrawl)](https://www.firecrawl.dev/blog/best-vector-databases)
- [Generating patient cohorts from EHRs using two-step RAG text-to-SQL (arXiv)](https://arxiv.org/pdf/2502.21107)
- [FastOMOP: Agentic Real-World Evidence Generation on OMOP CDM (arXiv)](https://arxiv.org/html/2604.24572)
- [LLMs for Clinical Trial Criteria → OMOP CDM Queries (PMC)](https://pmc.ncbi.nlm.nih.gov/articles/PMC12530336/)
- [Robust Clinical Querying with Local LLMs: NL2SQL on EHRs (MDPI)](https://www.mdpi.com/2504-2289/9/10/256)
- [Extracting Database Metadata Using JDBC (Baeldung)](https://www.baeldung.com/jdbc-database-metadata)
- [Trino File-based Access Control (Trino docs)](https://trino.io/docs/current/security/file-system-access-control.html)
- [PgBouncer connection pooler](https://www.pgbouncer.org/)
- [postgres_fdw (PostgreSQL docs)](https://www.postgresql.org/docs/current/postgres-fdw.html)
</content>
</invoke>
