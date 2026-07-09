# NL→SQL Improvements — 2026-07 batch

> Eleven improvements to the prep toolchain, SQL routing/execution, and LLM
> management, each committed separately with tests, plus a faithful A/B
> benchmark harness. Goal per item: improve **accuracy**, **latency**, or
> **token cost** without regressing the other two. Everything risky is
> flag-gated (default off); everything always-on is behavior-preserving for
> pre-existing bundles/configs.

Baseline at start of batch: `deaf2de` (TS runtime retired; Python authoritative).
All four Python suites green before and after every commit
(`ceiba_nl2sql` 424, `prep` 184, `ceiba_nl2sql_service` 44, `ceiba_nl2sql_eval` 21 at batch end).

---

## Quick wins (bug fixes)

### QW1 — Repair rounds skipped the Postgres EXPLAIN cardinality guard (`6781757`)
**Axis: accuracy/safety.** The repair-loop validate call omitted
`source_dsn`/`pg_explain_runner` (`generation/pipeline.py`), so the
authoritative filter-aware EXPLAIN estimate ran on the FIRST candidate only —
every repaired candidate was re-checked by the syntactic guard alone, and a
repair that satisfied a syntactic escape hatch but still scanned huge slipped
through. The existing test suite masked the bug (the repaired candidate
passed syntactically). Regression tests now prove the probe runs once per
candidate and that a persistently huge estimate exhausts the repair budget
and raises. Both tests fail on the pre-fix code.

### QW2 — gpt-5.x pricing + cached-token metering (`4b212e2`)
**Axis: cost observability (prereq for measuring everything else).**
`DEFAULT_MODEL_PRICES` had no gpt-5.x entries, so the models the staging
benchmarks actually run (gpt-5.4-mini/nano) reported `priced=False`/$0 on
every query. Added gpt-5.4/-mini/-nano + gpt-5.5 list prices (verified
2026-07 at developers.openai.com). Also meters prompt-cache hits end to end:
`usage.prompt_tokens_details.cached_tokens` → `TokenUsage.cached_prompt_tokens`
→ priced at the discounted `cached_input` rate (10% of input across the
gpt-5 family) → additive `cachedPromptTokens` on the wire.

### QW3 — Embed the question once per retrieve (`272b60c`)
**Axis: latency.** Table recall and column recall each embedded the same
expanded question — two bge-small forward passes per request for one string
(~10–25 ms wasted). `retrieve()` now embeds once and shares. Ranking is
byte-identical; asserted by a counting-embedder test.

---

## Prep-stage improvements

### P1 — Harvest Postgres catalog ground truth (`302df26` + `ff0b908`)
**Axis: accuracy; zero runtime latency/cost impact.** The bundle was
information-poor in ways the runtime compensated for with prompt heuristics,
while Postgres already stored the missing facts. Harvested at prep
(metadata-only) and rendered into the prompt:
- **pg_description comments** → column/table `description` (was hardcoded
  `None`); also enriches the embedded column docs, so retrieval matches real
  documentation text.
- **Declared ENUM labels + CHECK IN-lists** → `allowedValues` (sqlglot parses
  both the authored `IN (...)` form and Postgres's normalized
  `= ANY (ARRAY[...])`; fail-open; ≤50 values; PHI-gated). Prompt renders
  `values: 'active' | 'closed' | …` (≤12 shown).
- **pg_stats `null_frac`/`n_distinct`** → `nullFraction`/`distinctCountEstimate`
  (whole-table planner statistics — strictly better than the LIMIT-5000
  sample). Prompt flags `~97% NULL` columns (mostly-empty columns are a
  silent-wrong trap for aggregates).
- **Month-truncated time ranges** → table `timeRange` + `usesInfinitySentinels`
  (aggregate-only `sample_aggregate_time_range` probe; index-endpoints fast).
  Prompt states `data spans 2019-03 .. 2026-07 on "MeasuredDate"` so relative
  windows anchor to the real data horizon, plus the ±infinity open-range
  convention that was previously silently nullified.

