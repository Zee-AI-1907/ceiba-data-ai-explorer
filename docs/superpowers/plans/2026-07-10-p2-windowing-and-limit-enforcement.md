# P2 — Windowed/time-series queries + enforced row/time limits (implementation plan)

**Status:** ready to implement (Tasks 1–3 & 5–6 safe; Task 4 approved 2026-07-10 as the reject-with-hint variant, flag-gated default off — NOT silent AST injection).
**Branch base:** `remediation/phase-0-foundation`.
**Non-negotiable:** Task 1 (universal LIMIT) MUST NOT ship without Task 2 (rollup-safe guard). A LIMIT appended to a `GROUP BY` with no `ORDER BY` silently drops groups — shipping 1 alone converts a scan-cost fix into a silent-wrong-answer bug.

## Context recap (verified)
- Universal LIMIT injection does not exist. `cardinality_guard._append_limit` (`cardinality.py:430-434`, called `521-529`) fires only for `is_large_time_series` tables already bounded by (a)/(b)/(c). Non-large tables → `pass` with no LIMIT (`cardinality.py:483-484`). Prompt line `prompt.py:602` is advisory only.
- Options flow: `GenerateOptions` (`pipeline.py:153-179`) ← service `GenerateOptionsModel` (`models.py:33-37`, already exposes `defaultLimit`) ← built in `app.py:170-173`. **A second, independent egress cap already exists at execution: `ExecuteRequest.maxRows` + `truncated` (`models.py:110,125`).** So generation-time LIMIT is about *scan cost + result grain*, not the only backstop against egress — this lowers the risk of Task 1/3.
- Time surfacing: `TimeVia`/`required_time_column` (`retriever.py:111-143`), warning text `retriever.py:273-321`, `TIME COLUMN` marker `prompt.py:98-99`, dialect note `prompt.py:480-496`. No windowing/grain steering anywhere.

---

## Resolved decisions (the four open questions)

**Q1 — Default LIMIT value + override. → Keep `1000`; keep it per-request overridable; do NOT add a second knob.**
`defaultLimit` already threads end-to-end (`models.py:35` → `app.py:172` → `GenerateOptions.default_limit` → guard). Reuse the *same* value for the new universal guard rather than inventing a second limit — one number, one meaning ("max rows a generated query returns unless the user asked otherwise"). 1000 is already the cardinality-guard repair default, so large-table and small-table behavior stay consistent. Interactive UX truncation is the UI/execute layer's job (`ExecuteRequest.maxRows`), not generation's. *Assumption (flag if wrong): callers are fine with generated SQL carrying `LIMIT 1000` by default; if any downstream consumer needs the full result set for its own aggregation, it must pass an explicit high/again-overridden limit.*

**Q2 — GROUP BY without ORDER BY. → reject → self-repair (option b). Decisive.**
Correctness beats convenience here. Silently appending `LIMIT 1000` to `SELECT dept, count(*) ... GROUP BY dept` returns an arbitrary 1000 of N groups with no error — indistinguishable from a correct answer, the worst failure class for a clinical tool. Rejecting with a repair hint ("add an ORDER BY that expresses ranking intent, then a LIMIT; or state you want all groups") makes the model produce a *deterministic, intentional* top-N, which is what "top departments / worst HR" questions actually want (matches the reference SQL in `live_bench_queries.py:80-83, 90-95, 129-135`, all of which pair ORDER BY + LIMIT). The narrow exception — a grouped query the user genuinely wants fully materialized — is served by the execution-layer `maxRows`/`truncated` path, and the user can pass an explicit large `defaultLimit`. Net: no silent truncation of aggregates, ever.
- Pure scalar aggregate (aggregate(s), **no** GROUP BY → provably ≤1 row): skip injection, `pass`. Safe.
- GROUP BY **with** ORDER BY, no LIMIT: safe to auto-append (deterministic top-N) → `repair`.
- GROUP BY **without** ORDER BY, no LIMIT: `reject` → self-repair.
- No GROUP BY, non-aggregate, no LIMIT: auto-append → `repair`.

**Q3 — Default-time-window fallback (Stage 4). → OFF by default, flag-gated, and even when ON it REJECTS rather than injects. Clinically load-bearing.**
Injecting an unrequested `MeasuredDate >= now() - INTERVAL '24h'` silently changes the clinical answer (a "highest HR ever recorded" question becomes "highest in last 24h" with no signal to the user) — unacceptable as a default. Recommendation: do **not** implement silent window injection at all. Keep today's behavior (unbounded large table with no bound → `reject` → self-repair, `cardinality.py:508-519`), which already forces the model to supply a window, and improve only the *hint* so repair succeeds more often. If the user later wants a convenience default, gate it behind `GenerateOptions.default_time_window: str | None = None` (off), and when set have the guard **reject with a hint naming that suggested window** so the *model* writes it explicitly into the SQL (visible, auditable) instead of the guard mutating the AST invisibly. Guardrail: the injected/suggested window is never applied silently — it always appears in the returned SQL the user can inspect. → **DECISION 2026-07-10: build the reject-with-hint variant (flag-gated `default_time_window`, default off); NEVER silent AST injection. Approved for implementation, sequenced after PR A.**

