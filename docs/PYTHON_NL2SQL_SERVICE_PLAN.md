# Python NL→SQL Service — Design + Migration Plan

**Status:** Design + migration plan (read-only design work). NOT implementation.
**Date:** 2026-07 · **Branch:** `remediation/phase-0-foundation`
**Decision (input, do not re-litigate):** Extract ONLY the NL→SQL runtime into a Python service. Keep the hardened TypeScript app/auth/RBAC/API routes. The TS app calls the Python service over a thin internal API.

**Reads-before:** `docs/NL2SQL_SPEC.md` (bundle §1, QueryEngine §3, Retriever §4, generation §5, eval §6), `docs/NL2SQL_PLAN.md`, `docs/DATA_SOURCES.md`, `docs/ARCHITECTURE.md`.

> **Auth scope note (input):** multi-org membership is being planned separately against the TS auth layer. This plan assumes the Python service receives an already-resolved `{ userId, activeOrgId, role }` context from the trusted TS caller. It does NOT re-plan auth, session, RBAC, or org resolution — those stay in TS exactly as they are today (`lib/apiAuth.ts`, `lib/permissions.ts`, `lib/session.ts`).

---

## 0. Why this split (the rationale, grounded in the code that exists)

The current system is one Next.js/TS process. The NL→SQL runtime lives in `lib/rag/**` + `lib/engine/**` + `lib/sqlGuard.ts`, and a parallel **Python** build-time toolchain lives in `prep/prep/**`. They meet only at the artifact bundle (`docs/NL2SQL_SPEC.md §1`). Three concrete pain points in the *current TS runtime* are pure duplication of Python that already exists in `prep/`:

