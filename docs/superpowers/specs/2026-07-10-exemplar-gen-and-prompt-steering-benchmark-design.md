# Design: exemplar-generation enrichment + prompt steering, measured by a model×prompt×enrichment benchmark

**Date:** 2026-07-10
**Status:** approved design → implementation plan
**Branch:** remediation/phase-0-foundation (experimentation phase — drastic changes acceptable)

## Context & goal

Session benchmarking against the real staging DB showed the NL→SQL pipeline
produces silently-wrong SQL on multi-hop clinical queries (invented joins like
`Patients.ExternalId = Acceptances.ExternalId`, unrequested `IsActive` filters)
— even though the retrieved context carries the correct FK join hints. The
prep-data bugs that contributed were already fixed (commits f1f2fa9, 8d37d88,
367d655). This design adds two levers to raise correctness on the CHEAP model
tiers, and a benchmark to measure them:

1. **System-prompt steering** — make the model use ONLY declared FK joins and
   add no unrequested filters (already reviewed + approved).
2. **LLM exemplar-generation enrichment** — generate validated, PHI-safe
   few-shot exemplars at prep-build time and embed them, so retrieval supplies
   worked examples that steer the runtime model.
3. **Benchmark** — a 3-axis matrix (prompt × enrichment × runtime model) over
   10 representative queries to measure which combination makes a cheap model
   reliable.

Four workstreams; W1/W2 are mechanical, W3 is the design core, W4 is the
experiment.

---

## W1 — Fresh 14-table staging bundle

New scoped config covering the tables needed by the benchmark queries:

`Hospitals, Units, Departments, Organizations, Patients, Acceptances, Beds,
BedHistories, Monitors, MonitorMeasurements, MonitorMeasurementTypes,
Ventilators, VentilatorMeasurements, VentilatorMeasurementTypes`

- A `config/prep.config.staging14.yaml` (or `includeTables` on the staging
  source) listing exactly these 14 `Shared.*` tables.
- Verify each table exists in staging before building (some, e.g. `Departments`,
  `Organizations`, `BedHistories`, are unconfirmed — pre-flight check).
- Built with the fixed prep (P1–P5 + grain fix + P4 DSN fix).
- Two variants for the benchmark: **non-enriched** (no `--generate-exemplars`)
  and **enriched** (`--generate-exemplars`). To isolate the generated-exemplar
  effect, BOTH are built WITHOUT `--llm-enrich` — the ONLY difference between the
  two bundles is the generated exemplars. (`--llm-enrich`'s description/grain
  effect can be measured separately later; it is not an axis here.)

## W2 — System-prompt steering (toggleable)

Implement the approved preamble change in `assemble_prompt`
(`ceiba_nl2sql/ceiba_nl2sql/generation/prompt.py`), gated by a new
`GenerateOptions.strict_join_steering: bool` (default `False` initially so the
benchmark can A/B it; flip default to `True` once validated).

Three imperative lines added to the always-present preamble (stable prefix, so
R2 prompt-cache is preserved — the lines are constant, no per-question
interpolation):

- **JOINS**: use ONLY equality predicates declared in the JOIN GRAPH; every
  join must copy a declared FK edge verbatim; matching column NAMES do not imply
  a join; never `Id = Id` unless an edge says so; return fewer tables rather
  than fabricate a link.
- **FILTERS**: add a WHERE only if the user asked, or a rendered soft-delete
  rule; add no other filter (IsActive/status/date) the user did not request.
- **Reasoning nudge**: before writing SQL, trace the join path through the JOIN
  GRAPH; prefer PK/FK equality joins.

Update `test_prompt.py` assertions. Cache implication: the added lines lengthen
the cached prefix but introduce no per-question variation; validate
`cached_prompt_tokens` unchanged/greater under `PrefixCacheSimulatingLlm`.

## W3 — LLM exemplar-generation enrichment (design core)

New opt-in prep stage that generates validated, PHI-scrubbed few-shot exemplars
and embeds them. New module `prep/prep/enrich/exemplar_gen.py`; CLI flag
`--generate-exemplars`; config `config/exemplar_gen.yaml`.

### Configuration (`config/exemplar_gen.yaml`)