PHI gate extended in lockstep: `pg_stats` allowlisted for the numeric fields
only, the value-bearing pg_stats fields (`most_common_vals` etc.) are a hard
violation anywhere, and a new catalog check rejects `allowedValues` on any
non-`non-phi` column. Spec §2.3 updated. Pre-harvest bundles render
byte-identically (asserted).

> **2026-07 staging validation + P2 safety fix (`phi.py`).** Running the P2
> rescue against the REAL staging schema (not the mock fixtures) surfaced a
> confirmed leak: the "low whole-table distinct ⇒ coded vocabulary" assumption
> also matched sparse identifiers — 678 of 1269 text columns rescued, including
> `BreastMilkForms.MotherName`+`MotherIdNumber` (dense, 18 distinct → would
> emit 8 real names paired with 8 national IDs into `topCategories`), plus
> `FatherName`, `BirthPlace`, `RelativeTcNo`, `PassportNumber`,
> `FamilyDoctorPhoneNumber`, provider names. Root cause: low distinct is often a
> NULL-sparsity artifact, and the authoritative set / free-text hints miss
> person-role & identifier tokens. Fix (layered, keeps every genuine
> vocabulary): (a) a person/identifier NAME denylist (`_PHI_NAME_HINTS`)
> suppresses before the rescue at any cardinality; (b) a `*Text` suffix →
> free-text; (c) a `null_frac > 0.5` guard (`RESCUE_MAX_NULL_FRACTION`) refuses
> the rescue for mostly-null columns (`null_frac` threaded from pg_stats through
> `ProfileColumn`/`classify_columns`, so phi.json and profiles.json stay
> consistent). Measured on staging: rescues 678 → 450, **all 19 confirmed-PHI
> columns now suppressed, 0 genuine vocabulary lost** (`DeviceName`×33,
> `RoleName`, `DrugName`, `SystemicDiseaseName`, `InsulineName` retained).
> Regression tests are staging-shaped (the mock fixtures have none of these
> columns, which is why the original slipped through green). Durable follow-up:
> require positive coded-vocabulary evidence (FK/ENUM/CHECK) rather than mere
> low distinct; exclude transient `*Temp<hash>` copy tables from introspection.

### P2 — Evidence-based categorical rescue from the PHI text heuristic (`509d33c`)
**Axis: accuracy.** On Postgres every string column is `text`, so the
type-based free-text heuristic suppressed the entire coded vocabulary of the
schema — any status/type/level column not on the known-safe names list
emitted no example values. `classify_column` now accepts whole-table distinct
evidence (pg_stats, never the bounded sample): a text column whose ONLY
suppression reason is the type heuristic and whose whole-table distinct count
is ≤50 is a coded vocabulary, not narrative. Strictly scoped: the
authoritative PHI set and name-based hints always suppress; no evidence →
fail closed exactly as before; the emitted `topCategories` discipline (≤20
distinct, TS-mirrored) is unchanged. Evidence threads identically into
phi.json and profiles.json so the PHI gate cross-check cannot diverge.

### P3 — One-time LLM enrichment pass (`bc89a58`, opt-in `--llm-enrich`)
**Axis: accuracy for cents once per build; zero runtime impact.** Sends
SCHEMA METADATA ONLY (schema-metadata egress class through the `call_llm`
choke point) to the LLM once per bundle build; folds back table/column
descriptions, `one row per <entity>` grains, and measurement units.
Anti-hallucination: fills empty slots only (pg_description/curator values
never overwritten), unknown ids dropped, strings length-capped, model
instructed to emit null rather than guess a unit. Full audit trail + token
cost in BUILD_REPORT.json. Runs before importance so an LLM grain wins over
the template.

### P4 — Exemplar factory from the golden corpus (`a3094b6`)
**Axis: accuracy (compounding).** The bundle shipped 2–3 hand-written
exemplar literals; `load_additional_exemplars` was dead. `build_golden_exemplars`
turns `eval/golden/*.jsonl` into few-shot exemplars, EXPLAIN-validated
against the build's own read-only-attached topology ("validated" =
proven-to-bind, never asserted). Every benchmark failure fixed into the
golden set becomes a retrievable few-shot example on the next build —
exemplar embedding + BM25 top-3 recall already existed.

