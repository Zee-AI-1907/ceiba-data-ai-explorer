# NL→SQL System + DB-Agnostic Prep Toolchain — Phased Implementation Plan

> Implements `docs/NL2SQL_SPEC.md` (§ refs w/o doc = SPEC). Research settled in
> `docs/research/NL2SQL_RESEARCH.md` (Rn). Topology per `docs/DATA_SOURCES.md`.
> Dispatch-ready: each workstream is self-contained (file ownership, interfaces,
> deps, parallelism, tests, DoD).

## 0. Ground rules for every subagent

1. **Reuse, do not duplicate the hardened runtime:** `lib/sqlGuard.ts` (`guardSql`,
   `stripCommentsAndSplit`, H25 `tableAllowlist` seam), `lib/phiScrubber.ts`
   (`PHI_COLUMNS`, `normalizeKey`, `buildAggregateProfile`, `assertEgressAllowed` /
   `OPENAI_BAA_SIGNED`), `lib/apiAuth.ts` (`Session {userId,orgId,role}`,
   `requireAuthWithPermission`), `lib/validation.ts` (`parseBody`, `enforceBodySize`,
   `clampLimit`, `SqlGenerateBodySchema`), `lib/errors.ts`, `lib/rateLimiter.ts`,
   `lib/cache.ts` + `lib/cacheKey.ts`. No forks.
2. **Read-only everywhere:** every Postgres connection uses
   `PGOPTIONS='-c default_transaction_read_only=on'` + `SET SESSION CHARACTERISTICS AS
   TRANSACTION READ ONLY` first; DuckDB `ATTACH ... (READ_ONLY)`; a read-write attach is
   a hard error.
3. **PHI boundary is structural:** artifacts hold metadata + `AggregateProfile`-derived
   + synthetic descriptors only; `sample_aggregate` is the only data-touching path; no
   raw cell in any artifact/vector; generated SQL re-guarded at `/api/query`; nothing
   patient-row-derived egresses to an LLM absent `OPENAI_BAA_SIGNED`.
4. **CI green without the live staging DB:** default path = synthetic/mock topology;
   staging = opt-in gated mode; no test requires the SSH tunnel.
5. **Tooling:** TS tests = Vitest; Python tests = pytest under `prep/tests/`.
6. **File ownership is exclusive per workstream**; shared type files have a single
   owning phase; later phases import, never edit (unless "extends").

## 0a. Resolved open questions (locked before dispatch — 2026-07-09)

The plan analysis flagged 5 under-specs. Resolutions:

1. **Mock↔staging correlation keys.** The mock DB models a **second hospital + shared
   reference vocab**. Shared id space: `HospitalId` (int), `MeasurementTypeId` (int,
   correlating to `Shared.MonitorMeasurementTypes`), `WardId` (int). Synthetic
   patient/visit surrogate keys are mock-local (namespaced, no overlap with staging PHI).
   The cross-source join edge is `Acceptances.HospitalId → mock.public."HospitalRef".HospitalId`.
2. **Local embedding model.** `fastembed` (ONNX, no torch, CPU, fully local) with
   **`BAAI/bge-small-en-v1.5`** (dim 384). Pinned via `fastembed` version in
   `pyproject.toml`; manifest records `{id:"bge-small-en-v1.5", dim:384, lib:"fastembed",
   revision:<fastembed pin>}`. Runtime refuses a mismatched `embeddingModel.id`.
3. **Driving LLM in CI.** CI uses a **stubbed/recorded driving LLM** (fixture responses);
   no live model call in CI. Non-CI default `drivingModel` = the app's configured Claude
   model. This keeps CI hermetic and honors the egress gate.
4. **Cross-DB test in CI.** CI provides a **second synthetic Postgres service container**
   as the "staging-like" source; DuckDB `ATTACH`es both. Fallback if unavailable: two
   attached DuckDB catalogs (still satisfies `supportsCrossCatalogJoin`).
5. **Indexed time column for cardinality guard.** Mock large-table analog
   `public."MeasurementsMock"(..., "RecordedAt" timestamptz)` is created **with a btree
   index on `RecordedAt`** so `requiredTimeColumn` resolves in CI exactly as on staging.

