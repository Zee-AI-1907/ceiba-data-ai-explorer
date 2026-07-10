# P3 — Rework strict-join-steering prompt to stop join-collapse (implementation plan)

## Problem (recap)
`strict_join_steering` steers cheap models away from invented `Id=Id` joins but makes STRONG models UNDER-answer: luna+strict emitted `SELECT COUNT(*) FROM Patients` for "patients per hospital" and `SELECT Id FROM Acceptances LIMIT 1000` for the anti-join. Root trigger: the "return fewer tables rather than fabricate a link" fallback + "prefer PK/FK equality joins" minimization framing at `prompt.py:614/619`, with no obligation to actually answer. The `joins_ok` benchmark metric hid this because a zero-join query trivially satisfies "joins ⊆ declared edges."

## 1. FINALIZED replacement wording (paste-ready)

Replace the list literal at `ceiba_nl2sql/ceiba_nl2sql/generation/prompt.py:609-620` (the `*([ ... ] if strict_join_steering else [])` block) with these **four constant strings** (no interpolation → R2 cache-prefix safe):

```python
*([
    # 1. COMPLETENESS — load-bearing; must dominate the "don't invent" rule so
    #    "don't invent joins" can never collapse into "don't join at all".
    "ANSWER THE WHOLE QUESTION. Include every table, join, GROUP BY, and "
    "aggregate needed to compute exactly what was asked. If the question asks "
    "for something PER or BY an entity (e.g. per hospital, by department, for "
    "each patient), you MUST join through to that entity's table and GROUP BY "
    "it. Omitting a required join or grouping — for example collapsing a "
    "multi-table question into a single-table COUNT — is a WRONG answer, not a "
    "safe simplification. Returning fewer tables is NOT a goal; answering "
    "completely is.",
    # 2. JOINS — declared-only AND use-all-you-need (the anti-Id=Id protection
    #    is preserved; the "return fewer tables" escape hatch is removed).
    "USE ONLY DECLARED JOINS, BUT USE ALL THAT YOUR ANSWER NEEDS. Every join "
    "predicate in your SQL must copy a declared FK edge from the JOIN GRAPH "
    "below verbatim (FK-side column = PK-side column), or follow a declared "
    "multi-hop path through its bridge tables — and you must include ALL such "
    "joins the answer requires, traversing the full path end to end. NEVER "
    "invent a predicate: two columns sharing a NAME do not imply a join, and "
    "never join Id = Id unless an edge declares exactly that. The declared "
    "edges are always sufficient to connect the tables you need; if a path is "
    "long, follow every hop rather than stopping short or dropping a table.",
    # 3. FILTERS — unchanged from the current wording (never implicated).
    "FILTERS: add a WHERE condition ONLY if the user's request asks for it, or "
    "if it is a soft-delete rule explicitly rendered on a table below. Add NO "
    "other filter (e.g. IsActive, a status, a default date window) the user did "
    "not request — an unrequested filter silently drops rows.",
    # 4. TRACE — reworked: drops "prefer fewer", keeps equality-join preference
    #    (which is about HOW to join, not about minimizing tables).
    "Before writing SQL, trace the FULL path in the JOIN GRAPH below: list "
    "every table your answer needs, connect them using only the declared "
    "edges/paths (all hops, no shortcuts), then add the required GROUP BY and "
    "aggregates. Prefer PK/FK equality joins over any other way of relating "
    "tables.",
] if strict_join_steering else []),
```

Why this satisfies the "must not collapse" constraint: (a) line 1 makes under-scoping an explicit WRONG answer and names the exact failure modes seen (single-table COUNT, missing PER/BY grouping); (b) line 2 reframes the rule as "use ALL declared joins you need, but only declared ones" and deletes the "return fewer tables rather than fabricate" escape hatch entirely; (c) the anti-`Id=Id` clause is retained verbatim in line 2; (d) "prefer fewer" minimization language is gone from line 4, while "prefer PK/FK equality joins" (a HOW-to-join rule, not a minimize-tables rule) stays.

## 2. Resolved open questions

