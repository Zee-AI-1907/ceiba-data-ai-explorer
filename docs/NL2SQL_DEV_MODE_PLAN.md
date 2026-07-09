# NL→SQL Dev-Mode REPL — Plan

> Status: PLAN ONLY. No production code changed by this document.

## Goal

Give a developer a `uv run dev`-style command that boots the real pipeline
(real bundle, real engine, real — or stubbed — LLM) and drives it
interactively: type a natural-language question, watch each pipeline stage
report progress live, then see the generated SQL and a sample of the rows it
returns.

This formalizes what `docs/research/BENCHMARK_FINDINGS.md` describes doing by
hand (iteratively firing questions at real staging, reading generated SQL,
checking row counts) into a reusable tool, and gives fast qualitative
feedback on prompt/guard/retrieval changes without standing up the FastAPI
service or writing a one-off script each time.

## Current Pipeline Steps (ground truth: `generate_sql`)

All refs are `ceiba_nl2sql/ceiba_nl2sql/generation/pipeline.py`. This is the
exact sequence the REPL must surface, in order:

| # | Step | Code ref | What happens | Interesting payload |
|---|------|----------|---------------|----------------------|
| 1 | **Retrieve** | `pipeline.py:430` — `await offload(retriever.retrieve, question, retrieve_options)` | `HybridRetriever.retrieve` (`retrieval/retriever.py:862`): glossary-expand → hybrid table recall (dense+BM25+importance RRF) → column recall → FK graph-expand → BFS bridge-expand (join paths) → LLM-prune → render within token budget. BLOCKING (embed + BM25), always offloaded. | `SchemaContext`: `tables` (with `role` primary/bridge), `join_hints`, `join_paths`, `cardinality_warnings`, `glossary_hits`, `exemplars`, `token_estimate` |
| 2 | **Assemble prompt** | `pipeline.py:435` — `assemble_prompt(...)` | Builds the H25-delimited prompt from the retrieved context + join graph + semantic hints (`generation/prompt.py`). Pure/fast, in-process. | prompt text, byte/token-estimate, table count, join-hint count |
| 3 | **LLM call (initial)** | `pipeline.py:453` — `await call_llm(llm, initial_prompt, "schema-metadata")` | Egress-gated call to the injected `LlmClient`. Increments `llm_calls`, accumulates `TokenUsage`. | raw completion text, model id, prompt/completion tokens, latency |
| 4 | **Extract SQL** | `pipeline.py:459` — `extract_sql(completion)` | Recovers SQL from fenced/JSON/bare completion; also detects the `{"error":"scope"}` out-of-scope sentinel (`pipeline.py:461`). | candidate SQL, description, `scope` short-circuit |
| 5 | **Validate: guard_sql** | `_validate_candidate` → `pipeline.py:239` — `guard_sql(...)` | sqlglot-based dialect-aware read-only guard (`sqltools/guard.py`): rejects non-SELECT/WITH, multi-statement, DDL/write verbs anywhere incl. inside a CTE. | `GuardResult.allowed`, `.reason`, `.statement_type` |
| 6 | **Validate: cardinality_guard** | `pipeline.py:285` — `cardinality_guard_from_context(...)` | Syntactic guard (`guard/cardinality.py`): pass / repair (auto-append LIMIT) / reject (unbounded scan of a large/time-series table with no bounding predicate). | `CardinalityVerdict.action`, `.repaired_sql`, `.repair_hint` |
| 7 | **Validate: Postgres EXPLAIN estimate** (optional) | `pipeline.py:312-334` — `pg_explain_estimate` + `evaluate_plan_estimate` | Only runs when `source_dsn`/`pg_explain_runner` configured AND a large table is touched. Authoritative selectivity signal from real Postgres `EXPLAIN`; can overturn a syntactic pass. Never runs `ANALYZE`. | `PlanEstimate`, `ExplainVerdict.action` (pass/repair/reject/defer), `.reason` |
| 8 | **Validate: engine.explain** | `pipeline.py:340` — `engine.explain(sql_for_explain)` | Dry-run plan validation against the real engine (DuckDB federation) — **zero rows egress here**. BLOCKING, offloaded. | `PlanOk.plan` text or `PlanError.error` |
| 9 | **Self-repair loop** (≤ 2 rounds) | `pipeline.py:488-528` | On any repairable failure from 5–8, builds `assemble_repair_prompt` (carries the same join graph/hints + the failure's error/hint/failed_sql), re-calls the LLM, re-validates. | round number, failure reason/hint that triggered it, repaired SQL |
| 10 | **Return** | `pipeline.py:541` | `SqlGenerateResponse`: final `sql`, `description`, `dialect`, `retrieval` summary, `repair` info, `usage` (cost/tokens/latency). SQL is returned **untrusted** — never executed by this function. | final SQL, `UsageSummary` |
| 11 | **Execute (REPL-only, not part of `generate_sql`)** | N/A — the REPL calls `engine.execute(sql, ExecuteOptions(max_rows=N))` itself, mirroring what `POST /nl2sql/execute` does in the service | Runs the (re-guardable) final SQL against the real attached engine and fetches a capped row sample. | `EngineResult.rows`, `.row_count`, `.truncated` |

Everything through step 10 is exactly what the FastAPI `/nl2sql/generate`
route and the eval harness (`ceiba_nl2sql_eval/ceiba_nl2sql_eval/run_eval.py`)
already drive. Step 11 (execute) is what the eval's `score_candidate` and the
service's separate `/nl2sql/execute` route do — the REPL adds it as the
final, optional "show me the data" step, same re-guard-before-execute posture
as the service.

## Entry Point

**Package**: `ceiba_nl2sql_service`. Not `ceiba_nl2sql` (shared lib — must
stay free of CLI/UX deps like `rich`), not `ceiba_nl2sql_eval` (a scoring
harness, not an interactive tool). The dev REPL needs exactly what
`ceiba_nl2sql_service/ceiba_nl2sql_service/deps.py` already builds
(`AppState`: bundle-backed retriever, attached `DuckDbEngine`, lazy
`LlmClient`) — reusing `create_app_state(Settings())` verbatim means the REPL
boots with **the same code path** the real service uses, not a third
reimplementation.

New file: `ceiba_nl2sql_service/ceiba_nl2sql_service/devmode/repl.py` (+
`devmode/__init__.py`, `devmode/rendering.py` for the Rich UI, `devmode/
progress.py` for the instrumentation hook — see below).

`pyproject.toml` addition (mirrors the eval package's existing
`[project.scripts]` pattern exactly — `ceiba_nl2sql_eval/pyproject.toml:18`):

```toml
[project.optional-dependencies]
dev = ["rich>=13"]

[project.scripts]
ceiba-nl2sql-dev = "ceiba_nl2sql_service.devmode.repl:main"
```

`rich` is currently **not installed** anywhere in `prep/.venv` (verified) —
add it as a `dev` extra on the service package specifically, not a hard
dependency of the always-imported `ceiba_nl2sql_service` package, so
`uvicorn ceiba_nl2sql_service.app:app` in prod never needs it.

**`uv run dev` specifically**: the repo has no `uv` workspace today (`prep/
.venv` is a plain pip venv; no `uv.lock`/`uv.toml` anywhere) — `uv` itself is
installed on the machine but unused by this project. Two honest options,
stated plainly rather than glossed over:

1. **Recommended, smallest surface**: add a `[tool.uv] dev = "..."` style
   entry is not a real `uv` feature — `uv run <script-name>` resolves either
   a `[project.scripts]` console-script name or a literal command. So the
   actual invocation is:
   ```
   uv run --project ceiba_nl2sql_service ceiba-nl2sql-dev
   ```
   or, once editable-installed into `prep/.venv` (the existing pattern every
   other package here already follows):
   ```
   ceiba-nl2sql-dev
   ```
2. If the user specifically wants the literal string `uv run dev` to work,
   that requires a `uv` **workspace root** `pyproject.toml` at the repo root
   with a `[tool.uv.scripts]`-style alias — `uv` does not natively support
   arbitrary bare-word aliases like `dev` without one. This is a bigger,
   separate lift (introducing a root-level `uv` workspace spanning all 4
   packages) that is out of scope for this feature and should be a follow-up
   if the team wants `uv` as the standard runner project-wide, not something
   bolted on just for this REPL.

**This plan's recommendation**: ship the `ceiba-nl2sql-dev` console script
(option 1), document `uv run --project ceiba_nl2sql_service ceiba-nl2sql-dev`
as the invocation, and treat "make `uv run dev` literally work" as a
follow-up tracked separately (repo-wide `uv` workspace adoption), since it
touches all 4 `pyproject.toml`s, not just this feature.

**Bootstrap sequence** (`repl.py:main`):
1. Load `Settings()` from env (same `ceiba_nl2sql_service.settings.Settings`
   — `NL2SQL_BUNDLE_DIR`, `MOCK_DSN`/`STAGING_DSN`, `OPENAI_API_KEY`,
   `NL2SQL_LLM_MODEL`), plus new dev-only CLI flags (argparse, layered over
   env — see Config below).
2. Call `create_app_state(settings)` — identical to service startup
   (`ceiba_nl2sql_service/main`-equivalent — actually the FastAPI lifespan;
   there's no separate `main.py` today, `create_app_state` is called from
   the app's lifespan context, so the REPL is the *second* caller of this
   function, not a fork of its logic).
3. Enter the REPL loop.
4. On exit (Ctrl-D / `:quit`), call `state.dispose()` (already exists —
   disposes engine + retriever cleanly).

## Instrumentation Design

### The core tension

`generate_sql` is a single `async def` with no natural yield points for a
UI — it's an orchestrator that calls out to retrieval/LLM/guards/engine and
returns one final `SqlGenerateResponse`. Two ways to get step-by-step
visibility:

- **(A) Re-implement the orchestration in the REPL**, calling
  `retriever.retrieve`, `assemble_prompt`, `call_llm`, `guard_sql`,
  `cardinality_guard_from_context`, `engine.explain` directly, step by step,
  printing between each. **Rejected**: this duplicates `generate_sql`'s
  control flow (including the self-repair loop, which has real branching
  logic at `pipeline.py:488-528`) in a second place that will drift the
  moment the pipeline changes — exactly the kind of duplication
  `BENCHMARK_FINDINGS.md`'s root-cause bug (#7, prompt assembly silently
  dropping join hints) shows is dangerous: a second reimplementation is a
  second place to introduce that same class of bug.