1. **JS embedder parity risk (gap #2).** `lib/rag/queryEmbedder.ts` is a 200-line, carefully-annotated reproduction of `prep/prep/embed/local_embedder.py`'s fastembed recipe — it re-implements CLS pooling, no-prefix, L2-normalize, fp32-vs-int8 quantization tolerance, and ships a `verifyEmbedderParity()` to catch drift. This entire file exists ONLY because the runtime is TS and the bundle was embedded in Python. **Same-language runtime deletes it.**

2. **Dialect-parsing / guard fragility.** `lib/sqlGuard.ts` is a hand-written character tokenizer (it explicitly rejected a real parser because "node-sql-parser has no Trino dialect"). `lib/rag/cardinalityGuard.ts` is lexical substring matching over guard-stripped SQL and its own header says *"P5 may harden with a real SQL AST if false negatives are observed."* **Python has `sqlglot`** — a real, dialect-aware (duckdb/postgres/trino) SQL parser — which `prep/` can also use. `sqlglot` is currently a dependency of *neither* side.

3. **TS↔Python PHI hash bridge.** PHI classification is authored in `lib/phiScrubber.ts` (TS), exported to `config/phi_columns.json` via `npm run phi:sync` (`scripts/gen-phi-columns.mjs`), and re-implemented in `prep/prep/classify_phi.py` (which mirrors `normalizeKey` and `isPhiColumn` "EXACTLY"). Two implementations of one compliance rule, kept in lockstep by a CI drift check. **A shared Python package makes the runtime PHI logic the same code prep uses.**

The backend's genuinely hard, already-tested parts — auth, tenancy, RBAC, rate-limit, body-size, audit hash-chain, anomaly detection, the `/api/query` execution security boundary — do NOT benefit from Python and stay in TS. This is a **surgical extraction of the NL→SQL runtime**, not a rewrite.

---

## 1. Service boundary — what moves vs. what stays

### 1.1 Moves to Python (the NL→SQL runtime)

| TS module (deleted after cutover) | Python home in the service | Notes |
|---|---|---|
| `lib/rag/queryEmbedder.ts` | *(deleted, not ported)* | Replaced by `prep/embed/local_embedder.py`'s `FastEmbedEmbedder` — the parity reproduction disappears entirely. |
| `lib/rag/BundleLoader.ts` | `ceiba_nl2sql/bundle/loader.py` | Load/validate manifest, sha256 integrity, embedding-model-id check, typed accessors. Prep already writes these files; the loader becomes shared. |
| `lib/rag/vssClient.ts` | `ceiba_nl2sql/retrieval/vss.py` | DuckDB-vss ANN read. Python's `duckdb` package already opens `vectors.duckdb`. |
| `lib/rag/bm25.ts` | `ceiba_nl2sql/retrieval/bm25.py` | Lexical index built at load. |
| `lib/rag/rankFusion.ts` | `ceiba_nl2sql/retrieval/fusion.py` | Reciprocal-rank fusion. |
| `lib/rag/Retriever.ts` (`HybridRetriever`) | `ceiba_nl2sql/retrieval/retriever.py` | The 7-stage coarse-to-fine pipeline; produces `SchemaContext`. |
| `lib/rag/promptAssembly.ts` | `ceiba_nl2sql/generation/prompt.py` | H25-delimited, dialect-targeted prompt assembly. |
| `lib/rag/cardinalityGuard.ts` | `ceiba_nl2sql/guard/cardinality.py` | **Upgraded** from lexical to `sqlglot`-AST detection of large-table scans. |
| `lib/rag/generate.ts` (`generateSql`) | `ceiba_nl2sql/generation/pipeline.py` | The §5.1 pipeline + self-repair loop + `callLlm` egress choke point. |
| `lib/engine/QueryEngine.ts` (interface) | `ceiba_nl2sql/engine/base.py` (Protocol) | Interface only. |
| `lib/engine/DuckDbEngine.ts` | `ceiba_nl2sql/engine/duckdb_engine.py` | ATTACH READ_ONLY, execute w/ row cap + deadline, explain. Python `duckdb` package. |
| `lib/engine/TrinoEngine.ts` | `ceiba_nl2sql/engine/trino_engine.py` | Currently a **stub** (`TrinoDeferredError` on explain/introspection; `execute` wraps `lib/trinoClient.ts` for catalogs `telehealth`/`eclinics`). Ports as a stub behind the same Protocol; not the default. `lib/trinoClient.ts` ports too if/when Trino is promoted. |
| `lib/engine/provisioning.ts` | `ceiba_nl2sql/engine/provisioning.py` | The shared, memoized engine + attach topology. |

### 1.2 Stays in TS (route wrappers + all cross-cutting concerns)

`app/api/sql-generate/route.ts` and `app/api/query/route.ts` **keep their exact WS-F/H hardening order** and become thin clients of the Python service. The per-request pipeline stays TS:

```
auth (requireAuthWithPermission 'query:run')      lib/apiAuth.ts        [STAYS TS]
  → rate limit (rateLimit)                         lib/rateLimiter.ts    [STAYS TS]
  → body size (enforceBodySize)                     lib/validation.ts     [STAYS TS]
  → parse + validate (zod schemas)                  lib/validation.ts     [STAYS TS]
  → tenant cache key + cache read                   lib/cache.ts          [STAYS TS]
  → CALL PYTHON SERVICE ─────────────────────────►  (new: lib/nl2sqlClient.ts)
  → [/api/query only] re-guard on execute           lib/sqlGuard.ts       [STAYS TS — see §1.3]
  → audit (hash-chained) + anomaly detection        lib/auditLog.ts,      [STAYS TS]
                                                     lib/anomalyDetector.ts
  → error envelope (safeError / errorResponse)       lib/errors.ts         [STAYS TS]
```

Everything under `lib/apiAuth.ts`, `lib/permissions.ts`, `lib/session.ts`, `lib/authStore.ts`, `lib/validation.ts`, `lib/errors.ts`, `lib/rateLimiter.ts`, `lib/cache.ts`, `lib/auditLog.ts`, `lib/anomalyDetector.ts`, `lib/phiScrubber.ts` (TS side of the PHI bridge) **stays unchanged**. The only new TS module is the service client (`lib/nl2sqlClient.ts`).

### 1.3 The SQL guard — RECOMMENDATION: guard lives in Python (shared), TS `/api/query` re-guard stays as layered defense

The read-only enforcement is deliberately **layered** today (`NL2SQL_SPEC.md §8.2 invariant 5`): (a) the read-only DB/engine principal (primary), (b) the in-app `guardSql` classifier, (c) the bundle known-tables allowlist. That layering must survive the split.

**Recommendation:**

- **Move the authoritative guard into Python** as `ceiba_nl2sql/guard/sql_guard.py`, re-implemented on **`sqlglot`** (real dialect-aware parse) rather than the hand tokenizer. This is strictly stronger than `lib/sqlGuard.ts`'s tokenizer (which classifies only by leading keyword) and is *shared* with prep's exemplar validation and the eval scorer. The Python guard runs inside `/nl2sql/generate`'s self-repair loop (the `[E] guardSql` step) exactly as `generate.ts` does today.
- **KEEP `lib/sqlGuard.ts` in TS and keep the `/api/query` re-guard call.** `/api/query` is the execution security boundary (`NL2SQL_SPEC.md §8.6`) and it MUST NOT trust that the generator produced safe SQL — including a future case where a caller submits hand-written SQL that never went through `/nl2sql/generate`. Removing the TS re-guard would collapse a defense layer to save nothing. The TS tokenizer guard is cheap, has no dependency, and stays as-is.
- **Net posture after split:** three read-only layers become **four** — DB read-only role (primary) → Python `sqlglot` guard (generation-time) → **TS tokenizer guard (execution-time re-guard, unchanged)** → bundle known-tables allowlist. Defense-in-depth is *increased*, not weakened.

This split is honest about trust: the Python guard is a *quality/repair* gate on generation; the TS re-guard is the *boundary*. Neither is the primary control — the DB read-only role is (`docs/DATA_SOURCES.md`, `docker/mock-postgres/init/03_readonly_role.sql` `ceiba_ro`). The read-only enforcement therefore **remains layered across both processes.**

---

## 2. The service API contract

### 2.1 Transport, framework, and auth between TS ↔ Python

- **Framework:** FastAPI (uvicorn) — Pydantic gives request/response schemas that mirror the existing TS interfaces one-to-one, and it is the natural home alongside `prep/`'s existing Python.
- **Transport:** HTTP/JSON over the internal network. Same-host in production (see §6): the Python service binds to `127.0.0.1:${NL2SQL_SERVICE_PORT}` (default 8088) or a private-network address; it is **never** exposed to the public internet — the only ingress is the Next.js app.
- **Service auth (TS → Python):** a shared **internal service token** in the `Authorization: Bearer` header, from env `NL2SQL_SERVICE_TOKEN` (present in both processes). The FastAPI app rejects any request without the exact token (constant-time compare) with 401. This is deliberately simple because the network path is private; mTLS is a documented upgrade (§7) for a cross-host deployment.
  - The token is a *service* credential, not a user credential. **User identity/RBAC is already resolved in TS** and passed as *data* in the request body (`context` object, §2.2), which the service treats as trusted-but-scoped (it uses `activeOrgId` for cache/telemetry scoping and source-scope, never to re-authorize).
- **Idempotency/statelessness:** the service is stateless per request except for the process-lifetime memoized engine + loaded bundle (mirrors today's `getGenerationDeps`/`getQueryEngine` memoization). No user session, no cookies.

### 2.2 Endpoints

#### `POST /nl2sql/generate` — NL → SQL (replaces the body of `app/api/sql-generate/route.ts`)

Request:
```jsonc
{
  "question": "patients whose heart rate was over 120 in the last 3 hours",
  "context": {                        // resolved by TS; trusted, not re-authorized
    "userId": "u_123",
    "activeOrgId": "org_abc",
    "role": "clinician"
  },
  "dialect": "duckdb",                // optional override; default = engine.dialect()
  "sourceScope": ["staging"],         // optional; restrict to sourceIds
  "options": {                        // optional; all have server defaults
    "maxRepairRounds": 2,
    "defaultLimit": 1000,
    "tokenBudget": 2500,
    "maxTables": 6
  }
}
```

Response (mirrors `SqlGenerateResponse` in `lib/rag/generate.ts` verbatim):
```jsonc
{
  "sql": "SELECT ...",                // UNTRUSTED model output; TS re-guards before execute
  "description": "...",
  "dialect": "duckdb",
  "retrieval": {
    "tables": ["staging.Shared.MonitorMeasurements", "staging.Shared.Patients"],
    "exemplarsUsed": ["ex_hr_over_120"],
    "cardinalityWarnings": ["MonitorMeasurements has ~337M rows; ..."]
  },
  "repair": { "rounds": 1, "lastError": "..." },   // present iff self-repair ran
  "cached": false,
  "error": "scope"                    // present iff out-of-clinical-scope (422 on TS side)
}
```

The TS route keeps its cache (`tenantCacheKey` includes `session.orgId`) so caching stays tenant-scoped in TS; the service is cache-agnostic and returns `cached:false` always (the TS route sets `cached:true` when it serves from `sqlCache`).

#### `POST /nl2sql/execute` — RECOMMENDATION: **execution moves to Python too** (see §2.3 decision)

Request:
```jsonc
{
  "sql": "SELECT ...",                // already TS-re-guarded before this call
  "context": { "userId": "...", "activeOrgId": "...", "role": "..." },
  "database": "staging",              // attach alias; TS still validates against allowlist first
  "schema": "Shared",
  "limit": 1000                       // TS clamps to MAX_QUERY_ROWS=5000 before calling
}
```

Response (mirrors what `/api/query` returns to the client):
```jsonc
{
  "columns": [{ "name": "PatientId", "type": "INTEGER" }],
  "rows": [ { "PatientId": 1, "RecordedAt": "..." } ],
  "rowCount": 42,
  "truncated": false
}
```

The service enforces `maxRows` + `deadlineMs` internally (the DuckDbEngine already does). **The TS route still runs `guardSql` and the catalog/schema allowlist BEFORE calling** (§1.3) — the service execution is not the boundary; it is the executor behind the boundary.

#### `POST /nl2sql/explain` — dry-run validate (internal; used by the generate self-repair loop, not called by TS directly)

Returns `{ ok: true, plan } | { ok: false, error }`. Kept as an internal method on the engine; not exposed as a TS-facing endpoint (the repair loop is inside `/nl2sql/generate`). Listed here for completeness because it is the "explain, never execute, no rows egress" guarantee (`NL2SQL_SPEC.md §5.5`).

#### `GET /healthz` and `GET /readyz`

- `/healthz`: process is up (no DB touch).
- `/readyz`: bundle is loaded AND engine attach succeeded AND embedder model is resolvable — returns the loaded `bundleVersion` + `embeddingModel.id`. The TS app gates traffic on `/readyz` during rollout.

### 2.3 Open sub-decision A — does execution move to Python? **RECOMMENDATION: YES.**

**Move execution to Python.** Rationale:

- **One DuckDB instance, one dialect, one attach topology.** The whole reason `lib/engine/provisioning.ts` exists is the P1 fix: generation must EXPLAIN-validate against the *exact same engine* that executes (`app/api/query/route.ts` header documents this). If generation moves to Python but execution stays in TS, we **re-open the P1 dialect-mismatch gap across a process boundary** — the Python engine would EXPLAIN, a *different* TS engine would EXECUTE. That is precisely the fragility this split is meant to remove. Keeping both in one process (Python) guarantees generate/execute dialect alignment structurally.
- **The DuckDB read-only ATTACH + the `@duckdb/node-api` binding** move cleanly to Python's `duckdb` package, which has first-class `ATTACH ... (TYPE postgres, READ_ONLY)` support and the `vss` extension. The read-only DB connections (`STAGING_DSN`, `MOCK_DSN`) move with it.
- **What stays in TS on the execute path:** the `/api/query` route keeps auth → rate-limit → body-size → validate → **`guardSql` + catalog/schema allowlist** → CALL `/nl2sql/execute` → audit + anomaly. The security boundary (guard) and the compliance record (audit hash-chain) stay in TS; only the DuckDB call itself crosses the wire.

Trade-off acknowledged (see §7): this adds a network hop to every query execution and moves the live read-only DB credentials into the Python process. Both are acceptable given the dialect-alignment guarantee, and the audit/guard boundary staying in TS.

### 2.4 Error envelope

The service returns a single typed envelope so the TS client maps errors deterministically onto the existing `lib/errors.ts` codes:

```jsonc
{ "error": { "kind": "scope" | "generation" | "guard" | "engine" | "bad_request" | "internal",
             "message": "human-safe, never raw internals",
             "detail": { }  } }
```

TS client mapping (`lib/nl2sqlClient.ts`):
- `scope` → `errorResponse(422, ErrorCodes.SCOPE, ...)` (unchanged semantics: model declined).
- `generation` (repair budget exhausted) → `422 ErrorCodes.SCOPE` (matches today's `GenerationError` → 422 behavior).
- `guard`/`engine`/`internal` → `safeError(..., 502)`; the raw message is logged under the audit chain in TS, never returned to the client (H20 preserved).
- Non-2xx transport / timeout → `502` "AI service is not configured/unavailable" (matches today's `getGenerationDeps` catch → 500/502).

The service **never** returns a raw OpenAI/DuckDB error body (the `createOpenAiLlmClient` H20 discipline moves into Python's LLM client).

### 2.5 Org/tenant context + the `OPENAI_BAA_SIGNED` egress gate, service-side

- **Tenant context:** `context.activeOrgId` scopes source selection (`sourceScope`) and telemetry only. The service performs **no** cross-org data access (it only ever touches the shared read-only staging/mock DBs and the shared bundle); org isolation of *cached results* remains in TS via `tenantCacheKey`. The service does not cache across requests.
- **PHI egress gate:** `assertEgressAllowed()` / `OPENAI_BAA_SIGNED` moves into the service as `ceiba_nl2sql/compliance/egress.py` and is enforced at the `callLlm` choke point (`ceiba_nl2sql/generation/pipeline.py`), exactly as `lib/rag/generate.ts` does today. The service reads `OPENAI_BAA_SIGNED` from its own env. Every LLM call carries an `egress_class`; `patient-derived` is gated closed by default, `schema-metadata` (the only class generation uses) is always allowed. **This is a strict improvement:** the gate now lives beside the code that actually calls OpenAI (the LLM client is in Python), rather than one process away from it.
- **Egress class is enforced structurally:** the prompt the service sends to OpenAI is assembled *only* from bundle metadata/glossary/exemplars (the retriever never reads a raw cell), so the `schema-metadata` guarantee is preserved by construction — same as today.

---

## 3. Code sharing with `prep` (the whole point)

### 3.1 Shared package layout — `ceiba_nl2sql`

Today `prep/` is a package whose **import root is literally `prep`** (`prep/pyproject.toml` → dist `name = "ceiba-nl2sql-prep"`, `packages.find include=["prep*"]`, entry point `prep.cli:main`). There is **no `ceiba_nl2sql` package yet** — the only `ceiba_nl2sql*` artifacts on disk are build metadata (egg-info). The plan **creates** `ceiba_nl2sql` as a new shared import root and repoints prep's imports at it. Both the prep CLI and the FastAPI service depend on it:

```
python/                                   # new top-level Python workspace (or keep under prep/)
  ceiba_nl2sql/                           # THE SHARED LIBRARY (prep + service both import)
    pyproject.toml                        # name = "ceiba-nl2sql"
    ceiba_nl2sql/
      __init__.py
      embed/
        local_embedder.py                 # ← MOVED from prep/prep/embed/ (FastEmbedEmbedder)
      compliance/
        phi.py                            # ← classify_phi.py core (normalize_key, is_phi_column, classify_column)
        egress.py                         # ← assertEgressAllowed / OPENAI_BAA_SIGNED (new, from TS phiScrubber)
        aggregate_profile.py              # ← buildAggregateProfile semantics (shared with profile stage)
      sqltools/
        guard.py                          # ← NEW sqlglot-based guard (shared by service + eval + prep exemplar validation)
        dialect.py                        # sqlglot dialect map: duckdb | postgres | trino
      bundle/
        loader.py                         # ← BundleLoader.ts ported; prep already WRITES these files
        schema.py                         # pydantic models for manifest/catalog/keys/joingraph/profiles/phi/glossary/exemplars
      engine/
        base.py                           # QueryEngine Protocol
        duckdb_engine.py                  # ← DuckDbEngine.ts ported (duckdb package)
        trino_engine.py                   # ← TrinoEngine.ts ported (deferred)
        provisioning.py                   # ← provisioning.ts ported (memoized engine)
      retrieval/
        vss.py  bm25.py  fusion.py  retriever.py
      generation/
        prompt.py  pipeline.py  llm.py    # llm.py = OpenAI client behind egress gate
      guard/
        cardinality.py                    # sqlglot-AST cardinality guard

  ceiba_nl2sql_prep/                      # the build-time CLI (was prep/prep/)
    pyproject.toml                        # depends on ceiba-nl2sql
    ceiba_nl2sql_prep/
      cli.py config.py introspect/ profile.py enrich/ emit.py phi_gate.py synthetic.py exemplars.py
      # these now IMPORT ceiba_nl2sql.embed, .compliance.phi, .bundle, .sqltools ...

  ceiba_nl2sql_service/                   # the FastAPI runtime service
    pyproject.toml                        # depends on ceiba-nl2sql, fastapi, uvicorn
    ceiba_nl2sql_service/
      app.py                              # FastAPI app: /nl2sql/generate, /execute, /explain, /healthz, /readyz
      deps.py                             # memoized bundle + engine + retriever + llm (mirror getGenerationDeps)
      settings.py                         # env: NL2SQL_BUNDLE_DIR, NL2SQL_ENGINE, STAGING_DSN, MOCK_DSN,
                                          #      OPENAI_API_KEY, OPENAI_BAA_SIGNED, NL2SQL_SERVICE_TOKEN
```

> The exact directory placement (`python/…` vs keeping everything under `prep/`) is an implementation detail; what matters is the **three-package split: shared lib + prep CLI + service**, with prep and service both depending on the shared lib.

### 3.2 What each shared piece eliminates

- **Embedder (kills gap #2):** the service imports `ceiba_nl2sql.embed.local_embedder.FastEmbedEmbedder` — the *identical* code that built `vectors.duckdb`. No cross-runtime reproduction, no `verifyEmbedderParity()`, no fp32/int8 tolerance reasoning. `lib/rag/queryEmbedder.ts` is deleted. The manifest `embeddingModel.id` check in the loader still guards against loading a mismatched bundle, but query and document vectors are now produced by one code path by construction.
- **PHI logic (kills the bridge):** `ceiba_nl2sql.compliance.phi` is the single Python implementation of `normalize_key` / `is_phi_column` / `classify_column` / `compute_columnset_hash` / `load_phi_columnset`. Today `classify_phi.py` mirrors TS "EXACTLY"; after the move, prep and the service call the same functions. **Coupling to preserve:** both prep introspectors currently load the PHI set in `__init__` via `load_phi_columnset(repo_root)`, i.e. they need a `repo_root` to locate `config/phi_columns.json`. The shared `compliance.phi` keeps this loader; the service passes its own `repo_root`/config path at startup (or a copy of `config/phi_columns.json` is baked into the service image alongside the bundle).
  - **TS side of the bridge stays as-is** (`lib/phiScrubber.ts` + `scripts/gen-phi-columns.mjs` → `config/phi_columns.json`) because the TS app still needs PHI awareness for `assertEgressAllowed` paths and audit. `config/phi_columns.json` remains the authoritative serialized set (a flat 26-key allowlist + `phiColumnsetHash`); the Python `compliance.phi` loads it (as `classify_phi.py` does now via `load_phi_columnset`). The CI drift check (`npm run phi:sync` + `git diff --exit-code config/phi_columns.json`) stays. **What disappears is the *second Python re-implementation* risk** — there is now exactly one Python copy, shared, instead of one in prep and (implicitly, via queryEmbedder-style parity work) pressure toward another in a TS runtime.
  - **Note on `buildAggregateProfile` divergence:** the TS `buildAggregateProfile` (`lib/phiScrubber.ts`) suppresses only flat `isPhiColumn` matches, whereas prep's `sample_aggregate_from_rows` additionally suppresses free-text via `classify_column`. The shared `compliance.aggregate_profile` should adopt prep's *stronger* (free-text-aware) behavior as the single implementation — a strict improvement, since the runtime never emitted aggregate profiles to the LLM anyway (it sends bundle-derived `profiles.json`, already built by prep's stronger path).
- **SQL parsing (kills lexical fragility):** `ceiba_nl2sql.sqltools.guard` uses `sqlglot` to parse in the target dialect (`sqlglot` supports `duckdb`, `postgres`, `trino`). It replaces the leading-keyword tokenizer for the *generation-side* guard and gives the cardinality guard a real AST (table refs from the FROM/JOIN nodes, predicate columns from the WHERE tree) instead of substring matching. `sqlglot` is added to the shared lib's dependencies. Prep's exemplar validation (`exemplars.py`, which marks `validated:true`) uses the same parser, so an exemplar that parses in prep parses identically at runtime.
- **Bundle loader:** prep *writes* the bundle; the service *reads* it. Sharing `bundle/schema.py` (pydantic models) means the write side and read side share one schema definition — a field rename can't silently desync the two.

### 3.3 One caveat on "one source of truth"

`lib/phiScrubber.ts` (TS) still exists and still owns the *serialized* PHI set (`config/phi_columns.json`) because the TS app retains PHI-aware audit/egress paths. The plan does **not** delete TS PHI logic; it removes the *duplication pressure inside the NL→SQL runtime* by making the runtime Python and sharing prep's Python PHI code. Fully collapsing TS PHI logic is out of scope (it would touch audit/anomaly, not the NL→SQL runtime).

---

## 4. What we KEEP from the TS work (so it isn't wasted)

The TS NL→SQL code is well-tested; the tests are the asset we preserve as **behavioral contracts** the Python port must satisfy.

| Existing TS test suite | Becomes | How |
|---|---|---|
| `lib/rag/__tests__/**` (Retriever, bm25, rankFusion, vssClient, generate, promptAssembly, cardinalityGuard, BundleLoader) | **Python unit tests** in `ceiba_nl2sql/tests/**` (pytest) + a small set of **contract fixtures** | Port assertions 1:1; the fixture bundle (`lib/rag/__tests__/fixtures/bundles/mock-v1`) moves/copies into the Python test tree. Deterministic test embedder (`createDeterministicTestEmbedder` / `DeterministicHashEmbedder`) already exists in Python (`local_embedder.py`) — the fixture vectors were built with it. |
| `lib/engine/__tests__/**` (DuckDbEngine attach/read-only/execute/explain) | **Python unit tests** | Port; DuckDB behavior is engine-level and language-agnostic. The `NonReadOnlyAttachError` + `duckdb_databases().readonly` re-check port directly. |
| `app/api/sql-generate` route test, `app/api/query` route test (the `__setGenerationDepsForTest` / `__setQueryEngineForTest` seams) | **TS contract/integration tests against the service** | The TS route tests stay TS but now stub the **service client** (`lib/nl2sqlClient.ts`) instead of `getGenerationDeps`. A new **contract test** starts the real FastAPI service (test bundle) and asserts request/response shape end-to-end. |
| `eval/__tests__/eval.test.ts` + `eval/**` | **See §4.1 recommendation** | — |

New tests the split requires: (1) a **service contract test** (TS client ⇄ FastAPI, schema + error-envelope mapping), (2) a **dialect-alignment test** (generate `/explain` and execute `/execute` use the same engine dialect — the P1 guarantee, now asserted across the API), (3) a **cross-language golden-vector test** if any fixture is regenerated (assert the ported loader reads prep-written bundles).

**Assets that carry over directly:**
- `lib/sqlGenerateClient.ts` already defines the client-side wire contract (`SqlGenerateSuccess`, `interpretSqlGenerateResponse`, 422-SCOPE handling) — the new `lib/nl2sqlClient.ts` reuses this response shape verbatim, so the front-end (`app/data-explorer/page.tsx`) sees no change.
- `lib/engine/__tests__/QueryEngine.contract.test.ts` is already a **contract** test asserting any engine satisfies the interface — it ports to pytest as the Python engine's contract test.
- `lib/rag/__tests__/fixtures/bundles/mock-v1` (the committed fixture bundle) and its **test-fallback vectors** were built with the Python `DeterministicHashEmbedder`; the Python retriever tests reuse this fixture directly (no regeneration needed). Python-side parity anchors already exist in `prep/tests` (`test_embed_local_only`, `test_vss_no_phi`, `test_manifest_integrity`).
- The retriever's LLM-prune stage is already an **injectable** `LlmPrune` with a deterministic stub (`createDeterministicStubLlmPrune`) — ports 1:1, keeping CI hermetic.

### 4.1 Open sub-decision B (eval harness) — RECOMMENDATION: **move the eval harness to Python**

The eval harness (`eval/runEval.ts`, `eval/score.ts`, `eval/synthetic/loadSynthetic.ts`, `eval/fixtures/recordedLlm.ts`, `eval/cli.ts`, golden `.jsonl`, `adversarial.jsonl`) drives `lib/rag` + `lib/engine` **directly** (imports `HybridRetriever`, `DuckDbEngine`, `generateSql`, `createDeterministicTestEmbedder`). Once those modules are Python, the eval harness would otherwise have to call them over HTTP — losing the in-process determinism and the direct scorer access it relies on.

**Recommendation: port the eval harness to Python** (`ceiba_nl2sql_eval/` or under the service package), importing `ceiba_nl2sql` directly (same as prep does). Keep the `.jsonl` golden/adversarial corpora **as data, unchanged** (they are language-neutral — `eval/golden/*.jsonl`, `eval/adversarial.jsonl` move verbatim). The recorded LLM stub (`recordedLlm.ts`) ports to a Python `RecordedLlmClient`. The synthetic topology loader (`loadSynthetic.ts` → DuckDB fixtures from `synthetic.json`) ports to Python; prep already emits `synthetic.json` and already has DuckDB.

Why not keep eval in TS calling the service? Because eval's whole value is scoring *internal* signals (guardPasses, parses, referencesRealTables, cardinalityBounded) that come from the guard/engine/retriever objects directly; forcing them through the HTTP contract would either bloat the API with eval-only fields or lose signal. Eval belongs next to the runtime it measures. The **synthetic CI eval lane** then runs in the Python CI job (§6), hermetic, no network — matching today's `nl2sql-ci.yml` `eval` job posture.

---

## 5. Migration sequencing (strangler pattern; each phase shippable + tested)

Guiding rule: **TS and Python coexist during transition.** The Python service stands up alongside the Next app; the TS routes cut over one endpoint at a time behind a feature flag; the TS `lib/rag`/`lib/engine` modules are retired only after their Python replacement has served production traffic behind the flag.

Feature flag: `NL2SQL_RUNTIME` env, values `ts` (default, today) | `python`. Read per-endpoint by the route wrapper. A per-endpoint sub-flag (`NL2SQL_GENERATE_RUNTIME`, `NL2SQL_EXECUTE_RUNTIME`) allows cutting over generate before execute.

### Phase 1 — Shared library extraction (no behavior change, no cutover)
Create `ceiba_nl2sql` shared package by **moving** `prep/prep/embed/local_embedder.py`, the `classify_phi.py` core, and `aggregate_profile` semantics into it; repoint `prep` imports at the shared lib. Add `sqlglot`. Prep behaves identically; its existing pytest suite + PHI gate prove no regression. **Nothing in TS changes.** Ship: prep still builds bundles; CI green.

### Phase 2 — Stand up the FastAPI service (dark, not wired)
Port `BundleLoader`, `vssClient`, `bm25`, `rankFusion`, `Retriever`, `promptAssembly`, `cardinalityGuard` (now sqlglot), `generate`, `QueryEngine`/`DuckDbEngine`/`provisioning`, and the OpenAI LLM client + egress gate into `ceiba_nl2sql` + `ceiba_nl2sql_service`. Implement `/nl2sql/generate`, `/execute`, `/explain`, `/healthz`, `/readyz` + service-token auth. Port the `lib/rag`/`lib/engine` unit tests to pytest (§4). The service runs in dev/CI but **no TS route calls it yet.** Ship: service deployable, health-green, but dark.

### Phase 3 — Cut over `sql-generate` behind the flag
Add `lib/nl2sqlClient.ts` (fetch + Bearer token + error-envelope mapping). In `app/api/sql-generate/route.ts`, when `NL2SQL_GENERATE_RUNTIME=python`, replace the `getGenerationDeps()` + `generateSql()` block with a call to `POST /nl2sql/generate` (auth/rate-limit/body-size/validate/cache **unchanged**, still TS). Keep the TS path behind `=ts`. Roll out: flag off → canary org(s) → all. Ship: generation served by Python for flagged traffic; TS fallback one env var away.

### Phase 4 — Cut over `query` execution behind the flag
Add `POST /nl2sql/execute` call to `app/api/query/route.ts` when `NL2SQL_EXECUTE_RUNTIME=python`. **Order preserved:** auth → rate-limit → body-size → validate → **`guardSql` + allowlist (TS)** → call `/nl2sql/execute` → audit + anomaly (TS). The **dialect-alignment guarantee** is now cross-service but structural: with `NL2SQL_RUNTIME=python`, generate's `/explain` and query's `/execute` hit the *same Python engine process* (same `provisioning.py` memoized instance), so the P1 fix holds. Move `STAGING_DSN`/`MOCK_DSN` into the service's env; the TS app no longer needs live DB creds (it keeps them only while `=ts`). Ship: full NL→SQL path served by Python for flagged traffic.

### Phase 5 — Move the eval harness to Python (§4.1)
Port `runEval`/`score`/`loadSynthetic`/`recordedLlm` to Python; move golden/adversarial `.jsonl` verbatim; wire the Python eval CI lane. Retire the TS eval once the Python eval reproduces the same scores on the fixture bundle (assert parity in the PR). Ship: one eval harness, in Python, hermetic in CI.

### Phase 6 — Retire the TS runtime modules
With `NL2SQL_RUNTIME=python` default in all environments and a bake period elapsed, delete `lib/rag/**`, `lib/engine/**`, `lib/rag/queryEmbedder.ts`, and the now-unused `@duckdb/node-api` + `@huggingface/transformers` dependencies. **Keep `lib/sqlGuard.ts`** (the `/api/query` re-guard, §1.3) and everything in §1.2. Ship: TS app is a thin, hardened API gateway + UI; the NL→SQL runtime is entirely Python.

### Rollback
Every phase rolls back by **flipping the flag** (`NL2SQL_*_RUNTIME=ts`) — no redeploy of code, only an env change, until Phase 6. Phase 1 rolls back by reverting the import repoint (prep-only, no user impact). Phase 6 is the only irreversible-by-flag step; it is gated on a bake period with the flag defaulted to `python` and the Python path carrying 100% of traffic with no elevated error rate. Detailed per-phase rollback in the table below.

---

## 6. Deployment / ops delta

**Before:** one process (Next.js). **After:** two processes — Next.js (Node) + FastAPI (uvicorn) — plus the existing mock Postgres and (opt-in) staging tunnel.

### Local dev
Add a root **`docker-compose.yml`** composing three services: `web` (Next dev), `nl2sql` (uvicorn `--reload` on the service package), and the existing `mock-postgres` (fold in `docker/mock-postgres/docker-compose.yml`, keeping port 55433 and the `ceiba_ro` read-only role). `web` gets `NL2SQL_SERVICE_URL=http://nl2sql:8088` + `NL2SQL_SERVICE_TOKEN`; `nl2sql` gets `NL2SQL_BUNDLE_DIR`, `MOCK_DSN` (pointing at `ceiba_ro@mock-postgres`), `OPENAI_API_KEY`, `OPENAI_BAA_SIGNED`, `NL2SQL_SERVICE_TOKEN`. `STAGING_DSN` stays unset by default (opt-in). A `make dev` / npm script brings all three up.

### CI (`.github/workflows/nl2sql-ci.yml`)
Today: three jobs — `ts-tests` (Vitest + PHI drift check), `py-tests` (pytest for prep), `eval` (Vitest synthetic). Delta:
- Extend **`py-tests`** to install `ceiba_nl2sql` + `ceiba_nl2sql_service` and run their pytest suites (the ported `lib/rag`/`lib/engine` tests). Add the Postgres service container (already stubbed as a TODO in the workflow) for the introspection/execute tests. Run the PHI gate.
- Add a **`service-contract`** job: boot the FastAPI service against the committed fixture bundle, run the TS contract test (`lib/nl2sqlClient.ts` ⇄ service) — validates the wire schema + error mapping.
- Migrate the **`eval`** job from Vitest to Python (Phase 5), still synthetic-only, `STAGING_DSN` explicitly unset (the existing defense-in-depth stance).
- Keep the **PHI drift check** in `ts-tests` unchanged (`npm run phi:sync` + `git diff --exit-code config/phi_columns.json`).

### Production deploy
Two containers behind the same private network. The Next container is the only public ingress; the FastAPI container binds private-only. Startup ordering: `nl2sql` must be `/readyz`-green (bundle loaded, engine attached) before `web` routes flag-on traffic to it. Health checks: platform liveness → `/healthz`; readiness gate → `/readyz`. The **read-only DB connections move into the `nl2sql` container** (§2.3); the Next container drops `STAGING_DSN`/`MOCK_DSN` once `NL2SQL_RUNTIME=python` is permanent. Bundle distribution: the `nl2sql` container mounts (or bakes) the artifact bundle dir; `NL2SQL_BUNDLE_DIR` points at it — same portable-directory model prep already produces (`NL2SQL_SPEC.md §1.1`).

### Health checks summary
- `web`: existing Next health + a passthrough that pings `nl2sql /readyz` for the dashboard.
- `nl2sql`: `/healthz` (process), `/readyz` (bundle + engine + embedder). `/readyz` returns `bundleVersion` + `embeddingModel.id` for observability.

### Config / env deltas the split requires
- **`NL2SQL_BUNDLE_DIR` becomes a first-class service env var.** Today the TS route reads `process.env.NL2SQL_BUNDLE_DIR` but it is **not in `.env.example`**, and eval hardcodes `DEFAULT_FIXTURE_BUNDLE_DIR`. The service formalizes it in `settings.py` and adds it to `.env.example`.
- **New env vars:** `NL2SQL_SERVICE_URL` + `NL2SQL_SERVICE_TOKEN` (both processes), `NL2SQL_SERVICE_PORT` (service), `NL2SQL_RUNTIME` / `NL2SQL_GENERATE_RUNTIME` / `NL2SQL_EXECUTE_RUNTIME` (TS route flags).
- **Env vars that MOVE from Next to the service:** `MOCK_DSN`, `STAGING_DSN`, `OPENAI_API_KEY`, `OPENAI_BAA_SIGNED`, `NL2SQL_ENGINE`. The Next container keeps them only while `NL2SQL_RUNTIME=ts`.
- **In-process state caveat:** `lib/rateLimiter.ts` and `lib/cache.ts` are **per-instance in-process** (a Map / LRU) today. They **stay in TS** and remain per-Next-instance — the split does not change their scope. The service holds no rate-limit or result cache; rate-limiting stays a TS concern in front of the service call. (A shared Redis store is the documented upgrade for both, unchanged by this plan.)
- **Stale config to fix in passing:** `next.config.js` CSP still references Clerk domains (auth migrated); not in this plan's scope but noted so the service cutover PRs don't inherit confusion.

---

## 7. Risks & what gets HARDER (honest trade-offs)

1. **Network hop on every generate + every execute.** Two extra round-trips per NL→SQL flow. Mitigation: same-host/private-network (localhost latency ~sub-ms), the engine + bundle are memoized in the service (no per-request load), and generation is already dominated by the OpenAI call (hundreds of ms) so the hop is noise there. Execution adds one hop in front of a DuckDB query that itself dominates. Net p50 impact expected small; must be measured in the canary.
2. **Service-to-service auth is now a thing.** A shared Bearer token is simple but is a new secret to rotate (`SECRET_ROTATION.md` gets an entry) and a new failure mode (token drift → 401 storms). Mitigation: token in both processes' env from one secret source; `/readyz` does not require the token so orchestration health checks don't depend on it; documented mTLS upgrade path for any cross-host topology.
3. **Dialect alignment across a process boundary.** The P1 fix (generate EXPLAIN dialect == execute dialect) now spans two API calls. Mitigation: with `NL2SQL_RUNTIME=python`, BOTH hit the same Python engine process/instance (`provisioning.py` memoized), so alignment is structural, not coincidental — *stronger* than today's TS-internal guarantee because there is exactly one engine, in one language, behind one interface. A **dialect-alignment contract test** (§4) asserts it. The *danger window* is a misconfiguration where generate is `python` but execute is `ts` (two engines again): the plan mitigates by making `NL2SQL_RUNTIME` the primary flag and treating per-endpoint flags as transition-only, with a startup assertion that warns if generate/execute runtimes diverge.
4. **PHI egress gate now in Python.** `OPENAI_BAA_SIGNED` is read by the service. Risk: a deploy that sets the gate in the Next env but not the service env would mis-gate. Mitigation: the gate is enforced *only* where the OpenAI call is made (the service) — so the service env is the single authoritative place; the Next env no longer needs it once cutover completes. `/readyz` can surface the gate state for audit. This is a *net simplification* (gate beside the caller) but the migration window has both envs live.
5. **Latency + cost of two stacks.** Two containers = more memory (a Python process holding DuckDB + fastembed model + bundle, on top of Node). Mitigation: the fastembed model (~130MB) and bundle load once per process; Python's footprint is bounded and the model was going to be loaded *somewhere* (it was in the Node process via transformers.js before). Running two smaller processes vs one large one is roughly cost-neutral; the operational surface (two deploys, two logs, two health checks) is the real added cost — accepted for the parity/guard wins.
6. **Two languages to keep in sync at the API seam.** The request/response schemas exist in both Pydantic (service) and TS (`SqlGenerateResponse` etc.). Mitigation: the schemas already exist verbatim in TS; the contract test is the guard against drift. (A future OpenAPI-generated TS client is a documented option, not required now.)
7. **Observability spans two processes.** A single NL→SQL request now traces through Next → FastAPI → DuckDB. Mitigation: propagate a request-id header from TS into the service and into audit; the audit hash-chain stays authoritative in TS (it already logs `QUERY_RUN`/`QUERY_FAILED` with orgId). The service logs its own structured lines keyed by the same request-id.

---

## 8. What this ELIMINATES vs. what it INTRODUCES

### Eliminated (current gaps/risks that vanish)
- **JS embedder parity risk (gap #2) — GONE.** `lib/rag/queryEmbedder.ts` and its transformers.js reproduction, the fp32-vs-int8 tolerance reasoning, and `verifyEmbedderParity()` are deleted. Query and document vectors are produced by the *same* `FastEmbedEmbedder` code. This is the single clearest win.
- **Dialect-parsing fragility — GONE / DOWNGRADED to defense-in-depth.** The generation-side guard and cardinality guard move from a hand tokenizer + lexical substring matching to real `sqlglot` AST parsing in the target dialect. The TS tokenizer guard survives only as the execution-time re-guard (a deliberately simple, dependency-free boundary), no longer the primary classifier.
- **TS↔Python PHI re-implementation pressure — REDUCED to one Python copy.** `classify_phi.py`'s "mirror TS EXACTLY" burden collapses into a shared `ceiba_nl2sql.compliance.phi` that prep and the service both import. (`config/phi_columns.json` + the drift check remain as the serialized authoritative set — that bridge is intentionally kept; what is removed is the *second live implementation*.)
- **Two DuckDB bindings — GONE.** `@duckdb/node-api` (TS) is replaced by the Python `duckdb` package; one binding, one attach/read-only enforcement code path shared with prep's `duckdb_introspector.py`.
- **Bundle write/read schema desync risk — REDUCED.** prep writes and the service reads through one shared `bundle/schema.py`.

### Introduced (new gaps/risks that appear)
- **A service-to-service trust boundary** (token/mTLS) — §7.2.
- **A network partition failure mode** — the Next app must degrade gracefully when `nl2sql` is unreachable (map to the existing 502 "AI service unavailable"); a new dependency for `/api/query` that previously had none.
- **Cross-process dialect-alignment configuration risk** — §7.3 (mitigated by single `NL2SQL_RUNTIME` flag + startup assertion).
- **Env-var duplication window** for `OPENAI_BAA_SIGNED` during migration — §7.4.
- **A second deploy/observability surface** — §7.5, §7.7.

Net: the eliminated risks are *correctness/compliance-parity* risks (silent wrong-vector-space retrieval, lexical guard bypass, PHI classification drift). The introduced risks are *operational* (a service boundary, a config flag, a health dependency) — the kind the team already manages for the DB and OpenAI. This is the intended trade: convert hard-to-detect parity bugs into visible operational surface.

---

## 9. Phase table (phase → what moves → DoD → rollback)

| Phase | What moves | Definition of Done | Rollback |
|---|---|---|---|
| **1. Shared lib** | `local_embedder.py`, PHI core, `aggregate_profile` → `ceiba_nl2sql`; add `sqlglot`; prep imports repointed | prep's pytest + PHI gate green; bundles byte-identical to before; no TS change | Revert import repoint (prep-only, no user impact) |
| **2. Service dark** | Port BundleLoader, vss/bm25/fusion/Retriever, promptAssembly, cardinalityGuard(sqlglot), generate, QueryEngine/DuckDbEngine/provisioning, LLM client + egress gate → `ceiba_nl2sql`/service; FastAPI `/generate` `/execute` `/explain` `/healthz` `/readyz` + token auth; ported unit tests pass | Service boots, `/readyz` green on fixture bundle; ported pytest suite passes; NO TS route calls it | Do not deploy the service; delete container. Zero user impact (dark) |
| **3. Cut over generate** | `lib/nl2sqlClient.ts`; `sql-generate` route calls `/nl2sql/generate` when `NL2SQL_GENERATE_RUNTIME=python` | Flagged traffic served by Python; response shape identical (contract test); canary org error rate flat; TS path still works with flag off | `NL2SQL_GENERATE_RUNTIME=ts` (env flip, no redeploy) |
| **4. Cut over execute** | `query` route calls `/nl2sql/execute` when `NL2SQL_EXECUTE_RUNTIME=python`; DB creds move to service; TS guard/audit order preserved | Full NL→SQL path via Python for flagged traffic; dialect-alignment contract test green (one engine); audit chain still records QUERY_RUN in TS | `NL2SQL_EXECUTE_RUNTIME=ts` (env flip); DB creds still present in Next while `=ts` |
| **5. Eval → Python** | `runEval`/`score`/`loadSynthetic`/`recordedLlm` → Python; golden/adversarial `.jsonl` verbatim; CI eval lane → Python | Python eval reproduces TS eval scores on fixture bundle (parity asserted in PR); CI eval lane green, synthetic-only, `STAGING_DSN` unset | Keep TS eval until parity proven; revert CI lane to Vitest |
| **6. Retire TS runtime** | Delete `lib/rag/**`, `lib/engine/**`, `queryEmbedder.ts`, `@duckdb/node-api`, `@huggingface/transformers`; KEEP `lib/sqlGuard.ts` + all §1.2 | `NL2SQL_RUNTIME=python` default everywhere; bake period elapsed at 100% Python traffic, error rate flat; TS build has no dead NL→SQL imports | Git revert of the deletion commit (only phase not flag-reversible; gated on bake period) |

---

## 10. Recommendations on the two open sub-decisions (summary)

- **Sub-decision A — does execution move to Python? → YES.** Keeping DuckDB execution in TS while generation moves to Python re-opens the P1 dialect-mismatch gap across a process boundary. Moving both into the one Python engine process makes generate/execute dialect alignment structural. The TS `/api/query` route keeps its guard + catalog/schema allowlist + audit; only the DuckDB call itself crosses the wire (`POST /nl2sql/execute`). (§2.3)
- **Sub-decision B — does the eval harness move to Python? → YES.** It imports the runtime modules directly and scores internal signals; forcing it through HTTP would lose signal or bloat the API. Port it to Python beside the runtime it measures; keep the golden/adversarial `.jsonl` corpora verbatim as language-neutral data. (§4.1)
- **SQL guard (asked in §1) → Python authoritative (sqlglot), TS `/api/query` re-guard retained.** The guard becomes a shared, real-parser Python module used by the service, prep exemplar validation, and eval; the TS tokenizer guard stays as the execution-time boundary re-guard. Read-only enforcement remains layered (DB role → Python guard → TS re-guard → known-tables allowlist), now spanning both processes and one layer *deeper* than today. (§1.3)