**Q4 — Windowing steering. → default ON, but land it behind a flag first and flip the default only after the live benchmark confirms no regression.**
Unlike join steering (which risked over-constraining), windowing steering is additive guidance that maps directly onto real user intent ("per hour/day trend"). Ship as `GenerateOptions.window_steering: bool = True`, but merge with it **off in the same PR** and turn it on in a follow-up commit once `live_benchmark.py` shows the windowed cases (`avg_spo2_per_patient`, `longest_ventilated`, plus the new hourly-trend query from Task 6) improve or hold. This mirrors the `strict_join_steering` A/B precedent (`pipeline.py:174-179`) while defaulting to the better behavior. *Assumption (flag if wrong): benchmark harness can be run before merge to validate; if not, keep default OFF until it can.*

---

## Tasks (ordered)

### Task 1 — Universal top-level LIMIT guard (SAFE, but gated on Task 2 landing together)
**Files/functions:** new `ceiba_nl2sql/ceiba_nl2sql/guard/limit.py` (`enforce_default_limit(sql, *, default_limit, dialect) -> CardinalityVerdict`-shaped result); wire into `pipeline.py:_validate_candidate` (`pipeline.py:231-363`) AFTER the `cardinality_guard` block (`pipeline.py:295-308`) and BEFORE the EXPLAIN-estimate/`engine.explain` steps; add `GenerateOptions.enforce_default_limit: bool = True` (`pipeline.py:153-179`).
**Approach:** parse with sqlglot (reuse `normalize_dialect` + the `_is_numeric_limit`/`_has_limit_clause` helpers from `cardinality.py:148-180` — factor them into a shared spot or import). Operate on the **outermost** query only (the final `exp.Select`, incl. the outer select of a `WITH … SELECT`); never descend into CTEs/subqueries (protects `NOT EXISTS`, windowed subqueries, the `avg_spo2` subquery shape at `live_bench_queries.py:103-108`). Classify per the Q2 decision tree. Reuse `_append_limit` (`cardinality.py:430-434`) for the append. Return `repair` (with `repaired_sql`) or `reject` (with hint) or `pass`. When `enforce_default_limit=False`, no-op `pass` (preserves current behavior for existing callers/tests).
**Interaction with existing guard:** if `cardinality_guard` already produced a `repair` that appended a LIMIT, this guard sees the numeric LIMIT and no-ops — no double append.
**Tests — `ceiba_nl2sql/tests/test_limit_guard.py` (new):**
- `test_appends_limit_to_unlimited_plain_select`
- `test_skips_scalar_aggregate_no_group_by`
- `test_appends_to_group_by_with_order_by`
- `test_rejects_group_by_without_order_by`  ← the load-bearing case
- `test_ignores_limit_inside_cte_or_subquery` (outer has no LIMIT, subquery does → still appends to outer)
- `test_noop_when_outer_limit_present`
- `test_disabled_flag_is_passthrough`
**Review gate:** confirm outer-only targeting on `WITH … SELECT`; confirm no double-LIMIT with cardinality guard; confirm disabled-flag parity.

### Task 2 — Rollup-safe classification (SAFE; ships WITH Task 1, same PR)
**Files/functions:** the classification lives inside Task 1's `enforce_default_limit`; this task is the explicit GROUP-BY/ORDER-BY/aggregate detection + the reject hint text. Also audit the *existing* `cardinality_guard` repair path (`cardinality.py:521-529`) — it currently appends LIMIT to bounded large-table queries **including grouped ones**, so apply the SAME rollup-safe rule there (a grouped, unordered, bounded large-table query should reject-for-ORDER-BY, not silently truncate). This fixes a latent silent-truncation bug that predates P2.
**Approach:** helper `_is_pure_scalar_aggregate(select)` (has aggregate func, no GROUP BY) and `_has_top_level_order_by(select)`. Wire both into Task 1's tree AND `cardinality.py`'s repair branch.
**Tests — extend `ceiba_nl2sql/tests/test_cardinality_guard.py`:**
- `test_grouped_bounded_large_table_without_order_by_rejects` (new — proves the latent bug is fixed)
- `test_grouped_bounded_large_table_with_order_by_repairs_limit`
**Review gate:** verify no existing cardinality-guard test regresses (the current `test_repair_appends_limit_*` cases use non-grouped SQL, so they should stand — confirm).

### Task 3 — (folded into 1) service/option plumbing (SAFE)
**Files:** `GenerateOptions.enforce_default_limit` (`pipeline.py`); optionally expose `enforceDefaultLimit` on `GenerateOptionsModel` (`models.py:33-37`) + `app.py:170-173`. Default true. Low risk since `defaultLimit` already plumbs.
**Tests — `ceiba_nl2sql/tests/test_generate_pipeline.py`:** end-to-end — model returns unlimited plain SELECT → response `sql` carries `LIMIT 1000`; model returns unordered GROUP BY → pipeline self-repairs (assert repair round recorded, `RepairInfo`).
**Review gate:** confirm service default matches library default.

