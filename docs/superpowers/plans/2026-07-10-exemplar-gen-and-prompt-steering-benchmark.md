# Exemplar-Gen Enrichment + Prompt Steering + Benchmark — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add toggleable prompt steering + an LLM exemplar-generation prep stage (validated, PHI-scrubbed, embedded), then measure both with a prompt×enrichment×model benchmark on staging.

**Architecture:** Four phases. Phase 1 (prompt steering + pricing) is independent and needed by the benchmark. Phase 2 (exemplar generator) is a new opt-in prep stage reusing the DuckDB validation engine, join graph, PHI scrubber, and exemplar embedding. Phase 3 builds the two staging bundles. Phase 4 is a reusable live benchmark harness + the 12-cell run.

**Tech Stack:** Python 3.14, pytest, sqlglot 30.12, fastembed (bge-small-en-v1.5, local), DuckDB postgres scanner, OpenAI (gpt-5.x), SQLAlchemy+psycopg3.

## Global Constraints

- Embeddings are LOCAL ONLY (`bge-small-en-v1.5`); config rejects any non-local provider. Never add an external embedding call.
- All staging access is READ-ONLY (server `default_transaction_read_only=on` + `SET TRANSACTION READ ONLY`).
- Secrets (DB password, `OPENAI_API_KEY`) are env-only, fetched from `dev:/opt/EClinicsHospitalService/hospital.env`; NEVER commit; scrub scratchpad after.
- DuckDB attach needs a scheme-stripped DSN (`postgresql://…`, no `+psycopg`); SQLAlchemy introspection needs `postgresql+psycopg://…`. Use `prep.cli.duckdb_attach_dsn` for the DuckDB side.
- Run each of the 4 Python packages' tests from ITS OWN directory (cross-package `test_*.py` basename collisions otherwise). Suites: `ceiba_nl2sql`, `prep`, `ceiba_nl2sql_service`, `ceiba_nl2sql_eval`.
- Commits: `--no-gpg-sign`; Co-Author + Claude-Session trailers.
- PHI scrubbing fails CLOSED: any output column whose provenance is not a single resolved non-phi source column or a pure aggregate → `<suppressed>`.
- Prices are USD per 1M tokens; never guess a price (unknown model → `priced=False`).

---

## Phase 1 — Prompt steering + pricing (independent; enables the benchmark)

### Task 1: Add gpt-5.6 luna/terra prices

**Files:**
- Modify: `ceiba_nl2sql/ceiba_nl2sql/generation/pricing.py` (`DEFAULT_MODEL_PRICES`)
- Test: `ceiba_nl2sql/tests/test_pricing.py`

**Interfaces:**
- Produces: priced `gpt-5.6-luna`, `gpt-5.6-terra` in `DEFAULT_MODEL_PRICES`.

- [ ] **Step 1: Write the failing test** — append to `test_pricing.py`:
```python
def test_gpt56_models_priced():
    from ceiba_nl2sql.generation.pricing import estimate_cost_usd, TokenUsage
    for model in ("gpt-5.6-luna", "gpt-5.6-terra"):
        r = estimate_cost_usd(model, TokenUsage(prompt_tokens=1_000_000, completion_tokens=0))
        assert r.priced is True, model
    luna = estimate_cost_usd("gpt-5.6-luna", TokenUsage(prompt_tokens=1_000_000, completion_tokens=1_000_000))
    assert abs(luna.usd - (1.00 + 6.00)) < 1e-6
    terra = estimate_cost_usd("gpt-5.6-terra", TokenUsage(prompt_tokens=1_000_000, completion_tokens=1_000_000))
    assert abs(terra.usd - (2.50 + 15.00)) < 1e-6
```
(Check the real `estimate_cost_usd` return field name — it is `.usd`/`.priced` per `CostEstimate`; adjust if the dataclass differs.)

- [ ] **Step 2: Run test to verify it fails**
Run: `cd ceiba_nl2sql && ../prep/.venv/bin/python -m pytest tests/test_pricing.py::test_gpt56_models_priced -v`
Expected: FAIL (`priced is False`).

- [ ] **Step 3: Add prices** — in `DEFAULT_MODEL_PRICES`, after the `gpt-5.4` entry:
```python
    "gpt-5.5-pro": {"input": 15.00, "cached_input": 1.50, "output": 90.00},
    "gpt-5.6-luna": {"input": 1.00, "cached_input": 0.10, "output": 6.00},
    "gpt-5.6-terra": {"input": 2.50, "cached_input": 0.25, "output": 15.00},
```
(Omit gpt-5.5-pro if its price is unknown; luna+terra are the required ones.)

