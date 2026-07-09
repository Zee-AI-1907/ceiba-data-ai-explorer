# TS Runtime Retirement Plan

**Status:** planning only — no code changed by this document.
**Owner directive (task #58):** move ALL query/DB/LLM logic to Python; TypeScript keeps ONLY user/auth/coordination. Two decisions are already made by the user and OVERRIDE the prior plan (`docs/PYTHON_NL2SQL_SERVICE_PLAN.md` §1.3 and Phase 6, which deferred the delete and *kept* `lib/sqlGuard.ts`):

1. **Delete the TS runtime NOW** — no bake period. `lib/engine/*`, `lib/rag/*`, `lib/sqlGuard.ts`, `lib/trinoClient.ts`, `lib/sqlGenerateClient.ts`, and the `'ts'` rollback path in the runtime flag. This forfeits the single-env-flip rollback — accepted.
2. **Move the `guardSql` execution security boundary INTO Python.** Today `guardSql` runs in `app/api/query/route.ts:197` as a re-guard (the documented execution boundary, `PYTHON_NL2SQL_SERVICE_PLAN.md` §1.3). It moves to the Python service (which already runs `guard_sql`). TS becomes purely auth/coordination. The DB read-only role remains the primary control.

> **Prior-plan divergence (called out honestly):** `PYTHON_NL2SQL_SERVICE_PLAN.md` §6 Phase 6 and §10 both say *"KEEP `lib/sqlGuard.ts`"* as the execution-time re-guard. This plan deliberately reverses that per the user's decision #2. The security consequence is analyzed in [§3 Guard Relocation](#3-guard-relocation--trust-model).

---

## 1. Goal

After this work:

- **TypeScript** = a thin, hardened API gateway + UI. Per request it does: AuthN/AuthZ (`requireAuthWithPermission`), RBAC, org/tenant scoping (`session.orgId`), rate-limit, body-size cap, body validation, catalog/schema allowlist, then it **POSTs to the Python service** and runs the **audit + anomaly** post-pipeline on the response. It owns **no** SQL parsing, no DuckDB, no retrieval, no LLM call, no dialect logic.
- **Python** (`ceiba_nl2sql_service` + `ceiba_nl2sql`) = the authoritative NL→SQL runtime: retrieval, generation, EXPLAIN/self-repair, the **`guard_sql` security boundary**, DuckDB execution, native single-source routing, and the OpenAI egress gate.
- **The runtime flag collapses** to always-python (see [§5](#5-flag-removal)).

Grounding note: the Python `/nl2sql/execute` endpoint **already calls `guard_sql` before executing** (`ceiba_nl2sql_service/ceiba_nl2sql_service/app.py:279`). Decision #2 is therefore mostly a *removal* on the TS side plus a *re-labeling* of the boundary, not net-new Python code.

---

## 2. Inventory

### 2.1 DELETE (TS runtime)

| File | Public surface | Why it goes |
|---|---|---|
| `lib/engine/QueryEngine.ts` | `QueryEngine`, `AttachSpec`, `EngineCapabilities`, **`SqlDialect`** types | Engine interface — Python `ceiba_nl2sql/engine/base.py` is authoritative. `SqlDialect` must be rehomed first (see 2.3). |
| `lib/engine/DuckDbEngine.ts` | `DuckDbEngine` | DuckDB execution → `ceiba_nl2sql/engine/duckdb_engine.py`. |
| `lib/engine/TrinoEngine.ts` | `TrinoEngine` | Trino engine (stub) → Python. |
| `lib/engine/provisioning.ts` | `getQueryEngine`, `resolvedDialect`, `KNOWN_ATTACH_ALIASES`, `MOCK_ALIAS`, `__setQueryEngineForTest` | Engine memoization/attach → `ceiba_nl2sql_service/deps.py` + `provisioning`. **Note:** `KNOWN_ATTACH_ALIASES`/`MOCK_ALIAS` are consumed by `app/api/query/route.ts` for the allowlist — must be re-sourced (see 2.2). |
| `lib/engine/index.ts` | barrel re-exports | Zero importers (verified). Deletes cleanly. |
| `lib/rag/generate.ts` | `generateSql`, `GenerationError`, `LlmClient`, **`SqlGenerateResponse`**, `EgressBlockedError` | Generation pipeline → `ceiba_nl2sql/generation/pipeline.py`. `SqlGenerateResponse` must be rehomed (see 2.3). Egress gate already ported (`ceiba_nl2sql/compliance/egress.py`). |
| `lib/rag/Retriever.ts` | `HybridRetriever`, `Retriever`, `RetrieveOptions`, `SchemaContext`, … | → `ceiba_nl2sql/retrieval/retriever.py`. |
| `lib/rag/BundleLoader.ts` | `TEST_FALLBACK_EMBEDDING_MODEL_ID`, `TimeViaHint` | → `ceiba_nl2sql/bundle/loader.py`. |
| `lib/rag/promptAssembly.ts` | `assemblePrompt`, `assembleRepairPrompt`, `PromptAssemblyOptions` | → `ceiba_nl2sql/generation/prompt.py`. |
| `lib/rag/cardinalityGuard.ts` | `cardinalityGuardFromContext` | → `ceiba_nl2sql/guard/cardinality.py`. |
| `lib/rag/bm25.ts` | (search) | Zero importers (verified). → `ceiba_nl2sql/retrieval/bm25.py`. |
| `lib/rag/rankFusion.ts` | (search) | Zero importers (verified). → `ceiba_nl2sql/retrieval/fusion.py`. |
| `lib/rag/queryEmbedder.ts` | `createLocalQueryEmbedder` | → `ceiba_nl2sql/embed/local_embedder.py`. Deleting it eliminates the JS-embedder parity risk (see [§7](#7-risks)). |
| `lib/rag/vssClient.ts` | `EmbedQuery`, `createDeterministicTestEmbedder` | → `ceiba_nl2sql/retrieval/vss.py`. |
| `lib/sqlGuard.ts` | `guardSql`, `stripCommentsAndSplit`, `allowAllTables`, `TableAllowlistCheck` | **Decision #2** — boundary moves to Python `ceiba_nl2sql/sqltools/guard.py`. See §3. |
| `lib/trinoClient.ts` | `executeTrinoQuery`, `DbTarget` | Only `TrinoEngine.ts` imports it; both go. |
| `lib/sqlGenerateClient.ts` | `interpretSqlGenerateResponse`, `SqlGenerateSuccess`, `SqlGenerateInterpretation` | **Conflict — see [Open Questions](#open-questions).** This is a *pure client-side response parser* the UI depends on (`app/data-explorer/page.tsx:11`); it has NO runtime/DB/LLM coupling. Recommend **KEEP** (re-classify as coordination) rather than delete. |

**Dependencies to drop from `package.json` after deletion:** `@duckdb/node-api`, `@huggingface/transformers` (transformers.js). (Confirm no other importer before removing.)

### 2.2 KEEP (coordination / security / compliance layer)

| File / concern | Location | Role after |
|---|---|---|
| Service client | `lib/nl2sqlServiceClient.ts` | The only Next→FastAPI networking surface. `generateSqlViaService`, `executeSqlViaService`. **Break to fix:** imports `SqlDialect` at line 39 (see 2.3). |
| Runtime flag | `lib/nl2sqlRuntime.ts` | Simplifies to always-python (see §5). |
| Query route | `app/api/query/route.ts` | Rewritten to thin proxy (see §4). |
| Generate route | `app/api/sql-generate/route.ts` | Rewritten to thin proxy (see §4). |
| Auth / RBAC | `lib/apiAuth.ts` (`requireAuthWithPermission`) | Unchanged. |
| Rate-limit | `lib/rateLimiter.ts` | Unchanged, stays per-Next-instance. |
| Validation / body-size | `lib/validation.ts` (`enforceBodySize`, `parseBody`, `QueryBodySchema`, `SqlGenerateBodySchema`, `clampLimit`) | Unchanged. |
| Org-scoped cache | `lib/cache.ts` (`sqlCache`, `tenantCacheKey`) | Unchanged, stays TS-side in front of the service. |
| Audit log | `lib/auditLog.ts` (`logWithSession`, `logAuditEvent`, `getRecentAuditEvents`) | Unchanged — hash-chain stays authoritative in TS. |
| Anomaly detector | `lib/anomalyDetector.ts` (`detectAnomalies`) | Unchanged. |
| Errors / H20 scrub | `lib/errors.ts` (`safeError`, `errorResponse`, `ErrorCodes`) | Unchanged. |
| **PHI scrubber + egress gate** | `lib/phiScrubber.ts` | **KEEP.** Used by `app/api/narrative/route.ts`, `app/api/chat/route.ts`, `app/api/chart-suggest/route.ts` (routes NOT in this refactor) and owns `config/phi_columns.json`. Not on the `/api/query` path. See [§7](#7-risks). |

Confirmed clean (import no deleted module): `lib/errors.ts`, `lib/validation.ts`, `lib/cache.ts`, `lib/auditLog.ts`.

### 2.3 BROKEN IMPORTS — the correctness-critical list

Grepped for every importer of each deleted module (alias `@/lib/...` and relative forms). Importers that are **themselves in the delete set** resolve automatically. The rows below are the ones **outside** the delete set that break the build and MUST be fixed.

| Broken importer (KEEP/OUTSIDE) | Line | Import | Kind | Fix |
|---|---|---|---|---|
| `app/api/sql-generate/route.ts` | 8 | `QueryEngine, SqlDialect` from `@/lib/engine/QueryEngine` | type | rewrite route (§4); rehome `SqlDialect` |
| `app/api/sql-generate/route.ts` | 9 | `getQueryEngine, resolvedDialect` from `provisioning` | value | rewrite route (§4) — remove |
| `app/api/sql-generate/route.ts` | 10 | `HybridRetriever` from `rag/Retriever` | value | rewrite route (§4) — remove |
| `app/api/sql-generate/route.ts` | 11 | `createLocalQueryEmbedder` from `rag/queryEmbedder` | value | rewrite route (§4) — remove |
| `app/api/sql-generate/route.ts` | 12–17 | `generateSql, GenerationError, LlmClient, SqlGenerateResponse` from `rag/generate` | value+type | rewrite route (§4); rehome `SqlGenerateResponse` |
| `app/api/query/route.ts` | 9 | `guardSql` from `@/lib/sqlGuard` | value | **decision #2** — remove; guard now Python-side (§3) |
| `app/api/query/route.ts` | 10 | `getQueryEngine, KNOWN_ATTACH_ALIASES, MOCK_ALIAS` from `provisioning` | value | rewrite route (§4); re-source aliases (below) |
| `lib/nl2sqlServiceClient.ts` (KEEP) | 39 | `SqlDialect` from `@/lib/engine/QueryEngine` | type | rehome `SqlDialect` (below) |
| `app/data-explorer/page.tsx` | 11 | `interpretSqlGenerateResponse` from `@/lib/sqlGenerateClient` | value | KEEP `sqlGenerateClient.ts` (Open Q) OR inline the parser |

**Type rehoming — required before any deletion compiles:**

- **`SqlDialect`** (currently `lib/engine/QueryEngine.ts`). Surviving consumers: `lib/nl2sqlServiceClient.ts:39`, `app/api/sql-generate/route.ts:8`, `lib/sqlGenerateClient.ts:26`. **Fix:** define `export type SqlDialect = 'duckdb' | 'trino' | 'postgres'` in a small retained module — recommend `lib/nl2sqlServiceClient.ts` itself (it is the coordination seam and already defines the wire types), or a new `lib/nl2sqlTypes.ts`. Repoint the three consumers.
- **`SqlGenerateResponse`** (currently `lib/rag/generate.ts:100`). Surviving consumer: `app/api/sql-generate/route.ts`. **Fix:** the wire-equivalent already exists as `Nl2sqlGenerateResult` in `lib/nl2sqlServiceClient.ts:60`. The rewritten route can use that directly (or re-export a `SqlGenerateResponse` alias from the service client). No separate type file needed.
- **`KNOWN_ATTACH_ALIASES` / `MOCK_ALIAS`** (currently `lib/engine/provisioning.ts`). Consumed by `app/api/query/route.ts` for the `ALLOWED_ALIASES` allowlist. **Fix:** these are now *coordination policy*, not engine state — inline them as constants in the query route (or a tiny `lib/attachAliases.ts`): `MOCK_ALIAS='mock'`, `KNOWN_ATTACH_ALIASES=['mock','staging']`. They must stay TS-side because the allowlist is a coordination control (§4).

### 2.4 TEST / EVAL files that import deleted modules (deleted or rewritten — see §6)

`*.test.ts` importing deleted modules: `app/api/sql-generate/__tests__/route.test.ts`, `app/api/query/__tests__/route.test.ts`, `lib/rag/__tests__/generate.test.ts`, `lib/rag/__tests__/promptAssembly.test.ts`, `lib/rag/__tests__/thinSlice.test.ts`, `tests/unit/sqlGuard.test.ts`, `tests/unit/sqlGuardParity.test.ts`, `lib/__tests__/sqlGenerateClient.test.ts`.
Eval scripts (also break): `eval/runEval.ts`, `eval/score.ts`, `eval/synthetic/loadSynthetic.ts`, `eval/fixtures/recordedLlm.ts`.

---

## 3. Guard Relocation + trust model

### Does Python already guard before executing? — YES.
`ceiba_nl2sql_service/app.py:279`:
```python
guard_verdict = guard_sql(payload.sql, dialect=state.engine.dialect())
if not guard_verdict.allowed:
    return envelope_response("guard", guard_verdict.reason or "SQL rejected by the read-only guard.")
```
It runs **before** `state.engine.execute` (app.py:295). `/nl2sql/explain` guards too (app.py:251). So the TS `guardSql` at `app/api/query/route.ts:197` is, on the python path, **redundant** — every execution already passes through `guard_sql`. Removing it (decision #2) does not leave the executor unguarded; it relocates the single authoritative guard to sit immediately in front of the DuckDB call it protects (a *stronger* structural position than a re-guard two network hops upstream).

### What changes in TS
- Delete `guardSql` import + the guard block (route.ts:197–207) and the `QUERY_FAILED`/422-SCOPE branch that depended on it.
- The service now returns error-envelope `kind:"guard"` (app.py:284) for a rejected statement. `lib/nl2sqlServiceClient.ts` already parses `kind:"guard"` (`Nl2sqlServiceErrorKind` includes `'guard'`, line 82). The rewritten route maps `kind:"guard"` → **422 SCOPE** (preserving today's client contract) instead of the current generic 502. This is the one behavioral change to specify explicitly (see §4).

### Trust model — the honest part

**Current transport (read `lib/nl2sqlServiceClient.ts`):** plain HTTP (`fetch` to `NL2SQL_SERVICE_URL`, e.g. `http://127.0.0.1:8088`, lines 133/192/318), authenticated by a **shared static Bearer token** `NL2SQL_SERVICE_TOKEN` (line 194/320), constant-time-compared server-side (`auth.py:53`). No TLS, no mTLS, no client-cert. The token is the *only* thing distinguishing the trusted TS caller from any other client that can reach the port.

**What moving the boundary behind the hop means.** Before: even if the network between Next and FastAPI were compromised, a write/DDL statement was rejected in-process in TS before it ever left the Next box. After: the *last* guard before DuckDB lives in the FastAPI process, reachable over the wire. An attacker who can (a) reach the FastAPI port AND (b) present the Bearer token can submit arbitrary SQL directly to `/nl2sql/execute`, and the *only* thing standing between them and a write is (i) the Python `guard_sql` and (ii) the DB read-only role. That is exactly why the plan's layered story matters:

> **Read-only enforcement is layered:** DB read-only role (primary) → Python `guard_sql` (app.py:279) → catalog/schema allowlist (TS, §4) → known-tables allowlist. Decision #2 removes one *duplicate* layer (TS re-guard) that sat upstream of the network hop; it does **not** remove the primary control (DB role) or the guard nearest the executor (Python).

**Does the plan need mTLS / localhost-only / shared-secret hardening?** The shared secret already exists. Given the boundary now sits behind the hop, the network between Next and FastAPI is **in scope for the threat model** and MUST be constrained:

1. **Same-host / private-network only (required).** FastAPI binds private-only; Next is the only public ingress (`PYTHON_NL2SQL_SERVICE_PLAN.md` §6 "Production deploy"). The service port must never be publicly routable. This is the minimum bar and is already the documented topology.
2. **Bearer token stays, rotation documented (required).** `SECRET_ROTATION.md` entry for `NL2SQL_SERVICE_TOKEN`; token-drift → 401 storms is the failure mode.
3. **mTLS (recommended for any cross-host topology).** The moment TS and FastAPI are on different hosts, the static Bearer over plain HTTP is a network-sniffable credential. `PYTHON_NL2SQL_SERVICE_PLAN.md` §7.2 already names mTLS as the documented upgrade path — this plan **elevates it from "documented option" to "required if not co-located"**, precisely because decision #2 pushed the last write-guard across that link.

**Net trust-model finding:** relocating the guard is safe *iff* (a) the DB read-only role is real and verified (SECURITY.md currently notes it UNVERIFIED for Trino; for the DuckDB-attach model the attach is `read_only=True`, `deps.py:115/118`, and `DuckDbEngine` hard-errors on a non-READ_ONLY attach), and (b) the FastAPI port is private-only with the Bearer token, upgrading to mTLS off-host. The primary control was always the DB role; the TS re-guard was defense-in-depth, and the equivalent defense-in-depth layer (Python `guard_sql`) survives — it just now lives one hop further from the client and one step closer to the DB.

---

## 4. Route "After" shapes

### `app/api/query/route.ts` — thin proxy

Order preserved, minus the in-process engine and the TS guard:

```
POST /api/query
  1. requireAuthWithPermission('query:run')      // auth + RBAC          (KEEP, TS)
  2. rateLimit(session,'query')                    // per-user throttle    (KEEP, TS)
  3. enforceBodySize(req)                          // 413                  (KEEP, TS)
  4. parseBody(QueryBodySchema) -> {sql,database,schema,limit}            (KEEP, TS)
  5. resolveAlias/resolveSchema  (ALLOWED_ALIASES/ALLOWED_SCHEMAS)        (KEEP, TS)  <-- coordination allowlist, STAYS
  6. clampLimit(limit)                                                     (KEEP, TS)
  7. executeSqlViaService({ sql, tenantId: session.orgId, context,
        database: alias, schema: targetSchema, maxRows, deadlineMs },
        { correlationId })                          // <-- ONLY executor now
  8. on success: logWithSession(QUERY_RUN, orgId) + anomaly pipeline      (KEEP, TS)
     on Nl2sqlServiceError:
        kind==='guard'         -> 422 SCOPE          // <-- NEW mapping (was TS guard's job)
        else                   -> safeError(502)     // H20
```
Removed: `guardSql` import + block (197–207), `getQueryEngine`/`executeViaTsEngine`, the `queryRuntime()` branch, `KNOWN_ATTACH_ALIASES`/`MOCK_ALIAS` import (inline the two constants), `warnIfRuntimesDiverge`. `serviceFetchForTest` seam stays for hermetic route tests.

**Stays TS-side (compliance/coordination):** org scoping (`session.orgId` as `tenantId`), the catalog/schema **allowlist** (`ALLOWED_ALIASES`/`ALLOWED_SCHEMAS` — an identifier-injection control that is a coordination concern, and the service re-caps as defense-in-depth), rate-limit, body caps, audit, anomaly. **PHI scrub is not on this path** — `/api/query` never row-scrubbed (verified: no `phiScrubber` import); rows flow straight to the client, so nothing to move.

### `app/api/sql-generate/route.ts` — thin proxy

```
POST /api/sql-generate
  0. (drop warnIfRuntimesDiverge)
  1. requireAuthWithPermission('query:run')                              (KEEP, TS)
  2. rateLimit(session,'sql-generate')                                    (KEEP, TS)
  3. enforceBodySize(req)                                                  (KEEP, TS)
  4. parseBody(SqlGenerateBodySchema) -> {userMessage,sourceScope,dialect}(KEEP, TS)
  5. targetDialect = dialectOverride ?? DEFAULT_DIALECT                    // no local engine; constant/param
  6. tenantCacheKey(session,...) -> sqlCache.get  (org-scoped cache)       (KEEP, TS)  <-- coordination cache, STAYS
  7. generateSqlViaService({ question, tenantId, context, dialect,
        sourceScope }, { correlationId })            // <-- ONLY generator now
  8. result.error==='scope' -> 422 SCOPE
     success -> sqlCache.set(...) ; map usage ; NextResponse.json(response)
     Nl2sqlServiceError: scope|generation -> 422 SCOPE ; else -> safeError(502)
```
Removed: `getGenerationDeps`, `getQueryEngine`/`resolvedDialect`, `HybridRetriever`, `createLocalQueryEmbedder`, `generateSql`/`GenerationError`, `createOpenAiLlmClient` (the OpenAI call + egress gate is Python's now), the `runtime==='ts'` branch. Kept: the org-scoped `sqlCache` (a TS coordination concern in front of the service), the response shape, the `usage` passthrough.

**`DEFAULT_DIALECT`:** the deleted `resolvedDialect()` derived the dialect from `NL2SQL_ENGINE`. Since the engine is now Python-only and defaults to `duckdb` (`settings.py:30`), TS can use a constant `'duckdb'` (override still wins), OR read the dialect the service echoes in its response (`result.dialect`). Recommend the latter for the response and a constant only for the cache key.

**Confirmation of the brief's question:** scoping (`orgId`), the catalog/schema allowlist, and the org-scoped cache **stay TS-side** — they are coordination/compliance, not query logic. PHI scrub is not on either of these two routes.

---

## 5. Flag removal

`lib/nl2sqlRuntime.ts` exists to select `'ts' | 'python'` per endpoint and warn on divergence. With `'ts'` deleted, there is exactly one runtime.

**Recommendation: delete `lib/nl2sqlRuntime.ts` entirely** (not keep a vestigial always-python). Rationale: `umbrellaRuntime`/`generateRuntime`/`queryRuntime` all collapse to the constant `'python'`; `warnIfRuntimesDiverge` guards a divergence that can no longer occur; the whole module (and its test `tests/unit/nl2sqlRuntime.test.ts`) becomes dead weight. Remove:
- the imports in `query/route.ts:12` and `sql-generate/route.ts:23`,
- the `queryRuntime()`/`generateRuntime()` branches (already removed by the §4 rewrites),
- the `warnIfRuntimesDiverge()` calls at the top of each handler,
- `NL2SQL_RUNTIME` / `NL2SQL_GENERATE_RUNTIME` / `NL2SQL_QUERY_RUNTIME` from `.env.example` / docs (they no longer do anything).

Keep `NL2SQL_SERVICE_URL` / `NL2SQL_SERVICE_TOKEN` / `NL2SQL_SERVICE_TIMEOUT_MS` — those are the live coordination config.

Operational consequence (must be documented in the cutover PR): once the flag is gone, an **unreachable FastAPI service is a hard outage** for `/api/query` and `/api/sql-generate` — there is no in-process fallback. This is the accepted forfeit of decision #1. `/readyz` gating (Next routes flag-on traffic only when `nl2sql` is ready) becomes a *deploy-ordering requirement*, not a nicety.

---

## 6. Test impact

### Delete (test the deleted TS runtime; Python has the equivalent)
- `lib/rag/__tests__/generate.test.ts`, `promptAssembly.test.ts`, `thinSlice.test.ts` — covered by `ceiba_nl2sql/tests/test_generate_pipeline.py`, `test_prompt.py`, `test_retriever.py`, `test_cardinality_guard.py`, `test_duckdb_engine.py`.
- `lib/__tests__/sqlGenerateClient.test.ts` — **only if** `sqlGenerateClient.ts` is deleted (see Open Q). If kept, this test stays.
- `tests/unit/nl2sqlRuntime.test.ts` — the flag is gone (§5).
- eval TS suite (`eval/*`) — retired in favor of Python eval (`PYTHON_NL2SQL_SERVICE_PLAN.md` Phase 5); out of this task's minimal scope but its imports break, so it must be deleted or ported here.

### Rewrite (route tests now assert PROXY behavior)
- `app/api/query/__tests__/route.test.ts` — drop `DuckDbEngine`/`QueryEngine`/`provisioning` imports (27–29) and `__setQueryEngineForTest`. Rewrite around the `serviceFetchForTest` seam: assert (a) auth/rate-limit/body/validate still gate, (b) alias/schema allowlist still resolves, (c) the exact `/nl2sql/execute` request body shape, (d) **`kind:"guard"` → 422 SCOPE** (the relocated boundary's contract), (e) audit `QUERY_RUN` still fires with `orgId`, (f) `unavailable` → 502.
- `app/api/sql-generate/__tests__/route.test.ts` — drop engine/retriever/generate imports (19–23). Rewrite around `serviceFetchForTest`: auth gating, org-scoped cache hit/set, `error:'scope'` → 422, `usage` passthrough, error-envelope mapping.

### Grow (Python must now cover what TS tested)
- **Guard boundary:** `tests/unit/sqlGuard.test.ts` (the B1 corpus — comment-stripping, multi-statement, MERGE/CALL, filesystem functions) must have full parity in `ceiba_nl2sql/tests/test_sqlguard.py`. The cross-runtime parity harness (`tests/unit/sqlGuardParity.test.ts` ⇄ `ceiba_nl2sql/tests/test_sqlguard_parity.py`, shared corpus under `tests/fixtures/`) currently asserts "Python ≥ TS strict". **After deleting the TS guard, the parity test loses its TS half** — convert it to a Python-only assertion that the *whole shared corpus* is classified as expected (the corpus stays; the TS reader goes). This is the single most important test to grow, since Python `guard_sql` is now the sole application-level guard.
- **Execute-guard integration:** `ceiba_nl2sql_service/tests/test_execute.py` must assert that `/nl2sql/execute` rejects a write/DDL/filesystem statement with `kind:"guard"` (the boundary is now here). Verify this case exists; add if missing.
- **Cross-db / native routing:** whatever the deleted TS thinSlice/hermetic cross-source test covered must be covered by `ceiba_nl2sql/tests/test_routing.py` + `test_duckdb_engine.py`.

---

## 7. Sequencing (green at each step, each independently committable)

The ordering keeps `tsc`/build green after every commit by rehoming types and relocating the guard-consumption *before* deleting the modules that provide them.

1. **Rehome types (no deletion yet).** Add `SqlDialect` to a retained module (recommend `lib/nl2sqlServiceClient.ts` or new `lib/nl2sqlTypes.ts`); repoint `nl2sqlServiceClient.ts:39`, `sql-generate/route.ts:8`, `sqlGenerateClient.ts:26`. Inline `MOCK_ALIAS`/`KNOWN_ATTACH_ALIASES` constants into `query/route.ts` (or `lib/attachAliases.ts`). Build green — nothing deleted, types just have a second home. *Commit.*
2. **Verify Python execute guards (no TS change).** Confirm/tighten `ceiba_nl2sql_service/tests/test_execute.py` asserts `guard_sql` rejects write/DDL/filesystem at `/nl2sql/execute` (app.py:279). Confirm `ceiba_nl2sql/tests/test_sqlguard.py` covers the full B1 corpus. *Commit (Python-only).* — this is the safety precondition for decision #2.
3. **Rewrite `query/route.ts` to always-python proxy** (§4): remove `guardSql` + guard block, remove `getQueryEngine`/`executeViaTsEngine` + `queryRuntime` branch, map `kind:"guard"` → 422 SCOPE. Rewrite `query` route test around the fetch seam. Build + tests green. *Commit.* — the TS re-guard is now gone from the live path but `lib/sqlGuard.ts` still exists (unimported).
4. **Rewrite `sql-generate/route.ts` to always-python proxy** (§4): remove `getGenerationDeps`/`generateSql`/retriever/embedder/OpenAI client + `generateRuntime` branch; keep the org cache. Rewrite `sql-generate` route test. Build + tests green. *Commit.* — both live routes are now pure proxies; `lib/engine/*` and `lib/rag/*` are unimported by production code.
5. **Delete the guard.** Remove `lib/sqlGuard.ts` + `tests/unit/sqlGuard.test.ts`; convert `sqlGuardParity` to Python-only (§6). Build + tests green. *Commit.*
6. **Delete `lib/engine/*`.** Now unimported (index.ts had zero importers; provisioning/QueryEngine/DuckDb/Trino only referenced by already-rewritten routes and deleted-together modules). Build green. *Commit.*
7. **Delete `lib/rag/*` + `lib/trinoClient.ts`.** All internal cross-imports resolve within the deletion; the only outside consumers (`sql-generate/route.ts`) were rewritten in step 4. Delete their `lib/rag/__tests__/*`. Build green. *Commit.*
8. **Remove the flag.** Delete `lib/nl2sqlRuntime.ts` + its test; strip `warnIfRuntimesDiverge` calls (already removed in the rewrites); prune `NL2SQL_*_RUNTIME` from `.env.example`/docs. Build + tests green. *Commit.*
9. **Drop dependencies + eval.** Remove `@duckdb/node-api`, `@huggingface/transformers` from `package.json` (after confirming no other importer); delete/port the TS `eval/*`. Build + tests green. *Commit.*

Each step compiles because the type/const rehoming (step 1) and the route rewrites (steps 3–4) precede the module deletions (steps 5–7), and the guard's Python coverage (step 2) precedes the TS guard's removal (steps 3, 5).

---

## 8. Risks

1. **PHI egress — nothing orphaned on the query path.** `/api/query` never row-scrubbed (verified: no `phiScrubber` import; its "H20 scrub" comment refers to *error* scrubbing via `safeError`, not row PHI). The **generation** egress gate (`OPENAI_BAA_SIGNED`, deleted with `lib/rag/generate.ts`'s `callLlm`→`assertEgressAllowed`) is **already faithfully ported** to `ceiba_nl2sql/compliance/egress.py` (same env var, same exact `== "true"`, fail-closed) and enforced in the Python pipeline (app.py catches `EgressBlockedError`, line 197). `lib/phiScrubber.ts` **stays** for the narrative/chat/chart-suggest routes (not in this refactor). **Migration hazard (§7.4 of the base plan):** `OPENAI_BAA_SIGNED` must be set in the *service* env now, not the Next env — a deploy that sets it only on Next mis-gates open/closed. Single authoritative location = the service.
2. **Cross-process security boundary** — the guard's last line before DuckDB is now behind the network hop. Mitigations in [§3](#3-guard-relocation--trust-model): DB read-only role (primary), private-only FastAPI port, Bearer token, mTLS required off-host. This is the central trade of decision #2.
3. **Embedding parity — improves.** The TS `queryEmbedder.ts` (transformers.js) reproduced the embedding recipe a second time; deleting it removes the fp32-vs-int8 parity risk. Is TS query embedding on the request path today? **No** — `sql-generate/route.ts:196` used `createLocalQueryEmbedder()` only inside `getGenerationDeps` on the *TS* runtime path, which is being deleted. On the python path the service embeds with the *same* `FastEmbedEmbedder` that built the bundle (`deps.py:77`). Deleting the TS embedder is pure upside.
4. **No in-process fallback** — decision #1 forfeits the env-flip rollback; an unreachable service is a hard outage. Deploy ordering (`/readyz` gate) becomes mandatory, not optional.
5. **Guard behavioral contract change** — a write/DDL statement now returns the service's `kind:"guard"` which the route maps to **422 SCOPE**. Previously the TS guard produced 422 SCOPE directly. Same client-visible status, but the rejection now costs one network round-trip and is logged in *two* places (TS `QUERY_FAILED` on the mapped error + the service's own log). Ensure the TS route still writes the `QUERY_FAILED` audit line on a `kind:"guard"` mapping so the audit chain doesn't lose guard rejections.
6. **TS-only behaviors to preserve** — the audit **hash-chain** and **anomaly detector** are TS-only and must remain on the post-execute path (they already are; the §4 rewrite keeps step 8 verbatim). The org-scoped **cache** and **rate-limiter** are per-Next-instance and stay TS.

---

## Open Questions

1. **`lib/sqlGenerateClient.ts` — delete or keep?** The user's directive lists it for deletion, but it is a *pure, framework-free client-side response parser* (`interpretSqlGenerateResponse`) with **no** query/DB/LLM logic — it only classifies an HTTP status + parsed JSON into success/scope/error for the UI (`app/data-explorer/page.tsx:11`). It is coordination, not runtime. **Recommendation: KEEP it** (re-classify as coordination), or, if it must go, inline `interpretSqlGenerateResponse` into `page.tsx`. Deleting it without a replacement breaks the data-explorer UI. Which do you want?
2. **`SqlDialect` home** — put it on `lib/nl2sqlServiceClient.ts` (fewest new files) or a dedicated `lib/nl2sqlTypes.ts` (cleaner separation)? Recommend the service client.
3. **mTLS timing** — is the FastAPI service co-located with Next in *all* target environments (prod + any staging)? If any environment runs them cross-host, mTLS should land *with* this change, not after, because decision #2 puts the last write-guard across that link (§3).
4. **DB read-only role verification** — `SECURITY.md` notes the Trino read-only role UNVERIFIED. For the DuckDB-attach model the attach is `read_only=True` and `DuckDbEngine` hard-errors on non-READ_ONLY. Since decision #2 makes the DB role the sole primary control, confirm the *staging Postgres* connection uses a genuinely read-only role (`ceiba_ro`) so a guard bypass is provably harmless.

---

**Doc path:** `docs/TS_RUNTIME_RETIREMENT_PLAN.md`