## 1. Dependency graph

```
P0 (scaffold: deps, dirs, CI stubs, PHI_COLUMNS export bridge)
 ├── P1 (OrbStack mock Postgres)
 ├── P2 (QueryEngine + DuckDbEngine + Trino stub)
 └── P3a (introspect + profile + PHI-classify)
        ★ M1 THIN SLICE (needs P1+P2): one question → hand-authored context →
          promptAssembly → stub LLM → guardSql + cardinalityGuard → execute on mock
 P3b (enrich + embed + index + emit bundle)   ← P3a
 P4 (BundleLoader + Retriever)                 ← P2, P3
 P5 (generate + self-repair + route wiring)    ← P2, P4
 P6 (eval harness + golden set)                ← P2,P3,P4,P5
```
Critical path: **P0 → P2 → M1 → P4 → P5 → P6**; P1 + P3 track run parallel and converge.

## Phases

*(Full per-phase detail — files owned, interfaces, deps, parallelism, tests, DoD —
follows the structure below; see the summary table for the dispatch view.)*

### P0 — Scaffolding & PHI bridge
Owns: `prep/pyproject.toml`, `prep/prep/**` stubs, `config/phi_columns.json` +
`scripts/gen-phi-columns.mjs` (npm `phi:sync`), `.github/workflows/nl2sql-ci.yml`
skeleton, additive `vitest.config.ts` globs, **additive `PHI_COLUMNS`/`normalizeKey`
export** in `phiScrubber.ts` (only edit to existing code here). DoD: regenerated
`phi_columns.json` hash matches checked-in; trivial TS+PY tests green.

### P1 — Local mock DB (OrbStack)
Owns: `docker/mock-postgres/**` (compose + init schema/seed/readonly-role), `scripts/
mock-db-{up,down}.sh`, `.env.example` (`MOCK_DSN`), `docs/mock-topology.md`. Read-only
role, PascalCase-quoted ids, deterministic no-PHI seed, `MeasurementsMock` w/ indexed
`RecordedAt`, `HospitalRef` cross-source edge. DoD: read returns rows, writes rejected,
CI service-container smoke passes without OrbStack.

### P2 — QueryEngine + DuckDbEngine + Trino stub
Owns: `lib/engine/**` (`QueryEngine.ts` interface verbatim SPEC §3, `DuckDbEngine.ts`
w/ `ATTACH READ_ONLY` + row-cap + deadline + `explain`, `TrinoEngine.ts` stub wrapping
`trinoClient.ts`, `index.ts` factory). Adds `duckdb` dep + `postgres`/`vss` extensions.
DoD: **cross-DB read-only join returns rows; write rejected; row-cap/deadline enforced;
Trino stub compiles against interface.**

### ★ M1 — Thin slice
Owns: `lib/rag/promptAssembly.ts` (initial), `lib/rag/cardinalityGuard.ts` (initial),
thin-slice test. DoD: `"heart rate > 120 in last 3 hours"` → hand-authored context →
stub generator → guard + cardinality → `explain`/`execute` on mock returns rows; bad
SQL (unbounded/write) rejected or repaired. Proves architecture before scale.

### P3a — Introspect / profile / classify
Owns: `prep/prep/{cli,config,introspect/**,profile,classify_phi,phi_gate}.py`,
`config/prep.config.yaml`, `config/glossary.seed.yaml`. `sample_aggregate` is the only
data path; mirrors `buildAggregateProfile` semantics; emits catalog/keys/profiles/phi.
DoD: bundle metadata + profiles + phi emitted; PHI gate passes; poisoned artifact fails
`verify`.

### P3b — Enrich / embed / emit
Owns: `prep/prep/{enrich/**,embed/**,emit,exemplars}.py`. Join graph (declared+inferred),
glossary (generalizes `clinicalContext.ts`), importance scoring, **local fastembed**
vectors, `vectors.duckdb` HNSW, versioned manifest w/ hashes. DoD: full versioned bundle,
PHI gate on vectors, deterministic build.