- **(B) Thread an optional callback through `generate_sql` and
  `_validate_candidate`.** **Recommended.**

### Recommended shape: `ProgressSink` protocol, optional param, no-op default

```python
# ceiba_nl2sql/ceiba_nl2sql/generation/progress.py  (NEW, small, dependency-free)

from typing import Protocol, Any

class ProgressSink(Protocol):
    def emit(self, step: str, /, **payload: Any) -> None: ...

class NullProgressSink:
    """Default: costs nothing, does nothing. Every existing caller
    (service route, eval harness, tests) is unaffected because they never
    pass `progress=`."""
    def emit(self, step: str, /, **payload: Any) -> None:
        return None
```

`generate_sql`'s signature grows exactly one new keyword-only parameter:

```python
async def generate_sql(
    *,
    question: str,
    engine: QueryEngine,
    retriever: HybridRetriever,
    llm: LlmClient,
    dialect: SqlDialect | None = None,
    options: GenerateOptions | None = None,
    cached: bool = False,
    offload: Offload = _direct_offload,
    progress: ProgressSink = NullProgressSink(),   # NEW
) -> SqlGenerateResponse:
```

Call sites get one `progress.emit(...)` line each, immediately before/after
the existing statement — **no restructuring of control flow, no new
branches**:

| Step | Insertion point | Emit call |
|---|---|---|
| retrieve start/end | around `pipeline.py:430` | `progress.emit("retrieve", phase="start")` / `progress.emit("retrieve", phase="end", tables=[t.table_id for t in context.tables], join_paths=len(context.join_paths), token_estimate=context.token_estimate, elapsed_ms=...)` |
| assemble prompt | around `pipeline.py:435-452` | `progress.emit("assemble_prompt", prompt_chars=len(initial_prompt), table_count=len(context.tables), join_hint_count=len(context.join_hints))` |
| LLM call | around `pipeline.py:453-457` | `progress.emit("llm_call", round=0, model=result.model, prompt_tokens=result.usage.prompt_tokens, completion_tokens=result.usage.completion_tokens, raw_completion=completion)` |
| extract + scope check | around `pipeline.py:459-470` | `progress.emit("extract_sql", sql=candidate_sql, description=description, scope_rejected=bool)` |
| validate (guard/cardinality/explain, all 3 sub-stages) | inside `_validate_candidate`, which itself needs a `progress` param threaded down from `generate_sql`'s two call sites (`pipeline.py:476` and `:520`) | `progress.emit("guard_sql", allowed=..., reason=...)`, `progress.emit("cardinality_guard", action=..., reason=...)`, `progress.emit("explain_estimate", action=..., reason=...)` (only if it ran), `progress.emit("engine_explain", ok=..., error=...)` |
| repair round | around `pipeline.py:488-528` | `progress.emit("repair_round", round=rounds, trigger_error=failure.error, hint=failure.hint)` |
| final | around `pipeline.py:541` | `progress.emit("done", sql=accepted_sql, repair_rounds=rounds, usage=_build_usage())` |