```yaml
generation:
  model: gpt-5.6-terra       # CAPABLE model for one-time generation (configurable; confirmed callable)
  perCategoryCount: 3        # target VALID exemplars per category
  maxAttemptsPerExemplar: 3  # regenerate on validation failure, up to this
  sampleRows: 5              # rows in the scrubbed data sample
categories:                  # configurable/promptable taxonomy
  - id: admissions
    intent: "When patients were admitted; admissions over time windows."
  - id: length_of_stay
    intent: "How long patients have been admitted; still-admitted vs discharged."
  - id: vitals_extreme
    intent: "Highest/lowest vital values (HR, SpO2, ...) over a window, per patient."
  - id: ventilation_status
    intent: "Which patients are/were on a ventilator; ventilation duration."
  - id: bed_occupancy
    intent: "Bed occupancy per unit/ward; currently occupied beds."
  - id: org_rollup
    intent: "Counts rolled up per hospital/unit/department/organization."
seeds:                        # user-provided anchor questions (style + coverage)
  - "can you bring me patients admitted in the last day?"
  - "give me list of patients that have admitted more than 3 days"
  - "get me the patient and vitals whose heart rate was worst in the last day"
  - "can you get me list of ventilated patients?"
```

CLI overrides: `--exemplar-count N` (global target). Needs `OPENAI_API_KEY`
(like `--llm-enrich`).

### Pipeline (slots into the ENRICH stage, after join-graph/glossary, before EMBED)

```
[1] GENERATE   per category + per seed: prompt the (capable) LLM with the
               schema + declared join hints + category intent → {question, sql}.
               (structured output {question, sql}; NOT the default {sql,description}.)
[2] VALIDATE   keep only if ALL hold; else discard + regenerate up to maxAttempts:
               (a) EXPLAIN binds against the read-only-attached staging engine
               (b) STRUCTURAL: every join equality predicate is a DECLARED FK
                   edge (either direction) in the join graph — rejects invented
                   joins (ExternalId=ExternalId, Id=Id). This is a build-time
                   instance of the #54 FK-predicate guard.
               (c) executes under the guard (LIMIT + deadline) and returns ≥1 row
[3] SAMPLE+SCRUB  execute with LIMIT sampleRows; for the returned rows, use
               sqlglot column lineage to map each OUTPUT column → its SOURCE
               column, then apply the bundle's phiClass (phi.json):
                 - aggregate (COUNT/AVG/SUM/MIN/MAX) → show the numeric value
                 - source col non-phi → show the value
                 - source col direct/quasi/free-text → cell = "<suppressed>"
                 - lineage unresolved/ambiguous → "<suppressed>" (FAIL-CLOSED)
[4] EMIT+EMBED  Exemplar{question, sql, scrubbedSample, category, difficulty};
               embed the QUESTION only (local bge-small) into vectors.duckdb
               (existing exemplar doc path); SQL + scrubbedSample ride as payload
               rendered as the few-shot example at generation time.
[5] PERSIST    write generated exemplars to config/exemplars.generated.jsonl
               (reviewable, reused across builds; regenerated only on the flag).
[6] PHI GATE   emitted docs + scrubbed samples flow through the existing gate
               (scans vectors.duckdb) — defense in depth; a leaked value fails
               the build.
```

### Component boundaries

- `exemplar_gen.generate_candidates(schema, join_hints, category, llm) -> [{question, sql}]`
- `exemplar_gen.validate(sql, engine, join_graph) -> bool` (EXPLAIN + structural + execute)
- `exemplar_gen.scrub_sample(sql, rows, phi_json) -> ScrubbedSample` (lineage → phiClass)
- `exemplar_gen.run(catalog, join_graph, phi_json, engine, llm, config) -> [Exemplar]`

Reuses: the DuckDB validation engine (P4), the join graph (structural check),
`aggregate_profile` + `phi.json` (scrubbing basis), the exemplar embedding path
(`vss_index.build_exemplar_document`), the PHI gate.

### Risk: scrubbing arbitrary query output

This is the highest-risk component — the PHI scrubber normally runs on KNOWN
schema columns, not arbitrary SELECT output (aliases, computed columns, joins).
Mitigation: sqlglot column-lineage to trace every output column to a source
column; fail CLOSED (suppress) on any column whose provenance is not a single
resolved non-phi source column or a pure aggregate. The PHI gate is the
second line of defense. Direct `SELECT Name AS x` → lineage resolves to
`Patients.Name` (direct-identifier) → suppressed.

## W4 — Benchmark (3-axis matrix)

Reusable live-benchmark entrypoint in `ceiba_nl2sql_eval` (extends the faithful
`benchmark.py` that drives the real `generate_sql`), parameterized by
`(bundle, prompt_variant, model, runs, questions_with_reference)`.