### Task 4 — Default-time-window fallback, reject-with-hint (APPROVED 2026-07-10; flag-gated default off)
**Files/functions:** add `GenerateOptions.default_time_window: str | None = None` (`pipeline.py:153-179`); in the large-table unbounded case (`cardinality.py:508-519`), when `default_time_window` is set, `reject` with a hint that NAMES the suggested window (e.g. `MeasuredDate >= now() - INTERVAL '24 hours'`) so the *model* writes it explicitly into the returned SQL. When unset (default), behavior is exactly today's reject-with-generic-hint.
**Approach:** never mutate the AST to inject a window silently — the guard only ever produces a `reject` verdict whose hint text names the window; the model's repaired SQL carries the window visibly and auditably. This preserves the "no silent clinical-semantics change" guarantee.
**Tests — extend `ceiba_nl2sql/tests/test_cardinality_guard.py`:**
- `test_default_time_window_unset_rejects_with_generic_hint` (today's behavior preserved)
- `test_default_time_window_set_rejects_with_named_window_hint` (hint text contains the configured window; no AST mutation — verdict is `reject`, `repaired_sql` is None)
**Review gate:** confirm the guard NEVER emits a `repair`/`repaired_sql` that silently adds a window; the window only ever reaches SQL via a model repair round. Clinical-safety review that the hint cannot be misread as a hard default.

### Task 5 — Windowing prompt steering (SAFE; default per Q4)
**Files/functions:** `prompt.py:assemble_prompt` — add a constant WINDOWING block alongside the `strict_join_steering` block (`prompt.py:609-620`), gated by new param `window_steering: bool` threaded from `GenerateOptions.window_steering` (`pipeline.py`) via `pipeline.py:485-511` (initial) and `553-574` (repair); forward through `assemble_repair_prompt` (`prompt.py:680-744`). Extend `_dialect_note` (`prompt.py:480-496`) with DuckDB `date_trunc('hour'|'day', ts)` guidance. **Constant strings only** — no per-question interpolation — to preserve the R2 cache-prefix property (`prompt.py:577`).
**Block content:** bucket the time column with `date_trunc`; GROUP BY + ORDER BY the bucket; when the time column lives on a parent (TimeVia), bucket on the parent's column and join first; don't put a threshold in the type/code column (reinforces the existing SEMANTIC HINTS guidance).
**Tests — `ceiba_nl2sql/tests/test_prompt.py`:**
- `test_windowing_block_present_when_enabled`
- `test_windowing_block_absent_when_disabled`
- `test_windowing_block_is_constant_prefix` (byte-identical across two different questions → protects prompt caching)
**Review gate:** confirm cacheable-prefix property; confirm repair prompt inherits the block.

### Task 6 — Windowed exemplar + benchmark lock (SAFE)
**Files:** add a windowed-trend query to `ceiba_nl2sql_eval/ceiba_nl2sql_eval/live_bench_queries.py` (e.g. hourly avg HR bucketed on `Monitors.MeasuredDate` over last 24h, `compare_mode` group/topk), and 1–2 windowed exemplars to the generated exemplar set (`config/exemplars.generated.jsonl`, already untracked/generated) so `_render_exemplars` (`prompt.py:511-533`) shows a correct hourly-trend shape.
**Tests:** the benchmark query itself is the test; run `live_benchmark.py` to validate Q4's flip-to-default-on gate.
**Review gate:** benchmark shows windowed cases hold/improve before flipping `window_steering` default on.

---

## Ship order
1. **PR A (safe):** Tasks 1 + 2 + 3 together (universal LIMIT + rollup-safety + plumbing). This is the safety fix; 1 never lands without 2.
2. **PR B (safe):** Tasks 5 + 6 (windowing steering behind flag OFF, exemplar, benchmark), then flip `window_steering` default ON after benchmark green.
3. **PR C:** Task 4 (reject-with-hint default-time-window, flag-gated default off) — approved 2026-07-10; sequence after PR A.

## Assumptions that change the plan if wrong
- **A1:** `defaultLimit` is an acceptable ceiling on generated SQL for all callers (Q1). If a downstream consumer needs full result sets for its own aggregation, Task 1 must exempt those callers via the flag.
- **A2:** The live benchmark can be run pre-merge to gate Q4's default-on flip. If not, `window_steering` stays default OFF.
- **A3:** Execution-layer `maxRows`/`truncated` (`models.py:110,125`) remains the egress backstop, so generation-time LIMIT is about scan cost + grain, not the sole row cap. If that path is being removed, revisit Q1/Q2 risk.
- **A4:** No caller depends on the current silent-LIMIT-append behavior for grouped large-table queries (Task 2 changes it to reject). Verified no existing test does; confirm no production caller does.

### Critical files
- ceiba_nl2sql/ceiba_nl2sql/guard/cardinality.py
- ceiba_nl2sql/ceiba_nl2sql/guard/limit.py (new)
- ceiba_nl2sql/ceiba_nl2sql/generation/pipeline.py
- ceiba_nl2sql/ceiba_nl2sql/generation/prompt.py
- ceiba_nl2sql/tests/test_limit_guard.py (new) + test_cardinality_guard.py + test_prompt.py