`_validate_candidate` also grows a `progress: ProgressSink = NullProgressSink()`
keyword param (it's a private module function called only from within
`pipeline.py`, so this is a same-file, low-risk signature change — it is
NOT part of the public `generate_sql` contract, just an internal plumbing
detail).

### Why this is the right amount of invasiveness

- **Every existing call site is untouched.** `create_app_state`'s route
  handlers, `ceiba_nl2sql_eval.run_eval.run_one_item`, and every existing
  test call `generate_sql(...)` with no `progress=` kwarg → gets
  `NullProgressSink()` → the two new emit lines per step execute a no-op
  method call each (protocol dispatch, not even an `if` check) — negligible
  and behaviorally silent.
- **No new control-flow branches.** The `while not ok and rounds <
  max_repair_rounds` loop, the scope-sentinel early return, the
  `GenerationError` raise path are all unchanged; `progress.emit` calls are
  pure side-effect insertions alongside existing statements.
- **It is genuinely invasive in one sense**: it touches `pipeline.py` (the
  single most load-bearing, heavily-scrutinized file in the whole service —
  the file whose docstring itself lists "generation-time quality gate,"
  "explain-not-execute," "self-repair" as invariants). Every insertion must
  be reviewed against those invariants — e.g. it would be a bug for a
  `progress.emit` to accidentally capture or log a `patient-derived` value,
  but nothing in this pipeline ever holds one (SQL text, table names,
  guard verdicts — all schema-metadata-class, never row data), so this is a
  non-issue in practice, but worth stating explicitly since PHI care is a
  first-class concern in this codebase.