> **2026-07 staging fix (`cli.py` `duckdb_attach_dsn`).** The exemplar factory
> attaches the source DSN to DuckDB for EXPLAIN validation, but prep
> introspection uses a SQLAlchemy DSN (`postgresql+psycopg://…`, mandatory in a
> psycopg3-only venv) that DuckDB's postgres scanner cannot parse — so P4
> silently skipped (`goldenExemplars: 0`) against any real Postgres. Now the
> `+driver` suffix is stripped before the DuckDB attach so the SAME `STAGING_DSN`
> serves both consumers; golden exemplars actually validate against staging.

### P5 — Soft-delete detection + prompt exclusion rule (`aebb08f`)
**Axis: accuracy (silent-wrong class).** Detects the three common
conventions by name+type (deleted-timestamp `DeletedAt…`, deleted-flag
`IsDeleted…` boolean-only, active-flag `IsActive/Active` boolean-only;
domain states like `Cancelled` deliberately not matched) and renders one
exclusion line, e.g. `soft delete: rows with "DeletedAt" IS NOT NULL are
logically DELETED — add "DeletedAt" IS NULL unless deleted rows are
explicitly requested`.

---

## Pipeline-stage improvements

### R1 — Model routing + escalate-on-repair (`699ab13`, opt-in envs)
**Axis: cost + latency, never accuracy.** Two levers grounded in
BENCHMARK_FINDINGS (cheap tier silently wrong on multi-hop; repair loops are
the cost amplifier):
- `NL2SQL_LLM_MODEL_SIMPLE`: cheap tier drives the INITIAL call only when
  retrieval proves the question join-free (`route_is_simple`: exactly one
  rendered table — deliberately the strongest simplicity signal only).
- `NL2SQL_LLM_MODEL_REPAIR`: repair rounds run on the escalation model
  instead of retrying the model that just failed (same-model retries
  frequently re-fail; escalation converts two likely-failing calls into one
  likely-passing call).

Metering restructured to per-call pricing — a mixed-tier request previously
would have priced all summed tokens at the last call's rate (latent bug,
now fixed + tested).

### R2 — Static-context mode for small bundles (`69fb648`, opt-in `NL2SQL_STATIC_CONTEXT_MAX_TOKENS`)
**Axis: all three.** At the current 14-table staging scope, hybrid retrieval
solves a problem we don't have while creating two we do (retrieval misses;
cache-defeating variable prompts). When the whole bundle renders within the
bound (decided once at load, deterministic order), `retrieve()`
short-circuits: every table, full columns, all edges. No retrieval miss is
possible; the embedder is never invoked; the schema/join-graph/warnings
prompt prefix is byte-identical across questions and `assemble_prompt`
orders the only question-varying section (SEMANTIC HINTS) after it, so the
provider prompt cache prices the bulk of every prompt at ~10% of the input
rate. **Measured (hermetic benchmark, below): retrieve 7.6 ms → 0.12 ms,
20.7% of prompt tokens cached, −13% cost, accuracy unchanged 10/10.** The
cached fraction grows with prompt size — the tiny fixture bundle barely
clears OpenAI's 1024-token cache minimum; the real staging bundle (~2.5k-token
prompts) caches proportionally much more.

### R3 — Structured outputs (`e1bd206`, on by default with runtime fallback)
**Axis: errors/cost.** `OpenAiLlmClient` requests a strict json_schema
`{sql, description}` response format, killing the two extraction failure
shapes seen in production (fence/prose ambiguity; mid-SQL truncation →
TokenError → a burned repair round each). A model that rejects
`response_format` gets one plain-text retry and the feature disables for the
process lifetime. `extract_sql` already handled the JSON contract — pipeline
unchanged.