### Axes (2 × 2 × 3 = 12 cells)

- **prompt**: baseline (`strict_join_steering=False`) vs new (`True`)
- **enrichment**: non-enriched bundle vs enriched bundle
- **runtime model**: `gpt-5.4-mini` · `gpt-5.4-nano` · `gpt-5.6-luna`

All three confirmed callable by the service-account key. **N = 3 runs/query/cell**
(exploratory screen; pass-rate is coarse — promising cells re-run at higher N
later). Total = 12 × 10 × 3 = **360 generations (~$0.80, ~15 min)**.

### 10 queries + reference interpretation

Reference SQL authored + validated against staging; correctness = generated
result vs reference result executed the same moment (tolerance for time drift).

| # | Query | Category | Correctness mode | Fixed interpretation |
|---|-------|----------|------------------|----------------------|
| 1 | patients admitted in the last day | admissions | patient-id set | Acceptances in last 24h |
| 2 | patients admitted more than 3 days | length-of-stay | patient-id set | admit ≤ now-3d AND still admitted (no discharge) |
| 3 | patient + vitals whose heart rate was worst in last day | vitals extreme | patient-id + value | max HR (type 2) in last 24h |
| 4 | list of ventilated patients | ventilation | patient-id set | patients with a VentilatorMeasurement (recent) |
| 5 | bed occupancy per unit right now | bed occupancy | group counts | occupied beds per unit, current |
| 6 | count of patients per hospital | org rollup | group counts | distinct patients per hospital |
| 7 | average SpO2 per patient over last 24h | vitals trend | shape + sanity | avg(SpO2 type 12) per patient, 24h |
| 8 | patients with no monitor measurement in last 6h | anti-join | patient-id set | admitted patients lacking a measurement in 6h |
| 9 | longest-ventilated patients | ventilation duration | ordered top-k | rank by ventilation span |
| 10 | admissions per department last 7 days | dept rollup | group counts | Acceptances per department, 7d |

### Metrics per cell

Correctness pass-rate (over N), per-step latency (retrieve / generate /
execute), tokens (prompt / completion / cached), cost (real list prices incl.
the new luna entry), repair rounds.

### Reads

- prompt effect = (new − baseline) at each model/enrichment
- enrichment effect = (enriched − non-enriched) at each model/prompt
- model effect = across the three tiers
- best config likely = new prompt + enriched, cheapest model that clears a bar

### Pricing addition

Add to `DEFAULT_MODEL_PRICES` (`pricing.py`), verified with the user 2026-07:
- `"gpt-5.6-luna":  {"input": 1.00, "cached_input": 0.10, "output": 6.00}` (runtime axis)
- `"gpt-5.6-terra": {"input": 2.50, "cached_input": 0.25, "output": 15.00}` (one-time generation model — so its build cost is metered)

## Testing

- W2: `test_prompt.py` — preamble present when `strict_join_steering=True`,
  absent when False; cache-prefix stability under `PrefixCacheSimulatingLlm`.
- W3: `test_exemplar_gen.py` — structural validator rejects an invented join and
  accepts a declared-FK join; scrubber suppresses a direct-identifier output
  column and a `SELECT Name AS x` alias, emits an aggregate value, fails closed
  on unresolved lineage; config parsing; count/regeneration logic (with a
  stubbed LLM + a stubbed engine, no network).
- W3: `test_pricing.py` — luna priced correctly.
- Full multi-package suite green (run each package from its own dir).

## Sequencing & dependencies

1. W1 config + verify 14 tables exist (pre-flight).
2. W2 prompt toggle (independent; needed by the benchmark).
3. W3 exemplar generator (depends on W1 for a real bundle to build against).
4. Build both bundle variants (non-enriched, enriched).
5. W4 benchmark harness + reference SQL, run the 12-cell matrix.
6. Analyze; re-run promising cells at higher N if warranted.

## Open risks / notes

- **Scrubber correctness** is the load-bearing safety property (W3 risk above).
  Fail-closed + PHI gate; the tests must cover alias/computed/lineage-unresolved.
- **Structural validator strictness** may reject legitimate non-FK joins (date
  ranges, computed keys). Acceptable for a curated exemplar pool; log rejects.
- **Generation model cost** is one-time and amortized; runtime uses mini/nano/luna.
- **N=3 is a directional screen**, not a final measurement.
- Secrets: DB password + OpenAI key are env-only, fetched from
  `dev:/opt/EClinicsHospitalService/hospital.env`, never committed; scrub after.