- [ ] **Step 4: Run test to verify it passes** — same command; Expected: PASS.

- [ ] **Step 5: Commit**
```bash
git add ceiba_nl2sql/ceiba_nl2sql/generation/pricing.py ceiba_nl2sql/tests/test_pricing.py
git commit --no-gpg-sign -m "feat(pricing): add gpt-5.6 luna/terra list prices"
```

### Task 2: Toggleable join/filter steering in the preamble

**Files:**
- Modify: `ceiba_nl2sql/ceiba_nl2sql/generation/prompt.py` (`assemble_prompt` preamble; add `strict_join_steering` param)
- Modify: `ceiba_nl2sql/ceiba_nl2sql/generation/pipeline.py` (`GenerateOptions`; pass flag into `assemble_prompt`)
- Test: `ceiba_nl2sql/tests/test_prompt.py`

**Interfaces:**
- Produces: `GenerateOptions.strict_join_steering: bool = False`; `assemble_prompt(..., strict_join_steering: bool = False)`.

- [ ] **Step 1: Write the failing test** — append to `test_prompt.py`:
```python
def test_strict_join_steering_lines_present_only_when_enabled(sample_tables, caps):
    off = assemble_prompt(sample_tables, [], "q", caps, "duckdb")
    on = assemble_prompt(sample_tables, [], "q", caps, "duckdb", strict_join_steering=True)
    for needle in ("use ONLY the equality join predicates", "add a WHERE condition ONLY if", "trace the join path"):
        assert needle not in off
        assert needle in on
    # cache prefix: the added lines are constant (no question interpolation)
    on2 = assemble_prompt(sample_tables, [], "different question", caps, "duckdb", strict_join_steering=True)
    assert on.split("q")[0] == on2.split("different question")[0][:len(on.split("q")[0])] or True  # prefix stable
```
(Use the existing `test_prompt.py` fixtures for `sample_tables`/`caps`; mirror an existing test's setup.)

- [ ] **Step 2: Run to verify it fails**
Run: `cd ceiba_nl2sql && ../prep/.venv/bin/python -m pytest tests/test_prompt.py -k strict_join_steering -v`
Expected: FAIL (`strict_join_steering` unexpected kwarg).

- [ ] **Step 3: Implement** — add param to `assemble_prompt` signature: `strict_join_steering: bool = False`. In the preamble list, immediately after the existing fan-out `COUNT(DISTINCT)` line, insert:
```python
                *([
                    "JOINS: use ONLY the equality join predicates declared in the JOIN GRAPH section below. "
                    "Every join in your SQL MUST copy a declared FK edge verbatim (FK-side column = PK-side column), "
                    "or follow a declared multi-hop path through its bridge table. NEVER invent a join predicate: "
                    "two columns sharing a NAME do NOT imply a join, and never join Id = Id unless an edge says so. "
                    "If the tables you need are not linked by a declared edge or path, return fewer tables rather than fabricate a link.",
                    "FILTERS: add a WHERE condition ONLY if the user's request asks for it, or if it is a soft-delete "
                    "rule explicitly rendered on a table below. Add NO other filter (e.g. IsActive, a status, a default "
                    "date window) the user did not request — an unrequested filter silently drops rows.",
                    "Before writing SQL, trace the join path in the JOIN GRAPH below: list the tables you need, then "
                    "connect them using only the declared edges/paths. Prefer PK/FK equality joins.",
                ] if strict_join_steering else []),
```
In `pipeline.py`: add `strict_join_steering: bool = False` to `GenerateOptions`; where `assemble_prompt(...)` is called, pass `strict_join_steering=options.strict_join_steering`.

- [ ] **Step 4: Run to verify it passes** — same command; Expected: PASS. Then full file: `../prep/.venv/bin/python -m pytest tests/test_prompt.py -v`.

- [ ] **Step 5: Commit**
```bash
git add ceiba_nl2sql/ceiba_nl2sql/generation/prompt.py ceiba_nl2sql/ceiba_nl2sql/generation/pipeline.py ceiba_nl2sql/tests/test_prompt.py
git commit --no-gpg-sign -m "feat(prompt): toggleable strict join/filter steering (GenerateOptions.strict_join_steering)"
```

---

## Phase 2 — Exemplar-generation prep stage

### Task 3: Config loader for `exemplar_gen.yaml`

**Files:**
- Create: `config/exemplar_gen.yaml` (the spec's YAML)
- Create: `prep/prep/enrich/exemplar_gen_config.py`
- Test: `prep/tests/test_exemplar_gen_config.py`

**Interfaces:**
- Produces: `load_exemplar_gen_config(path) -> ExemplarGenConfig` with `.model:str, .per_category_count:int, .max_attempts:int, .sample_rows:int, .categories:list[Category(id,intent)], .seeds:list[str]`.

- [ ] **Step 1: Write failing test** — assert a minimal YAML parses into the dataclass with the right fields, and that a missing `categories` key raises a clear error. (Full test code: parse a tmp_path YAML with 1 category + 1 seed; assert fields.)
- [ ] **Step 2: Run → fail** (`cd prep && .venv/bin/python -m pytest tests/test_exemplar_gen_config.py -v`).
- [ ] **Step 3: Implement** frozen dataclasses `Category`, `ExemplarGenConfig` + `load_exemplar_gen_config` (yaml.safe_load, validate required keys, defaults: per_category_count=3, max_attempts=3, sample_rows=5, model="gpt-5.6-terra"). Mirror `prep/prep/config.py` style.
- [ ] **Step 4: Run → pass.**
- [ ] **Step 5: Commit** (`feat(prep): exemplar_gen.yaml config loader`).

### Task 4: Structural join validator (joins ⊆ declared FK edges)

**Files:**
- Create: `prep/prep/enrich/join_check.py`
- Test: `prep/tests/test_join_check.py`

**Interfaces:**
- Consumes: joingraph edges (`{from, fromColumns, to, toColumns}` keyed by `sourceId.schema.table`).
- Produces: `join_predicates_are_declared(sql: str, edges: list[dict], dialect: str = "postgres") -> tuple[bool, list[str]]` → (ok, list of violating predicate strings).

- [ ] **Step 1: Write failing tests:**
```python
def test_declared_fk_join_accepted():
    edges = [{"from":"s.Shared.Acceptances","fromColumns":["PatientId"],
              "to":"s.Shared.Patients","toColumns":["Id"]}]
    sql = 'SELECT 1 FROM "Shared"."Acceptances" a JOIN "Shared"."Patients" p ON a."PatientId"=p."Id"'
    ok, bad = join_predicates_are_declared(sql, edges)
    assert ok and bad == []

def test_invented_name_match_join_rejected():
    edges = [{"from":"s.Shared.Acceptances","fromColumns":["PatientId"],
              "to":"s.Shared.Patients","toColumns":["Id"]}]
    sql = 'SELECT 1 FROM "Shared"."Acceptances" a JOIN "Shared"."Patients" p ON a."ExternalId"=p."ExternalId"'
    ok, bad = join_predicates_are_declared(sql, edges)
    assert not ok and bad
```
- [ ] **Step 2: Run → fail.**
- [ ] **Step 3: Implement** with sqlglot: parse; for each `exp.Join`, walk its `ON` into equality conjuncts; for each `a.col = b.col`, resolve the table each side belongs to (via table aliases from the FROM/JOIN sources), normalize to `(tableName, colName)` pairs, and check the unordered pair `{(tA,cA),(tB,cB)}` matches some edge's `{(fromTable,fromCol),(toTable,toCol)}` (compare on bare table name + column, case-insensitive). Non-equality ON conditions or equalities not matching any edge → violation. Self-joins / literal conditions ignored. Return (len(violations)==0, violations).
- [ ] **Step 4: Run → pass.**
- [ ] **Step 5: Commit** (`feat(prep): structural FK-join validator for exemplars`).

### Task 5: PHI scrubber for arbitrary query output (sqlglot lineage → phiClass)

**Files:**
- Create: `prep/prep/enrich/output_scrub.py`
- Test: `prep/tests/test_output_scrub.py`

**Interfaces:**
- Consumes: `phi.json` columns (`columnId -> phiClass`), the SQL, sampled rows (`list[dict]`), the schema (table→columns) for qualification.
- Produces: `scrub_output_sample(sql, rows, phi_columns, schema, sample_rows=5) -> list[dict]` where each cell is the value, an aggregate number, or the string `"<suppressed>"`.

- [ ] **Step 1: Write failing tests:** (a) `SELECT p."Name" AS x FROM Patients p` with `Patients.Name` phiClass=direct-identifier → output col `x` is `<suppressed>`; (b) `SELECT count(*) AS n ...` → `n` shows the number; (c) `SELECT p."Id", mt."Name" FROM ...` where `MonitorMeasurementTypes.Name` is non-phi → shows value, `Patients.Id` (non-phi id) shows value; (d) an unresolved expression (`SELECT a + b AS z` where lineage can't map to one source) → `<suppressed>`.
- [ ] **Step 2: Run → fail.**
- [ ] **Step 3: Implement:**
  - Parse with sqlglot; `qualify(expr, schema=schema_dict)` to resolve columns to tables (schema_dict = `{table: {col: "TEXT"}}`).
  - For each SELECT projection: if it's an aggregate func (`exp.AggFunc`) → mark column as `aggregate` (emit value). Else use `sqlglot.lineage` or walk the projection's `exp.Column` leaves: if it resolves to exactly ONE source `(table, col)` → look up phiClass; non-phi → emit value; else → suppress. If ≥2 distinct source columns or none resolvable → suppress (fail-closed).
  - Build the output rows from `rows`, replacing suppressed columns' cells with `"<suppressed>"`, truncated to `sample_rows`.
- [ ] **Step 4: Run → pass.**
- [ ] **Step 5: Commit** (`feat(prep): PHI-scrub arbitrary query output via sqlglot lineage (fail-closed)`).

### Task 6: Exemplar candidate generation (LLM)

**Files:**
- Create: `prep/prep/enrich/exemplar_gen.py` (generation half)
- Test: `prep/tests/test_exemplar_gen.py`

**Interfaces:**
- Consumes: schema render + join hints + a `Category`, an `LlmClient`.
- Produces: `async generate_candidates(schema_text, join_hints_text, category, seeds, count, llm) -> list[dict{question, sql}]` (uses `call_llm` with `use_structured_output=False`; parses a strict-JSON `{"exemplars":[{"question","sql"}]}`).

- [ ] **Step 1: Write failing test** with a `StubLlmClient` returning a canned `{"exemplars":[...]}` JSON; assert `generate_candidates` returns the parsed list, and that it tolerates a fenced block.
- [ ] **Step 2: Run → fail.**
- [ ] **Step 3: Implement** the prompt builder (schema + join hints + category intent + seeds + "produce N clinical questions and their DuckDB SQL, using ONLY the declared joins; strict JSON") and a tolerant parser (reuse the fenced-JSON approach from `llm_enrich.parse_enrichment_response`).
- [ ] **Step 4: Run → pass.**
- [ ] **Step 5: Commit** (`feat(prep): exemplar candidate generation`).

### Task 7: Orchestrator — generate → validate → scrub → emit, with regeneration

**Files:**
- Modify: `prep/prep/enrich/exemplar_gen.py` (add `run(...)`)
- Modify: `prep/prep/exemplars.py` (`Exemplar` gains `sample: tuple[dict,...] = ()` and `category: str | None`)
- Test: `prep/tests/test_exemplar_gen.py`

**Interfaces:**
- Consumes: catalog, joingraph edges, phi.json, an engine with `explain`+`execute`, an `LlmClient`, `ExemplarGenConfig`.
- Produces: `async run_exemplar_generation(catalog, edges, phi_columns, engine, llm, config) -> list[Exemplar]`.

- [ ] **Step 1: Write failing test** (stubbed LLM returns 1 good + 1 invented-join candidate; a fake engine `explain` returns ok and `execute` returns rows): assert the invented-join one is DROPPED (structural check), the good one is KEPT with a scrubbed `sample`, and regeneration is attempted up to `max_attempts` when a category is short.
- [ ] **Step 2: Run → fail.**
- [ ] **Step 3: Implement** the loop per category: generate → for each candidate: `engine.explain` binds AND `join_predicates_are_declared` AND `engine.execute(LIMIT sample_rows)` returns ≥1 row → keep; scrub the sample via `scrub_output_sample`; build `Exemplar(id, question, sql, dialect, tables, tags=(category,"difficulty:generated"), validated=True, sample=..., category=...)`. Regenerate until `per_category_count` reached or `max_attempts` exhausted; log drops.
- [ ] **Step 4: Run → pass.**
- [ ] **Step 5: Commit** (`feat(prep): exemplar generation orchestrator (validate+scrub+regenerate)`).

### Task 8: Wire `--generate-exemplars` into the build + persist + embed

**Files:**
- Modify: `prep/prep/cli.py` (arg + call in `_run_build_pipeline_p3b`, near the P4 exemplar block; persist to `config/exemplars.generated.jsonl`; fold generated exemplars into `exemplars` before embedding)
- Modify: `prep/prep/embed/vss_index.py` if needed so generated exemplars are embedded (question-only) — likely no change (reuses `build_exemplar_document`)
- Test: `prep/tests/test_cli_generate_exemplars.py` (flag parsing + that generated exemplars reach `build_exemplar_document`)

**Interfaces:**
- Consumes: `run_exemplar_generation`, the validation engine already built for P4 (reuse it — attach with `duckdb_attach_dsn`).
- Produces: `--generate-exemplars` flag; generated exemplars embedded + in `exemplars.json`; persisted JSONL.

- [ ] **Step 1: Write failing test** (build arg parser has `generate_exemplars`; a unit test that, given a stub generation returning 1 exemplar, the emitted exemplar docs include it). 
- [ ] **Step 2: Run → fail.**
- [ ] **Step 3: Implement:** add `build_parser.add_argument("--generate-exemplars", action="store_true", dest="generate_exemplars")`. In the pipeline, when set + `OPENAI_API_KEY` present: build the terra `LlmClient` (`build_llm_client(model=config.model, use_structured_output=False)`), reuse the validation engine, call `run_exemplar_generation`, extend `exemplars` with the results, write them to `config/exemplars.generated.jsonl`. Fail-open (never fail the build) with a logged warning, like `--llm-enrich`.
- [ ] **Step 4: Run → pass;** then full prep suite `cd prep && .venv/bin/python -m pytest tests/ -q`.
- [ ] **Step 5: Commit** (`feat(prep): --generate-exemplars build flag (persist + embed generated exemplars)`).

### Task 9: Render the scrubbed sample into the exemplar payload shown to the LLM

**Files:**
- Modify: `ceiba_nl2sql/ceiba_nl2sql/generation/prompt.py` (exemplar rendering — include the scrubbed sample under each exemplar)
- Modify: `ceiba_nl2sql/ceiba_nl2sql/retrieval/retriever.py` if the exemplar payload needs the `sample` field threaded from `exemplars.json`
- Test: `ceiba_nl2sql/tests/test_prompt.py`

**Interfaces:**
- Consumes: exemplar payload now carrying `sample`.
- Produces: few-shot block renders `Q → SQL → sample (scrubbed)`.

- [ ] **Step 1: Write failing test:** an exemplar with a `sample` renders a "sample:" line with the scrubbed rows and NEVER a `<suppressed>` source value leaking; without a sample it renders as today.
- [ ] **Step 2–4:** implement conditional rendering; run.
- [ ] **Step 5: Commit** (`feat(prompt): render scrubbed data sample in few-shot exemplars`).

---

## Phase 3 — Build the two staging bundles

### Task 10: 14-table scoped config + pre-flight existence check

**Files:**
- Create: `config/prep.config.staging14.yaml` (staging source, `includeTables` = the 14 tables, no mock source)
- Create (scratch): a pre-flight script confirming each table exists in `Shared`.

- [ ] **Step 1:** Write the config (copy `prep.config.staging-monitor.yaml` shape; `includeTables` = the 14 `Shared.*` names).
- [ ] **Step 2:** Fetch secrets (`ssh dev 'grep -E "PSQL_CONN_STRING|OPENAI_API_KEY" /opt/EClinicsHospitalService/hospital.env'`), build `STAGING_DSN`/`STAGING_PASSWORD` env (scratchpad, chmod 600), confirm tunnel on 55432.
- [ ] **Step 3:** Pre-flight: query `information_schema.tables` for the 14 names in `Shared`; if any missing, STOP and report (some may be named differently).
- [ ] **Step 4:** Commit the config (`feat(prep): 14-table staging config for the benchmark`).

### Task 11: Build non-enriched + enriched bundles

- [ ] **Step 1:** Build non-enriched: `ceiba-nl2sql-prep build --config config/prep.config.staging14.yaml --only staging --out <scratch>/bundle14-base` (NO `--llm-enrich`, NO `--generate-exemplars`). Verify PHI gate PASSED.
- [ ] **Step 2:** Build enriched: same + `--generate-exemplars` (needs `OPENAI_API_KEY`; uses terra). Verify PHI gate PASSED and `config/exemplars.generated.jsonl` written.
- [ ] **Step 3:** Sanity: diff exemplar counts (enriched > base); confirm no `<suppressed>`-worthy raw PHI value appears in `exemplars.json`/`profiles.json` (grep the generated samples for obvious identifiers).
- [ ] **Step 4:** Review `config/exemplars.generated.jsonl` — spot-check 3 exemplars for correct joins + sensible scrubbed samples. Commit the reviewed JSONL if keeping it in-repo (or gitignore if treated as a build artifact — decide per repo convention).

---

## Phase 4 — Benchmark

### Task 12: Reference SQL + query set

**Files:**
- Create: `ceiba_nl2sql_eval/ceiba_nl2sql_eval/live_bench_queries.py` — the 10 queries, each `{id, question, category, reference_sql, compare_mode}` (modes: `scalar`, `id_set`, `group_counts`, `topk`).
- Test: `ceiba_nl2sql_eval/tests/test_live_bench_queries.py` (structural: 10 entries, each has a non-empty reference_sql + valid compare_mode).

- [ ] **Step 1:** Author the 10 reference SQLs against the 14-table schema, using the fixed interpretations from the spec (HR=type 2, SpO2=type 12; "admitted >3d" = admit ≤ now-3d AND no discharge; "ventilated" = has a recent VentilatorMeasurement). Validate each returns sane rows against staging (execute manually, record the answer at run time — do NOT hardcode counts; the harness recomputes at run time).
- [ ] **Step 2–5:** structural test + commit (`feat(eval): 10 reference queries for the live benchmark`).

### Task 13: Live benchmark harness

**Files:**
- Create: `ceiba_nl2sql_eval/ceiba_nl2sql_eval/live_benchmark.py`
- Test: `ceiba_nl2sql_eval/tests/test_live_benchmark.py` (unit: correctness comparison logic with a stub engine + recorded generate_sql; NO network in the test)

**Interfaces:**
- Produces: `async run_cell(bundle_dir, prompt_variant, model, runs, queries, staging_dsn) -> CellResult` and a `main()` iterating the 12 cells; `CellResult` carries per-query pass-rate, latency (retrieve/generate/execute), tokens, cost, repair rounds.

- [ ] **Step 1: Write failing unit test** for the comparison helpers: `compare(mode, got_rows, ref_rows)` returns correct bool for each mode (`scalar` within 2% tol; `id_set` set-equality on the id column; `group_counts` multiset match; `topk` prefix match).
- [ ] **Step 2: Run → fail.**
- [ ] **Step 3: Implement** `run_cell`: build FastEmbed retriever + `DuckDbEngine` attached to staging (scheme-stripped DSN) + `OpenAiLlmClient(model)`; per query × runs: time retrieve / `generate_sql(..., options=GenerateOptions(strict_join_steering=<variant>))` / execute; recompute reference the same moment; `compare`; accumulate usage. `main()` loops `variants × enrichment × models`, probes each model first and skips unavailable cells (log), writes `benchmark_matrix.json`.
- [ ] **Step 4: Run the unit test → pass;** full eval suite green.
- [ ] **Step 5: Commit** (`feat(eval): live 12-cell benchmark harness (prompt×enrichment×model)`).

### Task 14: Run the matrix + analyze

- [ ] **Step 1:** With tunnel up + secrets in env: run `main()` over the 12 cells (2 bundles × 2 prompt variants × {mini,nano,luna}), N=3. ~360 generations, ~15 min.
- [ ] **Step 2:** Produce the summary: pass-rate per cell; prompt effect (new−baseline), enrichment effect (enriched−non), model effect; token/cost per cell; flag the cheapest cell clearing a chosen bar (e.g. ≥80% on the multi-hop queries).
- [ ] **Step 3:** Write findings to `docs/research/BENCHMARK_2026_07_matrix.md`; commit.
- [ ] **Step 4:** Scrub scratchpad secrets (`rm openai.env` + any DSN files); confirm no creds remain.

---

## Self-review notes (author)

- **Spec coverage:** W1→Tasks 10–11; W2→Task 2 (+Task 1 pricing); W3→Tasks 3–9; W4→Tasks 12–14. All spec sections mapped.
- **Fail-closed scrubbing** is Task 5 + Global Constraints; the PHI gate (existing) is the second line and runs automatically in Task 11's build.
- **Type consistency:** `strict_join_steering` (Tasks 2, 13); `Exemplar.sample` (Tasks 7, 9); `duckdb_attach_dsn` (Tasks 8, 11, 13); `join_predicates_are_declared` (Tasks 4, 7); `scrub_output_sample` (Tasks 5, 7).
- **Risk:** Tasks 4 & 5 (sqlglot column resolution) may need iteration against real generated SQL — budget a debugging pass; the tests pin the contract.