### R4 — Per-request DuckDB cursors (`41bb843`)
**Axis: latency under concurrency.** `execute()`/`explain()` run on per-call
`conn.cursor()`s instead of serializing every query behind one lock — one
slow federated query no longer blocks every other user's sub-second query
(asserted by a wall-clock overlap test). Hardening
(`enable_external_access=false`, `lock_configuration=true`) is
instance-global and covers cursors (tested: INSTALL/LOAD/read_csv/SET all
blocked through a cursor; writes still fail on READ_ONLY attach). Bonus fix:
`explain(catalog=…)`'s `USE` no longer leaks onto the shared connection, and
a deadline timeout now interrupts only its own cursor.

### R5 — Semantic question cache (`21eb4d5`, opt-in `NL2SQL_SEMANTIC_CACHE=true`)
**Axis: latency + cost on paraphrase repeats.** Embedding-similarity cache
(0.97 cosine default) in front of generate: a paraphrase hit skips the whole
LLM round trip (the dominant 1.2–11 s latency and the entire token cost).
Strict posture because a wrong hit is a silent-wrong answer: off by default,
tenant-scoped (tested), every hit re-EXPLAINed before serving with drop-on-
failure (schema drift), TTL + LRU caps, fail-open in both directions.

---

## The benchmark (`f9a1392`)

`python -m ceiba_nl2sql_eval.benchmark` — drives the REAL `generate_sql`
(the BENCHMARK_FINDINGS lesson: a hand-rolled harness diverged from the
pipeline and reported false failures) over the golden corpus per flag-gated
variant, measuring accuracy (EvalScore incl. result-match vs gold SQL),
latency (e2e + retrieve-only), tokens (the same `UsageSummary` metering
production uses, incl. `cachedPromptTokens`), and cost at real list prices.
`PrefixCacheSimulatingLlm` reproduces OpenAI's prompt-cache mechanics
(1024-token minimum, 128-token increments, longest-seen-prefix) so caching
gains are measured, not guessed. CI-safe (runs in the eval test suite).

First measured run (fixture bundle, 10 golden questions):

| variant | ok | result match | mean prompt tok | cached tok (frac) | est. cost | mean retrieve ms |
|---|---|---|---|---|---|---|
| baseline-hybrid | 10/10 | 10/10 | 1089 | 0 (0%) | $0.0106 | 7.6 |
| static-context | 10/10 | 10/10 | 1113 | 2304 (20.7%) | $0.0092 | 0.12 |

### Measuring the live gains
The same corpus + variants against real staging + real models:
1. Build a fresh bundle from staging (picks up P1/P2/P4/P5 enrichment; add
   `--llm-enrich` for P3).
2. Set `OPENAI_API_KEY` (+ `STAGING_DSN` via the tunnel) and run the eval in
   gated-staging mode, once per variant env:
   baseline → `NL2SQL_STATIC_CONTEXT_MAX_TOKENS` unset;
   static → set to 6000; routing → `NL2SQL_LLM_MODEL_SIMPLE=gpt-5.4-nano`
   `NL2SQL_LLM_MODEL_REPAIR=gpt-5.4-mini`.
3. Compare `usage` blocks (now correctly priced per call, incl. cached
   tokens) and execution accuracy per variant.

---

## Configuration summary

| Env | Default | Feature |
|---|---|---|
| `NL2SQL_LLM_MODEL_SIMPLE` | unset (off) | R1 cheap tier for join-free questions |
| `NL2SQL_LLM_MODEL_REPAIR` | unset (off) | R1 repair-round escalation model |
| `NL2SQL_STATIC_CONTEXT_MAX_TOKENS` | unset (off) | R2 static context (suggest 6000 for the 14-table scope) |
| `NL2SQL_SEMANTIC_CACHE` / `_THRESHOLD` | false / 0.97 | R5 paraphrase cache |
| `ceiba-nl2sql-prep build --llm-enrich` | off | P3 LLM annotation pass |
| `NL2SQL_MODEL_PRICES` | built-ins | price overrides (now supports `cached_input`) |

P1/P2/P4/P5 are always-on at the next bundle build; QW1/QW3/R3/R4 are
always-on code fixes (R3 self-disables per process if the model rejects
structured outputs).
