# Test Strategy — Ceiba Data & AI Explorer

Status: **Phase 0 scaffold.** This document replaces `scripts/qa-agent.mjs` (a live-server
smoke script with a tautological "no API key" assertion — see
`PRODUCTION_READINESS_REPORT.md` §Medium) as the project's real test suite plan.

This strategy is written *during* the Clerk→local-RBAC and Stripe-removal rewrite
(`remediation/phase-0-foundation`). It deliberately does not test `lib/apiAuth.ts`,
`lib/cache.ts`, `lib/rateLimiter.ts`, `lib/trinoClient.ts`, or `app/api/**`, which other
agents are actively rewriting. Those tests are specified here (so the next pass can write
them against a stable contract) but are marked **BLOCKED** — see §7.

---

## 1. Framework choice: Vitest (not Jest)

**Recommendation: Vitest** for unit/integration, **Playwright** for e2e.

| Criterion | Vitest | Jest |
|---|---|---|
| ESM / Next 15 / TS 5.9 | Native ESM, no transform config needed | Needs `ts-jest`/`babel-jest` + `moduleNameMapper` hacks for ESM-only deps (e.g. some `@clerk`/`otplib`/future ESM-only libs) |
| Speed | Vite-native, esbuild transform, watch mode is near-instant | Slower cold start; Babel/ts-jest transform overhead |
| Config surface | Single `vitest.config.ts`, reuses `tsconfig.json` `paths` via `vite-tsconfig-paths` or manual `resolve.alias` | Separate `moduleNameMapper` duplicating `tsconfig.json` paths |
| API compatibility | Jest-compatible `describe/it/expect/vi.fn()` — near drop-in | n/a |
| Next.js 15 fit | Vitest is what Next's own docs/examples point to for App Router unit testing since Jest's Next SWC transform lagged behind Turbopack/RSC changes | Requires `next/jest` preset; historically slower to track new Next major versions |
| Coverage | Built-in `v8` provider, fast | `istanbul`/`babel-plugin-istanbul`, slower |
| Ecosystem for this repo | `zod` (to be added), plain TS modules, no heavy Jest-only mocking idioms in use | No advantage — nothing here depends on Jest-specific features |

Given the codebase is plain TS/ESM with no existing Jest investment, Vitest is the lower-friction,
faster-feedback choice. `oxlint` is already the linter (not ESLint), so there's no
`eslint-plugin-jest`-style lock-in either way — a fully clean pick.

**E2E: Playwright.** Already the tool used by the `playwright-skill` in this environment;
it drives real browser flows (login → RBAC-gated pages → dashboards) against a running
`next start`/`next dev` instance, and is the de facto standard for Next.js App Router e2e.

---

## 2. Test pyramid / layer split

```
        ┌───────────────────────────┐
        │   E2E (Playwright)        │  few, slow, high-value flows
        │   login, RBAC page gating,│
        │   cross-tenant UI checks  │
        ├───────────────────────────┤
        │  Integration (Vitest)     │  API routes w/ injected fakes
        │  requireAuthWithPermission│  for Trino/OpenAI; real Next
        │  route handlers, zod 400s │  request/response objects
        ├───────────────────────────┤
        │   Unit (Vitest)           │  many, fast, pure functions
        │  phiScrubber, permissions,│
        │  SQL guard, cache keying, │
        │  zod schemas              │
        └───────────────────────────┘
```

- **Unit** — pure functions / modules with no I/O: `lib/permissions.ts`, `lib/phiScrubber.ts`,
  the future SQL-statement classifier, zod schemas, `lib/cache.ts` key-derivation function
  (not the singleton cache instances). Target: majority of the suite, run on every save.
- **Integration** — Next route handlers (`app/api/**/route.ts`) invoked directly as functions
  (Next 15 route handlers are plain async functions — `POST(req: NextRequest)` — so they can
  be unit/integration-tested by constructing a `NextRequest` and calling the export directly,
  no server needed) with Trino/OpenAI replaced by injected fakes (§3) and a real or in-memory
  session/org store.
- **E2E** — a handful of Playwright specs against a real `next dev`/`next start` server with a
  seeded local RBAC test database/fixture: login as each role, confirm page/route gating,
  confirm org A cannot see org B's dashboard via the UI.