### P4 — BundleLoader + Retriever
Owns: `lib/rag/{Retriever,BundleLoader,bm25,vssClient,rankFusion}.ts`. Coarse-to-fine
hierarchical retrieval, hybrid dense+BM25 RRF, FK-expand, LLM-prune (stub in CI),
token-budgeted `SchemaContext`. DoD: ≤`maxTables` survivors over the **full ~1200-table**
schema within budget, join hints + cardinality warnings; model-id mismatch refused.

### P5 — Generate + self-repair + route
Owns: `lib/rag/generate.ts`, extends promptAssembly/cardinalityGuard, refactors
`app/api/sql-generate/route.ts` (swap keyword schema for Retriever; add guard+cardinality
+`explain`-repair ≤2 rounds; response gains `dialect`/`retrieval`/`repair`), additive
`SqlGenerateBodySchema` fields. Auth/rate-limit/body-size/cache/egress **unchanged**;
`/api/query` unchanged (execution boundary). DoD: both canonical questions → guard-passing
bounded SQL executes on synthetic topology; dialect correct (fixes hardcoded-PostgreSQL);
self-repair recovers unbounded draft; injection rejected.

### P6 — Eval harness + golden set
Owns: `eval/**` (`loadSynthetic.ts`, `score.ts`, `runEval.ts`, `golden/*.jsonl`,
`adversarial.jsonl`, fixtures). Role-play driving LLM (stub in CI); scores guard/parse/
real-tables/cardinality/executes/result-match; synthetic default + gated staging mode.
Retriever tested against full schema even with synthetic execution. DoD: synthetic eval
green in CI; adversarial all rejected; cross-source edge validated; staging gated off.

## Risk / sequencing notes
- **~1200-table scale (P4):** never rank columns flat; hierarchical order mandatory;
  test retriever against the full introspected schema; DuckDB-vss HNSW not brute force.
- **337M-row cardinality (P2/P5):** read-only stops writes but not ruinous scans;
  `cardinalityGuard` forces indexed-time-bound + LIMIT via repair; steer to pushable
  indexed predicates.
- **PHI gates (P0/P3/P6):** hash-drift fails build; AST scan proves `sample_aggregate`
  sole data path; no suppressed value in vectors; `embedding.provider==local`; CI
  synthetic-only.
- **Reuse:** wire artifact known-tables into existing `guardSql` H25 seam; reuse
  `buildAggregateProfile`; keep `/api/query`, Session/RBAC/rate-limit/cache untouched.
- **Soft dep:** P3b exemplars seed from the two canonical questions, back-fill from P6
  golden set later.

## CI integration
`nl2sql-ci.yml`, 3 blocking jobs: **ts-tests** (Vitest incl. M1), **py-tests** (pytest +
PHI-gate build against a Postgres service container seeded with P1 init SQL), **eval**
(synthetic-mode golden subset + adversarial, stub LLM). Existing `secret-scan.yml` stays.
No job requires the SSH tunnel; staging is opt-in only.

## One-screen summary

| Phase | Owns | Deps | Parallel | DoD |
|---|---|---|---|---|
| P0 | scaffold + PHI bridge + `PHI_COLUMNS` export | — | — | PHI hash matches; trivial TS+PY green |
| P1 | `docker/mock-postgres/**`, scripts | P0 | P2,P3a | read rows / write rejected / CI smoke |
| P2 | `lib/engine/**` | P0(+P1) | P1,P3a | cross-DB RO join rows; write rejected; caps |
| M1 | `lib/rag/{promptAssembly,cardinalityGuard}` (init) | P1,P2 | — | one Q end-to-end on mock; bad SQL rejected |
| P3a | `prep/prep/{cli,introspect,profile,classify_phi,phi_gate}` | P0 | P2,P4 | bundle meta+profiles+phi; gate passes |
| P3b | `prep/prep/{enrich,embed,emit,exemplars}` | P3a | P4,P6 | full versioned bundle; deterministic |
| P4 | `lib/rag/{Retriever,BundleLoader,bm25,vssClient,rankFusion}` | P2,P3 | P3b,P6 | ≤maxTables over full schema in budget |
| P5 | `lib/rag/generate`, route refactor | P2,P4 | P6 | 2 canonical Qs execute; dialect correct; injection rejected |
| P6 | `eval/**` | P2,P3,P4,P5 | — | synthetic eval green; adversarial rejected |