**Q1 — A/B path. Recommend BOTH: coverage-guarded `sql_only` as the fast default proxy, executed mode as the authoritative confirm.** Executed mode (`sql_only=False`) is the ground truth (it runs `compare()` against reference results and so catches under-answering), but per BENCHMARK_FINDINGS.md the heaviest multi-hop queries time out through the DuckDB→Postgres federation (>30s), so a full executed matrix may be partially blocked in this env. Therefore: (i) upgrade `sql_only` scoring with a coverage guard (Q4) so the fast proxy stops rewarding under-answering, run the full 12-cell matrix on it; (ii) run executed mode on the subset that completes within the 90s/12s deadlines (the org-rollup and anti-join queries are the important ones and are moderate-cost) to confirm the proxy's verdict on luna. Gate the decision on the proxy for breadth + executed mode for the failure-exposing subset.

**Q2 — Tier-aware steering in v1? Recommend DEFER (confirmed).** Land the single reworded prompt for all tiers first. The rework removes the collapse trigger, so the strong tier should stop under-answering while the weak tier keeps the anti-`Id=Id` protection — one prompt may serve both. Only add tier-awareness if the matrix shows luna-strict still < luna-baseline after the rework. Insertion points are already in place (`route_is_simple` at pipeline.py:366; `initial_llm` selection at pipeline.py:514) for a fast follow-up if needed.

**Q3 — Repair-round symmetry? Recommend KEEP SYMMETRIC.** `assemble_repair_prompt` forwards `strict_join_steering` verbatim (pipeline.py:570). A repair round that dropped the completeness obligation could re-introduce under-answering during repair; keeping identical steering is correct and requires no change.

**Q4 — Fix the under-answer blind spot. Recommend YES — but NOT by changing `join_predicates_are_declared` (its contract "joins ⊆ declared edges" is correct and should stay narrow).** The blind spot lives in the SCORER (`live_benchmark.run_cell`, sql_only branch, `live_benchmark.py:185-191`), which passes on `binds AND joins_ok` and so rewards a zero-join query. Concrete change — add a **coverage guard**:
   - Derive the reference query's structural shape once, automatically, from each `BenchQuery.reference_sql` via `sqlglot` (no hand-maintained metadata to drift): `ref_join_count` = number of `exp.Join` nodes, `ref_requires_group_by` = presence of a `GROUP BY`, `ref_table_count` = number of distinct base tables. Compute the same three for the generated SQL.
   - New pass condition (sql_only): `binds AND joins_ok AND gen_join_count >= ref_join_count AND (gen_has_group_by OR not ref_requires_group_by) AND gen_table_count >= ref_table_count`. A single-table `COUNT(*) FROM Patients` against a 4-join grouped reference now FAILS on `gen_join_count (0) < ref_join_count (3)` and missing GROUP BY.
   - Record the coverage sub-verdicts on `QueryStats` (add `coverage_ok: list[bool]`, `gen_join_count: list[int]`) so the report distinguishes "invented join" (joins_ok False) from "under-answered" (coverage_ok False) — the two failure modes we're trading off.
   - This is a benchmark-harness change only; `join_check.py` is untouched.

## 3. Ordered implementation tasks

### Task 1 — Coverage guard for the sql_only scorer  ⟶ SAFE TO IMPLEMENT
- **Files:** `ceiba_nl2sql_eval/ceiba_nl2sql_eval/live_benchmark.py` (add `_sql_shape(sql, dialect) -> (join_count, has_group_by, table_count)` helper using `sqlglot.parse_one` + `find_all(exp.Join)` / `exp.Group` / `exp.Table`; wire into `run_cell` sql_only branch at 185-191; extend `QueryStats` ~100-114 with `coverage_ok`/`gen_join_count`). Reference shape derived from `q.reference_sql` in the same helper.
- **Approach:** pass = `binds AND joins_ok AND coverage_ok` where coverage_ok is the join-count/group-by/table-count comparison above.
- **Tests:** `ceiba_nl2sql_eval/tests/test_live_benchmark.py` — `test_coverage_guard_fails_single_table_when_reference_joins()`, `test_coverage_guard_fails_missing_group_by_when_reference_groups()`, `test_coverage_guard_passes_when_shape_matches_or_exceeds()`. Hermetic (string SQL in, bool out; no DB).
- **Review gate:** coverage guard must FAIL luna+strict's known `COUNT(*) FROM Patients` on `patients_per_hospital` and the `SELECT Id ... LIMIT 1000` on `no_measurement_last_6h` when replayed as fixtures.