- **Not a fork.** Unlike option (A), the actual guard/repair/retry decisions
  are made by the exact same code the service runs — the REPL only observes.

### `ProgressSink` implementation for the REPL

```python
# ceiba_nl2sql_service/ceiba_nl2sql_service/devmode/progress.py

class RichProgressSink:
    """Adapts pipeline.py's progress.emit(...) calls to a live Rich
    console: one line per step, timestamped, with a spinner for in-flight
    steps and a checkmark/x on completion."""
    def __init__(self, console: "rich.console.Console") -> None: ...
    def emit(self, step: str, /, **payload) -> None: ...
```

A second, trivial implementation — `RecordingProgressSink` (append every
`(step, payload)` tuple to a list) — is the unit-test seam: a test builds
one, passes it as `generate_sql(..., progress=sink)`, and asserts on
`sink.events` without needing any terminal/Rich dependency at all.

## REPL UX

### Library: `rich`

Justification: already the de facto standard for exactly this shape of
tool (step logs + spinners + syntax-highlighted SQL + a results table) with
zero heavyweight deps (pure Python, no C extension, no async event-loop
conflicts with this codebase's own `asyncio`-based pipeline). Concretely:
- `rich.console.Console` for plain step-log lines.
- `rich.live.Live` (or simpler: `rich.status.Status`/manual
  console prints — `Live` only if steps need to update in place rather than
  scroll, which is not required here; a scrolling log of completed steps is
  actually more useful for debugging than a single overwritten panel, so
  default to plain sequential prints with a `rich.spinner.Spinner`-backed
  `Console.status()` context manager per in-flight step).
- `rich.syntax.Syntax(sql, "sql", theme=..., line_numbers=True)` for the
  final SQL panel.
- `rich.table.Table` for the sample-rows result set.
- `rich.panel.Panel` to frame the SQL block and the summary (repair rounds,
  cost, latency).
- `prompt_toolkit` is **not** needed — Python's builtin `input()` with a
  simple "type your question, blank line + Enter (or a trailing `;`) to
  submit" convention is enough for multi-line NL questions (rare — most
  questions are one line); avoids adding a second heavy interactive-input
  dependency for marginal benefit.

