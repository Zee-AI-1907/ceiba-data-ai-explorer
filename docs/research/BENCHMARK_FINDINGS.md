# NL→SQL Live Staging Benchmark — Findings & Next Steps

> Results of iteratively benchmarking the NL→SQL pipeline against the REAL
> `CeibaHospitalDB` (337M-row measurement tables) with real OpenAI models
> (gpt-4o-mini, gpt-5.4-mini, gpt-5.4-nano), evaluating each generated SQL
> against ground truth. Read-only throughout; key never committed.

## What the iteration fixed (all verified working against real staging)

Starting from 0/5 on multi-hop clinical queries, the following were found and fixed
by live testing (each an actual bug, not a theoretical improvement):

1. **Catalog-qualified refs** — bundle rendered `"public"."X"`; DuckDB federation
   needs `staging."Shared"."X"`. (Fix B)
2. **PHI false-positive blocking semantic mining** — `MonitorMeasurementTypes.Name`
   (vocabulary: HR/SPO2) was classified as a patient name, blocking code-table
   mining. Fixed with a context-aware code-table label exemption (global PHI
   boundary unchanged). (code-table fix)
3. **Code-table row-fetcher not wired** — the mining ran with `row_fetcher=None`
   (connections disposed before enrich), so `HR→2` was never produced. Wired a
   read-only fetcher. (Fix D)
4. **`±infinity` date crash** — real staging has Postgres `-infinity` date
   sentinels that crashed profiling; mapped to None.
5. **Guards crashed on truncated LLM SQL** — `TokenError` (not just `ParseError`)
   propagated; now fail closed.
6. **Cardinality guard false-negatives** — didn't credit a parent-join time bound
   (via `time_via`) or an FK-equality on the large table; fixed + `time_via` enrich.
7. **THE root cause: pipeline dropped join-graph + semantic hints at prompt
   assembly** — `generate_sql` called `assemble_prompt` without forwarding
   `join_hints`/`glossary_hits`, so the JOIN GRAPH and SEMANTIC HINTS sections were
   silently omitted. The model never saw the FK edges or the HR→2 mapping. Fixing
   this (one call site) is what made capable models generate correct SQL.
8. **Postgres EXPLAIN cardinality guard** — DuckDB's postgres-scanner estimate is
   filter-blind; added a Postgres-side `EXPLAIN (FORMAT JSON)` estimate guard.

## The decisive result

For "patients with HR above 120 in the last 3 hours" (ground truth: **22 patients**),
**gpt-5.4-mini now generates exactly correct SQL**: correct 4-hop join
(`Patients ← Acceptances ← Monitors ← MonitorMeasurements` on the right FK columns),
`MeasurementTypeId = 2` (HR), `Value > 120`, `MeasuredDate >= now() - 3h`.

Run **directly on Postgres that query returns 22 in 393 ms.**

## The remaining blocker (NOT an NL→SQL problem — a federation EXECUTION problem)

That same correct query **times out at 30s through the DuckDB→Postgres federation
layer.** DuckDB's postgres scanner does not push the multi-hop join + filter down to
Postgres; it pulls `MonitorMeasurements` rows across the wire. A 0.4s native query
becomes >30s federated. This only surfaces at real scale — a synthetic mock never
would have shown it.

Secondary: **gpt-5.4-nano produced a silent wrong answer** — joined everything on
`Id = Id` (bogus) and returned a count without erroring. Silent-wrong is worse than
a timeout.

## Next steps (ranked)

1. **[HIGHEST] Route single-source queries to native Postgres execution**, not
   DuckDB. When every referenced table is in one source, execute on that source's
   Postgres directly (0.4s) instead of federating (>30s). Reserve DuckDB federation
   for genuine cross-source joins. This fixes the timeouts outright.
2. **EXPLAIN guard: gate on estimated COST/time, not just row count** — and consider
   requiring the capable model tier (or a verification pass) for multi-hop clinical
   queries to avoid silent-wrong answers like nano's `Id=Id`.
3. **Result-plausibility / self-verification** — a cheap sanity check (e.g. the query
   references the expected hosting table + code value from the semantic hint) to
   catch silent-wrong joins before returning.
4. **[NEXT STEP, already queued] Statistics-staleness checks** on the EXPLAIN
   estimate (pg_stat_user_tables.last_analyze / n_mod_since_analyze) to gate trust.

## Model comparison (real pipeline, 5 clinical queries, real staging)

| Model | Correct-SQL quality | Notes |
|-------|--------------------|-------|
| gpt-5.4-mini | **Best** — exact correct multi-hop SQL | Blocked only by federation exec timeout |
| gpt-4o-mini | Good on simple; wrong FK/uuid-cast on hard | |
| gpt-5.4-nano | Simple OK; **silent-wrong** on multi-hop (Id=Id) | Cheapest but unsafe on hard joins |

Simple queries (counts, aggregates, `Hospitals→Departments→Units→Beds`) work across
all models at ~$0.0001–0.0005/query, 1–3s generation.