### Task 2 — Reword the strict-steering preamble  ⟶ NEEDS USER SIGN-OFF (wording is the user's call)
- **Files:** `ceiba_nl2sql/ceiba_nl2sql/generation/prompt.py:609-620` (replace with the four strings in §1). Update the docstring at prompt.py:571-577 to say "four imperative lines" and describe the completeness obligation.
- **Approach:** paste §1 verbatim after the user approves the exact wording. Constant strings only.
- **Tests:** `ceiba_nl2sql/tests/test_prompt.py` — UPDATE `test_strict_join_steering_lines_present_only_when_enabled` (line 295) and the repair-prompt twin `test_assemble_repair_prompt_strict_join_steering_lines_present_only_when_enabled` (line 265): the needle tuple at line 298 currently checks `("use ONLY the equality join predicates", "add a WHERE condition ONLY if", "trace the join path")` — change to needles from the new wording, e.g. `("ANSWER THE WHOLE QUESTION", "USE ONLY DECLARED JOINS, BUT USE ALL", "never join Id = Id unless an edge declares", "add a WHERE condition ONLY if", "trace the FULL path")`. ADD `test_strict_steering_forbids_undeclared_but_requires_all_needed_joins()` asserting BOTH the anti-Id=Id needle AND the completeness needle are present (encodes the "don't collapse" invariant). The R2 byte-identical-prefix assertion at 304-306 stays and must still pass.
- **Review gate:** user approves wording; all `test_prompt.py` cases green; prefix-identity test still passes.

### Task 3 — Run the A/B matrix and record the verdict  ⟶ SAFE TO IMPLEMENT (after Tasks 1-2)
- **Files:** no source change — invoke `live_benchmark.run_matrix` (base + enriched bundles, N runs, staging password, all 3 models) with the coverage-guarded scorer; then executed-mode (`sql_only=False`) on the completing subset. Capture results into a new findings section in `docs/research/BENCHMARK_FINDINGS.md`.
- **Approach:** compare baseline vs strict-reworded per model. Success: (i) luna strict-reworded coverage-pass ≥ luna baseline (regression fixed); (ii) mini/nano strict ≥ baseline on `joins_ok` (anti-Id=Id retained); (iii) the five failure-exposing queries below pass for luna-strict.
- **Failure-exposing queries** (`live_bench_queries.py`): `patients_per_hospital` (4-hop group_top, :87), `no_measurement_last_6h` (anti-join, :112), `admissions_per_department_7d` (:136), `worst_hr_last_day` (:53), `avg_spo2_per_patient` (nested aggregate + GROUP BY, :99). Negative control: mini/nano on these must still avoid invented `Id=Id`.
- **Review gate:** documented per-cell table; go/no-go on shipping the rewording; explicit note on whether tier-aware (Q2) is still needed.

### Task 4 (conditional) — Tier-aware steering  ⟶ DEFERRED; implement only if Task 3 shows luna-strict still regresses
- **Files:** `pipeline.py` (thread a resolved-tier flag where `initial_llm` is chosen at :514, gate strict on the weak tier), or add a strong-tier prompt variant in `prompt.py`.
- **Tests:** `test_pipeline.py` — strong tier omits/softens steering, weak tier retains it.
- **Review gate:** only opened if the single-prompt rework is insufficient.

## Sequencing & safety
- Task 1 first (makes the benchmark honest before it judges the prompt), then Task 2 (needs user wording sign-off), then Task 3 (measures). Task 4 only on evidence.
- Safe-to-implement now: Tasks 1 and 3. Needs user sign-off: Task 2 (wording). Deferred: Task 4.

### Critical Files for Implementation
- ceiba_nl2sql/ceiba_nl2sql/generation/prompt.py (609-620 wording; 571-577 docstring)
- ceiba_nl2sql/tests/test_prompt.py (265, 295 — needle updates + new invariant test)
- ceiba_nl2sql_eval/ceiba_nl2sql_eval/live_benchmark.py (100-114 QueryStats; 185-191 scorer; new _sql_shape helper)
- ceiba_nl2sql_eval/tests/test_live_benchmark.py (coverage-guard cases)
- ceiba_nl2sql_eval/ceiba_nl2sql_eval/live_bench_queries.py (reference SQL = shape source for coverage guard)