### Layout sketch

```
ceiba-nl2sql-dev
NL→SQL dev console — bundle: mock-v1 (duckdb)  engine: mock  model: gpt-4o-mini
Type a question (blank line to submit multi-line, Ctrl-D to quit, :help for commands)

> patients with HR above 120 in the last 3 hours

  ⠋ retrieve...                                              done  142ms
      tables: MonitorMeasurements(primary), Monitors(bridge), Acceptances(bridge), Patients(primary)
      join_paths: 1 (3-hop)   token_estimate: 1840
  ⠋ assemble_prompt...                                       done   3ms
      prompt: 1840 tokens (est), 4 tables, 3 join hints
  ⠋ llm_call (round 0, gpt-5.4-mini)...                      done  1180ms
      prompt_tokens=1840 completion_tokens=210
  ⠋ extract_sql...                                           done   1ms
  ⠋ guard_sql...                                             pass
  ⠋ cardinality_guard...                                     pass (bounded via MeasuredDate)
  ⠋ engine_explain...                                        pass

┌─ Generated SQL ──────────────────────────────────────────────────────────┐
│ SELECT p."Id", p."Name" ...                                              │
│ FROM staging."Shared"."Patients" p                                       │
│ JOIN staging."Shared"."Acceptances" a ON ...                             │
│ ...                                                                      │
│ LIMIT 1000                                                               │
└───────────────────────────────────────────────────────────────────────────┘
repair_rounds=0  cost=$0.0003  total_tokens=2050  latency=1.4s

Execute against engine and show sample rows? [Y/n/dry-run]:

┌─ Sample rows (22 total, showing 10) ──────────────────────────────────────┐
│ Id      Name        Value   MeasuredDate           │
│ ...                                                 │
└────────────────────────────────────────────────────┘

> :quit
```

### Behaviors