---

## 3. Mocking Trino / OpenAI at the boundary

The report's remediation plan wraps external calls behind small client modules
(`lib/trinoClient.ts`, and an OpenAI client to be extracted from the AI routes). The testing
contract this strategy assumes/requests from that rewrite:

- **Trino**: `executeTrinoQuery(sql, catalog, schema, limit)` should remain a single exported
  function (already true today) so tests can `vi.mock('@/lib/trinoClient')` and supply
  canned `{ columns, rows, rowCount }` fixtures, or reject to exercise error-envelope paths —
  without a network call. For integration tests of route handlers, prefer **dependency
  injection over module mocking** where the rewrite allows it (e.g. an optional injected
  client param defaulting to the real client) since `vi.mock` on ESM can be brittle across
  Vitest versions; module mocking remains the fallback where DI isn't practical.
- **OpenAI**: whatever client wrapper replaces the raw `fetch('https://api.openai.com/...')`
  calls in `sql-generate`/`chart-suggest`/`narrative`/`chat` should be similarly isolated
  behind one module (e.g. `lib/openaiClient.ts`) exporting a single call function, so it can
  be mocked the same way. Tests never hit `api.openai.com`.
- **No network in unit/integration tests, ever.** CI enforces this implicitly by never
  injecting `OPENAI_API_KEY`/Trino credentials into the test job (see §6) — any code path
  that isn't properly mocked will fail loudly with a connection error rather than silently
  hitting production.

This is why `lib/trinoClient.ts` and the AI-route files are out of scope for this pass: the
mock seams need to exist first. Once they land, integration tests plug into them directly.

---

## 4. Test data strategy — synthetic PHI fixtures only

- **Never use real patient data, real names, or real national ID numbers in any fixture,
  test, or snapshot** — including ones that "look fake" but are structurally valid (e.g. a
  real-format but invented Turkish ID must still pass the Luhn-like shape checks used by
  `TURKISH_ID_PATTERN`; use clearly-invalid-checksum or obviously-fake values where the code
  only checks digit-shape, and comment why).
  the PHI-scrubbing test currently uses `1234567890` shapes that are structurally valid per
  the current regex (11 digits, non-zero first digit) but are canonical placeholder values,
  never traceable to a real person.
- Central fixture module: `tests/fixtures/syntheticRows.ts` (to be created as the suite
  grows) exporting typed builders — `buildPatientRow(overrides)`, `buildOrgAUser()`,
  `buildOrgBUser()` — so every test constructs data through one reviewed seam instead of
  copy-pasted literals scattered across files. The example test added in this pass
  (`tests/unit/phiScrubber.test.ts`) inlines its 2-3 rows directly since the fixture module
  doesn't exist yet; migrate it to the shared builder once cross-tenant/RBAC tests need the
  same shapes.
- Fixtures live under `tests/fixtures/` and are plain `.ts` (not `.json`) so they're
  type-checked against the real row/column types.
- A `.gitleaks.toml` / pre-commit-style sanity check: fixture files should never contain a
  string matching the real Turkish ID checksum algorithm for a plausible real identity, or
  any value copied from `COMPLIANCE_REPORT.md`'s burned examples — synthetic only, generated
  values only.

---

## 5. Coverage targets

Enforced via `vitest.config.ts` `coverage.thresholds`, scoped **per security-critical file**
(global blanket thresholds hide a 0%-covered critical file behind well-tested UI code), plus
one modest global floor so the suite can't regress wholesale:

| Module | Target (lines/branches) | Rationale |
|---|---|---|
| `lib/permissions.ts` | 100% | Small, pure, security-critical — every role×permission pair must be asserted |
| `lib/phiScrubber.ts` | ≥90% lines, 100% of the branch set enumerated in §7 test list | PHI leakage is a HIPAA-grade defect (H15) |
| Future SQL statement classifier | 100% branches | Bypass = data destruction (B1) |
| Future local-auth session/permission guard | ≥95% | Auth bypass = full compromise |
| Future zod schemas + validation middleware | ≥90% | Input validation is the trust boundary (N5) |
| Global (repo-wide) | ≥60% lines as a floor, ratcheted up per phase | Prevents net-negative coverage drift without demanding 100% on UI/presentational code on day one |