- **Multi-line input**: a trailing `\` continues the line (matches shell
  convention); blank-line-submit for anything else. Keep it simple —
  clinical NL questions are essentially always single-line.
- **Repeat queries**: `input()` loop with in-process history (Python's
  `readline`/`libedit` gives arrow-key history for free on most terminals
  without extra deps); `:last` re-runs the previous question.
- **Errors**: a `GenerationError` (self-repair exhausted) is caught at the
  REPL's top level and rendered as a red `Panel` with `.rounds`,
  `.last_error`, and the partial `.usage` — never a raw traceback for an
  expected pipeline failure. An unexpected exception (retrieval load
  failure, LLM upstream error) is shown with its message + a `:debug` command
  to re-raise with full traceback for the developer's own investigation.
- **Commands**: `:help`, `:quit`/Ctrl-D, `:last` (re-run), `:sql` (re-print
  last generated SQL), `:model <name>` (swap driving model without
  restarting — rebuilds the `LlmClient` only), `:limit <n>` (change sample
  row cap), `:execute` / `:no-execute` (toggle whether the post-generation
  prompt to run the query defaults to yes/no this session).

## Config / Flags

CLI flags (argparse, `ceiba-nl2sql-dev --help`), each falling back to the
matching `Settings` env var when omitted so the REPL and the service share
one configuration surface:

| Flag | Env fallback | Default | Meaning |
|---|---|---|---|
| `--bundle-dir PATH` | `NL2SQL_BUNDLE_DIR` | *(required, one or the other)* | Artifact bundle to load |
| `--model NAME` | `NL2SQL_LLM_MODEL` | `gpt-4o-mini` | Driving LLM model id |
| `--engine {mock,staging,synthetic}` | derived from `MOCK_DSN`/`STAGING_DSN` | `synthetic` if neither DSN set | Which engine target to attach. `synthetic` uses `ceiba_nl2sql_eval.synthetic.build_synthetic_topology(bundle_dir)` — the SAME hermetic DuckDB-fabrication code the eval harness uses, so a developer with **no DSN configured at all** still gets a fully working REPL with fabricated-but-FK-consistent rows. `mock`/`staging` attach the real DSN via `create_app_state`, same as the service. |
| `--max-rows N` | — | `20` | Sample-row cap for step 11 (execute). Deliberately small — this is a dev console, not a data export tool. |
| `--no-execute` | — | off | Dry-run: stop after generated SQL, never prompt to execute. Useful when only `MOCK_DSN`/`STAGING_DSN` federation is flaky/slow (per `BENCHMARK_FINDINGS.md`'s federation-timeout finding) and the developer only cares about the generated SQL text. |
| `--repair-rounds N` | `GenerateOptions.max_repair_rounds` | `2` | Lets a developer force 0 (see the raw first-shot SQL, no self-repair) for debugging prompt quality specifically. |
| `--source-dsn DSN` | `STAGING_DSN` (reused, not a new var) | unset | Enables the Postgres EXPLAIN cardinality guard step, same as `GenerateOptions.source_dsn`. |

**PHI note (must be stated to the user, not silently assumed)**: steps 1–10
never touch a patient row — everything is schema-metadata-class, matching
the pipeline's own documented egress invariant. **Step 11 (execute) is the
one place real data crosses into the terminal** — the sample rows are real
patient-adjacent data if `--engine staging` is used against `STAGING_DSN`.
This is fine for authorized local dev against the read-only staging DB (same
data a developer can already see via `psql`/eval), but the REPL should print
a one-time banner when `--engine staging` is selected: `"⚠ engine=staging:
sample rows may contain real clinical data from CeibaHospitalDB. Local
terminal only — do not paste output into tickets/chat without redaction."`
This is a reminder banner, not a new access control — the existing read-only
DSN + guard chain is the actual boundary.

## Phased Implementation Plan

**Phase 1 — instrumentation hook (touches `ceiba_nl2sql`)**
- Add `ceiba_nl2sql/ceiba_nl2sql/generation/progress.py`:
  `ProgressSink` protocol + `NullProgressSink`.
- Thread `progress: ProgressSink = NullProgressSink()` through
  `generate_sql` (signature + ~8 emit call sites) and `_validate_candidate`
  (signature + ~4 emit call sites), per the table above.
- No behavior change for any existing caller. Existing test suite
  (`ceiba_nl2sql/tests/test_pipeline.py` or wherever `generate_sql` is
  exercised) must pass unmodified.
- New test: `RecordingProgressSink` + assert the expected step sequence
  fires for (a) a clean pass, (b) a guard-rejected candidate that
  self-repairs once, (c) a repair-exhausted `GenerationError`.

**Phase 2 — package scaffolding (touches `ceiba_nl2sql_service`)**
- `ceiba_nl2sql_service/ceiba_nl2sql_service/devmode/__init__.py`
- `ceiba_nl2sql_service/ceiba_nl2sql_service/devmode/progress.py` —
  `RichProgressSink`.
- `ceiba_nl2sql_service/ceiba_nl2sql_service/devmode/rendering.py` — SQL
  panel, results table, error panel helpers (pure functions taking data,
  returning `rich` renderables — independently testable without a live
  terminal).
- `pyproject.toml`: add `dev = ["rich>=13"]` optional-dependency group +
  `[project.scripts] ceiba-nl2sql-dev = "ceiba_nl2sql_service.devmode.repl:main"`.

**Phase 3 — the REPL loop (touches `ceiba_nl2sql_service`)**
- `ceiba_nl2sql_service/ceiba_nl2sql_service/devmode/repl.py`:
  argparse config resolution → `create_app_state`-equivalent bootstrap
  (reusing `deps.create_app_state`, with the `--engine synthetic` branch
  additionally wired to `ceiba_nl2sql_eval.synthetic.build_synthetic_topology`
  when no DSN is configured — this is the one place the REPL needs a new
  small dependency edge from `ceiba_nl2sql_service` onto
  `ceiba_nl2sql_eval`; if that's judged an inappropriate dependency
  direction, ship a REPL-local copy-light wrapper instead, see Open
  Questions) → the `input()` loop → per-question: `RichProgressSink()` →
  `generate_sql(..., progress=sink)` → render SQL panel → prompt to execute
  → `engine.execute(...)` → render results table.