CI fails the build if any named module drops under its threshold. Global floor is
intentionally modest at Phase 0 since most of the codebase (React components, stores) has no
tests yet — it should be raised in each subsequent remediation phase, not gamed by excluding
files from coverage.

---

## 6. CI job outline

New workflow `.github/workflows/test.yml` (additive — does not touch the existing
`secret-scan.yml`):

```yaml
name: Test

on:
  push:
    branches: ["**"]
  pull_request:
    branches: ["**"]

permissions:
  contents: read

jobs:
  unit-integration:
    name: Unit + integration tests (Vitest)
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: "20.19.0"
          cache: "npm"
      - run: npm ci
      # Deliberately NO secrets/env injected here — OPENAI_API_KEY, Trino creds, DB URL are
      # all absent so any test that accidentally reaches a real client fails loudly instead
      # of hitting production.
      - name: Run tests with coverage
        run: npm run test:coverage
      - name: Upload coverage report
        if: always()
        uses: actions/upload-artifact@v4
        with:
          name: coverage-report
          path: coverage/
          retention-days: 14

  e2e:
    name: E2E tests (Playwright)
    runs-on: ubuntu-latest
    needs: unit-integration
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: "20.19.0"
          cache: "npm"
      - run: npm ci
      - run: npx playwright install --with-deps chromium
      - name: Build app
        run: npm run build
        env:
          # Point at seeded local-RBAC test fixtures / in-memory store only — never a real
          # Trino/OpenAI endpoint in CI.
          NODE_ENV: test
      - run: npm run test:e2e
      - name: Upload Playwright report
        if: always()
        uses: actions/upload-artifact@v4
        with:
          name: playwright-report
          path: playwright-report/
          retention-days: 14
```

Both jobs are required status checks on the branch protection rule for `main` once the
local-RBAC rewrite lands and the first real integration tests exist. `unit-integration` can
be made a required check immediately (it's green today with just the example tests).

---

## 7. Mapping the 5 security-critical behaviors to test layers

### 7.1 Local RBAC — login, session validation, role→permission mapping, denial paths, org/owner scoping

- **Unit (ready now, not blocked):** `lib/permissions.ts` — `hasPermission`/`requirePermission`
  for every `(role, permission)` pair, including the negative space (e.g. `clinician` +
  `admin:manage` → false, `analyst` + `audit:read` → false). **Scaffolded in this pass** —
  see `tests/unit/permissions.test.ts`.
- **Unit — BLOCKED:** session creation/validation, password hashing/verification, and the
  role→permission wiring inside the new local auth module do not exist yet. Once
  `getSession`/`requireAuth`/`requireAuthWithPermission` land (replacing `lib/apiAuth.ts`),
  add: valid session → 200 path; missing/expired/tampered session → 401; valid session +
  insufficient permission → 403 with no data leaked in the error body; hashed-credential
  verification against known bcrypt vectors (correct password / wrong password / malformed
  hash).
- **Integration — BLOCKED:** call each `app/api/**/route.ts` handler directly with a
  constructed `NextRequest` carrying a fake session cookie/header for org A user, org B user,
  and no user; assert dashboards/charts/audit reads and writes are scoped — org A cannot
  `GET`/`PATCH`/`DELETE` org B's dashboard by ID even when guessing/enumerating IDs (IDOR per
  B2/H1/H2). This requires the local org/owner data model to exist first.
- **E2E — BLOCKED:** Playwright login as two seeded users in two different orgs; confirm org
  B's dashboard is not reachable/visible from org A's session (both via UI navigation and by
  hitting the URL directly), and that a `clinician` cannot see admin-only nav/routes
  (`audit:read`, `admin:manage`).

### 7.2 PHI scrubbing correctness (`lib/phiScrubber.ts`)

- **Unit (ready now, not blocked):** **Scaffolded in this pass** — see
  `tests/unit/phiScrubber.test.ts`, covering current, as-shipped behavior:
  - Known PHI columns (`patientId`, `ssn`, `dob`, `name`, etc., including the extended set
    and case/separator normalization via `isPhiColumn`'s `.toLowerCase().replace(/[-\s]/g,'_')`)
    are replaced with the documented tokens (`PT-XXXXXXXX`, `[SSN REDACTED]`, `Patient-A`, …).
  - Same `patientId`/name value scrubbed twice within one `scrubPHI` call yields the *same*
    stable token (tokenMap reuse).
  - Turkish National ID pattern is caught **even in columns not in the PHI allowlist**
    (the documented "second pass" behavior) — both string and number-typed values.
  - `null`/`undefined` PHI values → `[REDACTED]`.
  - Non-PHI columns pass through unchanged.
  - `scrubReport` counts (`rowsProcessed`, `phiValuesReplaced`, `columnsScrubed`) are correct.
- **Unit — documents a known gap, does not "pass" it silently (H15):** add a test explicitly
  named to fail-loud once free-text scrubbing is implemented, e.g.
  `it.todo('scrubs embedded PHI inside free-text columns like ClinicalNotes.Summary — H15, not yet implemented')`,
  or an inverse assertion (`expect(scrubbed.clinicalNotes).toContain(fakePatientName)`) with a
  comment pointing at H15/B5 so the test suite is honest about the gap rather than implying
  free-text is safe. **Scaffolded in this pass** as an `it.todo`/documented gap, not a full
  implementation (the fix itself — "send schema+aggregates only, never row-level PHI to any
  LLM" per the report — is an application-level architecture change, not a `phiScrubber` bug
  fix, and is out of scope for this pass).
- **Unit — BLOCKED on H21 fix:** concurrency-race regression test. Current implementation
  resets a **module-global** `_letterIndex` at the top of every `scrubPHI` call
  (`lib/phiScrubber.ts:147`), so two logically-concurrent invocations interleaved on the
  same event-loop tick (e.g. via `Promise.all([scrubPHI(a), scrubPHI(b)])` where each scrubs
  many rows) can produce aliased/non-deterministic `Patient-X` tokens across the two
  results. Because `scrubPHI` itself is synchronous with no `await` inside its row loop, this
  specific race is actually hard to trigger with real concurrency in a single-threaded test
  runner (`Promise.all` won't interleave synchronous work) — the meaningful regression test
  is: **call `scrubPHI` twice in sequence and assert the second call's tokens start from `A`
  again**, i.e. that `_letterIndex`/token generation is call-scoped, not module-scoped, once
  H21 lands. Today (module-global counter), calling `scrubPHI` twice in a row with names in
  both *does* correctly reset (`_letterIndex = 0` runs at the top of each call) — the real bug
  is concurrent *overlapping* calls under real async I/O (e.g. if scrubbing is ever made
  concurrent with awaited work in between rows). Write this test once the fix makes the
  counter a true local variable returned via closure/class instance rather than module state,
  so the test can assert two overlapping in-flight calls (via real `await` interleaving, e.g.
  wrapping row processing with a microtask yield in a test double) don't cross-contaminate.

### 7.3 SQL safety — parser-based guard (replacing first-token guard, B1/H25)

- **Unit — BLOCKED (module doesn't exist yet):** once the parser-based classifier lands
  (replacing `app/api/query/route.ts`'s `firstWord` check), test as a pure function
  independent of the route handler:
  - Comment-prefix bypass: `/* */ DELETE FROM eclinics."Shared"."Patients"` → rejected (the
    exact B1 repro).
  - Leading whitespace/newlines/multiple comment styles (`--`, `/* */`, nested) before a
    write statement → rejected.
  - `MERGE`, `CALL`, `EXECUTE`, and any other non-`SELECT` top-level statement type → rejected
    (current blocklist omits these entirely per B1).
  - Multi-statement input (`SELECT 1; DROP TABLE x`) → rejected as a whole, not partially
    executed.
  - CTEs / subqueries that are read-only (`WITH x AS (SELECT ...) SELECT * FROM x`) → allowed
    (negative-space check so the guard isn't so strict it breaks legitimate analyst queries).
  - A CTE or subquery that *contains* a write inside it → rejected (parser must inspect the
    full statement tree, not just the outer keyword).
- **Integration — BLOCKED:** once wired into `/api/query`, assert the route returns
  403/generic error envelope (not the raw Trino/parser internals — ties to H20) for each
  rejected case above, with `executeTrinoQuery` mocked so the test proves the guard runs
  *before* any Trino call is attempted (assert the mock was never invoked on rejection).

### 7.4 Input validation (zod) on API routes → 400, not 500 (N5)

- **Unit (ready now in principle, but no zod schemas exist yet — BLOCKED):** once schemas are
  added (e.g. `lib/schemas/query.ts` exporting a `QueryRequestSchema`), test each schema in
  isolation: missing required field, wrong type, extra/unexpected field (per `.strict()` if
  used), boundary values (e.g. `limit` must clamp/reject per H22, `schema` must be
  enum-validated per H22).
- **Integration — BLOCKED:** for each route in `app/api/**` (`query`, `chat`, `chart-suggest`,
  `sql-generate`, `narrative`, `dashboards`, `audit`), send a non-JSON body, an empty body,
  and a body missing required fields; assert **400 with a validation error envelope**, never
  a 500/unhandled-exception, and never a stack trace or internal error string in the body
  (ties to H20's generic-error-envelope requirement). This is the direct regression test for
  N5's specific repro (`app/api/chart-suggest/route.ts:47-50` calling `columns.map(...)`
  before its try block).

### 7.5 Cache key tenant-scoping (N4) and error-envelope consistency

- **Unit — BLOCKED on cache rewrite:** once `lib/cache.ts`'s `hashKey` is replaced with a
  tenant-prefixed SHA-256 key per the report's fix, test: `hashKey(orgA, 'same message')` !=
  `hashKey(orgB, 'same message')` for identical non-tenant inputs (the exact N4 repro — today
  this assertion **fails** on purpose against current code, which is why it's blocked rather
  than written as a currently-passing test); same-tenant same-input → same key (cache hits
  still work); key does not use the reversible/collidable djb2 algorithm (assert output
  length/format matches SHA-256 hex, as a proxy for "not djb2").
- **Integration — BLOCKED:** two requests with identical NL input from two different
  authenticated orgs against a mocked LLM client that returns different canned responses per
  call — assert org B gets a fresh LLM call (or its own cache entry), never org A's cached,
  PHI-derived result.
- **Error-envelope consistency — BLOCKED (cross-cutting, depends on H20 fix landing across
  routes):** a shared contract test/table asserting every API route returns the same shape
  `{ error: string, correlationId?: string }` on failure, with **no** `String(e)` of a raw
  driver/SDK error ever reaching the response body (regression test for H20 — grep-style
  static check plus a runtime assertion per mocked-failure-injection per route).

---

## 8. Directory layout (scaffolded this pass)

```
tests/
  unit/
    permissions.test.ts       # scaffolded, passing
    phiScrubber.test.ts       # scaffolded, passing (+ 1 it.todo for H15 gap)
  fixtures/                   # (not yet populated — see §4; add as blocked tests unblock)
  integration/                # (empty — populated once app/api rewrite lands)
  e2e/                        # (empty — populated once local RBAC + seeded test users exist)
vitest.config.ts
playwright.config.ts          # (added as config scaffold; no specs yet — see note in §9)
```

---

## 9. What this pass deliberately does NOT do

- Does not add tests for `lib/apiAuth.ts`, `lib/cache.ts`, `lib/rateLimiter.ts`,
  `lib/trinoClient.ts`, or anything under `app/api/**` — these are mid-rewrite by other
  agents and any test written against current behavior would need to be rewritten (or would
  actively assert the *wrong*, soon-to-be-fixed behavior, e.g. asserting the old djb2 cache
  key format).
- Does not modify `lib/phiScrubber.ts` itself — tests are written against its **current**
  behavior plus one explicit `it.todo` documenting the known H15 gap.
- Does not add Playwright specs yet (no seeded local-auth test users/pages to drive). The
  config is scaffolded so the CI job in §6 has something to run once specs land; delete/adapt
  the CI `e2e` job's assumptions if Playwright is deferred further.
- Does not attempt 100% global coverage — see §5's rationale.