- Ctrl-C during an in-flight LLM call cancels that question only (catches
  `KeyboardInterrupt` around the `await generate_sql(...)` call), returns to
  the prompt rather than killing the process.

**Phase 4 — polish**
- `:model`, `:limit`, `:execute`/`:no-execute`, `:last`, `:sql`, `:debug`
  commands.
- `--no-execute` / small default `--max-rows` as safety defaults.
- README/docs snippet in `ceiba_nl2sql_service/README.md` (or create one if
  absent) documenting the invocation and the staging-PHI banner behavior.

## Test Strategy

- **Phase 1's `ProgressSink` is fully unit-testable without any REPL/Rich
  dependency**: `RecordingProgressSink` is a ~5-line fake; tests assert
  exact `(step, payload_keys)` sequences for the pass/repair/reject paths
  using the existing `StubLlmClient`/hermetic fixture bundle the current
  pipeline tests already use — this is genuinely cheap to test well.
- **Phase 2's rendering helpers** (`rendering.py`) are pure functions
  (data → `rich` renderable object), testable by asserting on the
  renderable's structure or rendered plain-text (`rich.console.Console
  (record=True)` + `.export_text()`) without a real TTY.
- **Phase 3's REPL loop itself** is the least unit-testable part (an
  interactive `input()` loop) — recommend a thin integration test that
  feeds a scripted list of questions via a monkeypatched `input` (or by
  refactoring the loop body into a `run_one_question(...)` function the
  `while True` calls, so THAT function — the actual interesting logic — is
  directly callable from a test with a fake `Console`/`ProgressSink`,
  leaving only the trivial `while True: input()` shell untested).
- No new hermetic-vs-live distinction needed: `--engine synthetic` (the
  default, no DSN required) makes the REPL itself fully runnable in CI as a
  smoke test (`ceiba-nl2sql-dev --bundle-dir <fixture> --engine synthetic
  <<< "some question"` piped via stdin) if desired later — not proposed as
  a required CI gate in this plan, just noted as free given the design.

## Open Questions

1. **Dependency direction**: should `ceiba_nl2sql_service` (which currently
   has zero dependency on `ceiba_nl2sql_eval`) import
   `ceiba_nl2sql_eval.synthetic.build_synthetic_topology` for the
   `--engine synthetic` default? It's the only existing code that fabricates
   a runnable DuckDB dataset from just a bundle dir — reimplementing it
   would be pure duplication. Two options: (a) accept the new
   `service → eval` dependency edge (both already depend on `ceiba_nl2sql`;
   this isn't a cycle), or (b) move `synthetic.py` down into `ceiba_nl2sql`
   itself as a shared utility (bigger, unrelated refactor). Recommend (a) —
   flag for the user to confirm given repo conventions around package
   boundaries aren't fully documented.
2. **`uv run dev` literal string**: confirmed not achievable today without
   introducing a repo-root `uv` workspace (see Entry Point section). Confirm
   whether the team wants that broader adoption now or is fine with
   `uv run --project ceiba_nl2sql_service ceiba-nl2sql-dev` / a plain
   `ceiba-nl2sql-dev` after editable install.
3. **Repair-round SQL diffing**: when a repair round fires, is a
   side-by-side diff of failed-SQL vs. repaired-SQL (e.g. `rich`'s
   pretty-diff or a simple line-diff) worth the extra Phase-4 polish, or is
   printing the new SQL panel again sufficient? Deferred to Phase 4 based on
   actual usage feedback rather than guessed up front.
4. **Should the REPL log every session to a file** (question, generated SQL,
   guard verdicts, cost) for later review, mirroring how
   `BENCHMARK_FINDINGS.md` was compiled by hand? Not in this plan's scope,
   but a natural Phase 5 given `ProgressSink` already captures every event —
   a `JsonlProgressSink` that also writes to disk would be a small addition
   later if wanted.
