# Ceiba Data AI Explorer — Production-Readiness Assessment

> Multi-agent audit, 2026-07-08. 6 specialist reviewers across security, data
> persistence/multi-tenancy, auth & billing, HIPAA claims-vs-reality, build/ops,
> and AI-SQL integrity. Every finding was adversarially re-verified against the
> code before inclusion: **47 findings confirmed, 0 false alarms**.
>
> **Addendum, 2026-07-08 (second pass).** A follow-up 4-reviewer team (frontend/UX
> correctness, dependency/supply-chain, API contract/resilience, and a meta-review
> that re-verified this report's own claims) added findings the first pass
> under-covered. The meta-review confirmed **every B/H claim below against the cited
> code with zero false alarms or overstatements**. New findings are marked **[A]**
> throughout and collected in §3a, §4a, §6a, §8 (report corrections), and folded into
> §7. Net: **~50 additional findings, 5 new production blockers (N1–N5).** The
> NO-GO / grade-F verdict is unchanged and reinforced.

> **Scope change, 2026-07-09 (remediation).** Product direction: **Clerk and Stripe are
> removed for now** and deferred to a later milestone. Auth is replaced with a **local
> RBAC system** (session + hashed credentials + the existing role/permission map);
> **billing, licensing, and subscription/suspension are removed entirely.** Consequently
> the following findings are **descoped / obsolete** and retained only for history:
> **B8, H13, H18, L4** (all billing/license), the licensing half of **B5's BAA gating**
> stays (OpenAI egress is independent of billing), and the *tenant* framing of **B2/N4**
> is narrowed to **per-user owner scoping** (single local user store, no multi-tenant
> Clerk Orgs). The **data-residency (N1)** and **PHI-egress (B5/H15)** blockers are
> unaffected. See §7 for the revised plan.

## 1. Verdict

**NO-GO for production with real patient data. Overall readiness grade: F.**

This application cannot lawfully or safely handle PHI in its current state. It also
cannot be built from a clean checkout (`npm ci` fails), so it is not deployable via
standard CI/CD regardless of the compliance issues.

## 2. Executive Summary

Marketed as a HIPAA-compliant, multi-tenant clinical data explorer with encryption
at rest, tamper-evident audit logging, MFA, PHI scrubbing before AI calls, and breach
detection. In reality it is an early-stage single-instance prototype whose core safety
and compliance controls are either bypassable, non-functional, or entirely absent.
There is **no multi-tenant isolation anywhere** — any authenticated clinician can read,
overwrite, and delete every other tenant's dashboards and charts (which cache raw
patient rows), and read the org-wide audit log. The headline "PHI scrubbed before every
OpenAI call" is false: at least one AI route ships raw patient rows to OpenAI, and
OpenAI has **no signed BAA** (per `SECURITY.md`). Server-side persistence — including the
HIPAA audit trail — is written to an ephemeral, often read-only serverless filesystem
where writes are silently swallowed, so on the documented Vercel target the audit trail
can produce zero records while the app reports success. Several documented "applied
fixes" (encryption at rest, PHI scrubbing, MFA, tamper-evidence, 90-day retention, breach
alerting) do not hold up in code and amount to compliance theater. Even the flagship
NL→SQL feature is broken end-to-end through the shipped UI.

## 3. Blockers — must be fixed before ANY production use

**B1. SQL write/DDL guard is trivially bypassable; clinical PHI catalogs exposed to modification/destruction.**
`app/api/query/route.ts:29-35` inspects only the first whitespace token of the SQL
(`firstWord = normalized.split(/\s+/)[0]`). A leading comment (`/* */ DELETE FROM
eclinics."Shared"."Patients"`) makes `firstWord` `/*` and passes; `MERGE`/`CALL`/`EXECUTE`
are not in the blocklist at all. Raw SQL is then forwarded verbatim to Trino. DB-side
read-only enforcement is listed as unverified in `SECURITY.md:33-34`, so this broken guard
is the *primary* control.
**Impact:** If the Trino `readonly` principal is not truly restricted at the cluster, any
authenticated user (default `clinician`) can corrupt or destroy patient records — a
patient-safety and integrity catastrophe.
**Fix:** Enforce SELECT-only at the Trino side with a real read-only role and confirm the
connector rejects writes. In-app, classify statements with a real parser or `EXPLAIN`,
strip comments before analysis, reject multiple statements and any non-QUERY top-level
type. Treat the app guard as defense-in-depth only.

**B2. No per-user/tenant isolation on dashboards/charts — cross-tenant PHI breach + destructive IDOR.**
`app/api/dashboards/route.ts:32-95` GET returns the entire file; POST upserts by `id`
alone; DELETE filters by `id` alone. `requireAuth` only checks that *a* Clerk user exists —
it never scopes by user/tenant. The `owner` field on `Dashboard` (`lib/store.ts:20`) is
never read or written. Charts embed raw query result rows (`SavedChart.data`, `lib/store.ts:8`).
**Impact:** Any authenticated clinician can enumerate and read every other hospital's
dashboards/charts including embedded patient data, and overwrite or delete any of them by
id. A reportable HIPAA breach.
**Fix:** Derive tenant from the Clerk session server-side, persist an owner/tenant key on
every record, filter all reads by it, reject writes/deletes where stored owner ≠ caller.
Move to row-level tenant scoping in a real DB.

**B3. All server-side persistence lives on the ephemeral/serverless filesystem — PHI, licenses, and the HIPAA audit log are lost on redeploy and diverge across instances.**
Audit log (`lib/auditLog.ts:62-63`), dashboards/charts (`app/api/dashboards/route.ts:6-8`),
and licenses (`lib/licenseStore.ts:34-35`) all write under `process.cwd()`. There is no
shared/durable store.
**Impact:** Audit trail destroyed on every deploy (violates §164.312(b) audit controls /
6-year retention and breaks the hash chain); licenses vanish; dashboards diverge per
instance; multi-instance reads are nondeterministic.
**Fix:** Move all durable state to a managed shared store (Postgres, versioned object
storage, dedicated append-only audit sink). Treat the container FS as disposable.

**B4. Audit-log writes are silently swallowed and target a read-only path on the stated Vercel/serverless target.**
`lib/auditLog.ts:140-161` wraps the whole write in a try/catch whose only failure action is
`console.error` (line 160); callers don't check the result. On Vercel the app root is
read-only, so `mkdirSync`/`appendFileSync` throw EROFS and the event is dropped.
Verification integrity checks also treat a missing/empty file as "valid."
**Impact:** In production the tamper-evident PHI-access audit trail can produce zero records
while the app reports success — a required compliance control defeated invisibly.
**Fix:** Write to a durable append-only sink (DB/S3/SIEM). On write failure, fail closed or
alert — never `console.error` and continue.

**B5. PHI is sent to OpenAI unscrubbed, contradicting the "PHI scrubbing before OpenAI" claim; no BAA.**
`scrubPHI` is called in exactly one route (`app/api/narrative/route.ts:53`).
`app/api/chart-suggest/route.ts:61-68` builds `sampleRows` from raw result rows and posts
them to OpenAI with **no scrubbing** — a confirmed live raw-PHI egress.
`app/api/chat/route.ts:35-51` forwards caller-supplied `context` verbatim with no
server-side scrubbing (the shipped UI currently sends only column labels + row counts, so
chat is a latent/unenforced egress rather than a confirmed leak — but it is not protected).
`SECURITY.md:43` states the OpenAI BAA is **NOT SIGNED**.
**Impact:** Every chart suggestion over patient data is an unlawful PHI disclosure to a third
party with no BAA (HIPAA 164.502(e) / KVKK Art. 9). The "scrubbing complete" claim in
`COMPLIANCE_REPORT.md:33` / `MASTER_PROMPT.md:48,83` is false.
**Fix:** Run `scrubPHI` on rows in chart-suggest; scrub or reject free-form `context` in chat
server-side (send schema/aggregates only). Gate all three AI routes behind a signed-BAA
flag. Do not represent scrubbing as complete.

**B6. Clean/CI install is impossible — lockfile has an unresolvable peer-dependency conflict.**
`package.json` pins `next@14.2.3` while `@clerk/nextjs@7.3.1` requires `next` 15.x/16.x.
`npm ci` exits 1 (reproduced); only `npm install --legacy-peer-deps` succeeds, shipping
Clerk against an unsupported Next major.
**Impact:** Any standard CI/Docker/Vercel build that runs `npm ci` fails at install. The app
cannot be built or deployed from a clean checkout.
**Fix:** Upgrade Next to a Clerk-supported version (≥15.2.8) or pin a Clerk release whose
peer range includes next@14; regenerate the lockfile; add `npm ci` as a CI gate.

**B7. Runs on Next.js 14.2.3 with a critical middleware-bypass CVE while auth is 100% middleware-based.**
`package.json:12` hard-pins `next@14.2.3` (May 2024). Auth is entirely `auth.protect()` in
`middleware.ts`. 14.2.3 predates 14.2.25, which patched CVE-2025-29927 (send
`x-middleware-subrequest` to skip middleware). For an app whose only gate is middleware, this
is a direct auth bypass.
**Impact:** Trivially exploitable authentication bypass on a PHI app.
**Fix:** Upgrade to the latest patched Next (≥14.2.35, ideally 15.x to also clear B6). Add
`npm audit` to CI.

**B8 (blocker-grade). License/suspension gate never runs on API routes — PHI fully accessible after suspension.**
`middleware.ts:23` gates the license check on `!pathname.startsWith('/api/')`, so
`/api/query`, `/api/chat`, `/api/narrative`, `/api/dashboards` are reachable regardless of
license status. A suspended/cancelled tenant retains full programmatic PHI access via direct
API calls.
**Fix:** Enforce a tenant-scoped license check inside `requireAuth`/a shared guard on every
data route; return 402/403 when inactive.

> B3 and B4 both concern the audit/persistence layer; fixing them together (durable shared
> datastore + fail-closed writes) resolves both.

## 3a. Additional Blockers — second pass [A]

**N1. [A] No data-residency control — Turkish PHI egresses to the US with no KVKK cross-border basis.**
The report cites KVKK Art. 9/11 but never asks *where PHI physically lives*. Every AI route ships
PHI/near-PHI to `api.openai.com` (US) and the documented deploy target is Vercel (US default).
`SECURITY.md:95` carries an *unchecked* box "KVKK cross-border data transfer authorization obtained."
For Turkish patient data, KVKK cross-border transfer rules (and the practical VERBIS / explicit-consent
regime) make US-region processing a first-order legal blocker — arguably larger than several blockers
above.
**Impact:** Unlawful cross-border PHI transfer independent of any BAA. A signed OpenAI BAA does *not*
cure a KVKK residency violation.
**Fix:** Establish the TR/EU residency requirement before any deploy; host in-region; use an in-region
or on-prem model endpoint, or send no row-level PHI off-region at all. This belongs at the TOP of Phase 0
alongside the BAA gate.

**N2. [A] The PHI persistence directory `.data/` is git-tracked; a `.gitignore` blind spot will bake patient data into git history.**
`.gitignore:34` ignores `data/`, but `app/api/dashboards/route.ts:6-8` writes to `.data/` (leading dot) —
a *different* directory that is **not** ignored. `.data/dashboards.json` is **already tracked**
(`git check-ignore` confirms NOT ignored; `git ls-files` confirms tracked). Dashboards/charts embed raw
patient result rows (B2). The tracked file is empty today, so no leak has occurred — the trap is armed for
the next `git add -A`.
**Impact:** Imminent, irreversible PHI-into-git-history exposure on the next broad add/commit/push.
**Fix:** `git rm --cached .data/dashboards.json`; add `.data/` to `.gitignore`; unify the write path and
ignore rule to one canonical ignored directory.

**N3. [A] No rate limiting anywhere — `lib/rateLimiter.ts` is dead code (zero importers).**
No AI or query route is throttled. One authenticated `clinician` can loop `/api/narrative` (PHI→OpenAI per
call) or `/api/query` (Trino + O(n) audit-chain rewrite per call) without bound.
**Impact:** Unbounded OpenAI spend, Trino saturation, audit-layer degradation — cost-runaway and DoS from a
single default-role account.
**Fix:** Shared (Redis/Upstash) token-bucket keyed on tenant/user + route on every AI and query route; the
in-memory Map won't survive Vercel's multi-instance model regardless.

**N4. [A] Cross-tenant AI cache leak — `chartCache`/`sqlCache` keys have no tenant component and use a forgeable 32-bit hash.**
`lib/cache.ts:38-50` module-singleton caches keyed by `hashKey(userMessage[, columnKeys])` (djb2, ~4.3B
space). No tenant/user in the key. Tenant B issuing the same NL string as Tenant A gets A's cached,
PHI-derived chart config back — and a `cached:true` hit bypasses the LLM scope check entirely; collisions
are also craftable to poison/read entries.
**Impact:** Cross-tenant inference/PHI-config disclosure + cache poisoning.
**Fix:** Prefix every cache key with the server-derived tenant/user id; replace djb2 with SHA-256; never
cache PHI-derived output without tenant scoping.

**N5. [A] Unvalidated `req.json()` bodies crash routes with unhandled exceptions and no audit.**
`app/api/chart-suggest/route.ts:47-50` calls `columns.map(...)` *before* its try block; `/api/query`,
`/api/chat`, `/api/dashboards`, and the billing routes parse the body with no try/catch. A missing field or
non-JSON body throws `TypeError`/`SyntaxError` to Next's default handler → generic 500, no audit event, and
in some routes partial work already performed.
**Impact:** Trivial unauthenticated-shape → 500 on PHI routes; audit gaps on failure; DoS surface.
**Fix:** Wrap every `req.json()` in try/catch → 400; validate field types/shape (zod) before use, universally.

## 4. High-Priority Issues — before real customers

- **H1. Org-wide audit log readable by any authenticated user.** `app/api/audit/route.ts:6`
  uses `requireAuth`, not `requireAuthWithPermission(req, 'audit:read')` (admin-only per
  `lib/permissions.ts`). Returns 500 events including raw SQL with embedded PHI plus other
  users' emails/IDs. **Fix:** enforce `audit:read`; stop embedding raw SQL/PHI in audit detail.
- **H2. Dashboard/chart write & delete are neither permission-gated nor owner-scoped.**
  `clinician` lacks `dashboard:write`/`chart:write` yet can create/edit/delete anything. RBAC
  is UI-only here (same root cause as B2).
- **H3. "Encryption at rest" is theater.** `lib/store.ts:40,57` writes chart/dashboard PHI to
  localStorage as plain JSON. Other stores use `secureSetSync` = `btoa(...)` base64. The real
  AES-GCM path is dead code and derives its key from a hardcoded passphrase in client JS
  (`secureStorage.ts:18-19`). `app/privacy/page.tsx:215` claims "AES-GCM encryption at rest."
- **H4. localStorage is the declared source of truth with fire-and-forget server writes.**
  `lib/store.ts:80-96`. PHI rows sit in cleartext localStorage surviving logout on shared
  clinical workstations; a second Clerk user on the same browser sees the first user's PHI.
- **H5. "Tamper-evident" audit log is forgeable.** `lib/auditLog.ts` uses an unkeyed SHA-256
  chain over public inputs with no external anchor. Anyone with write access to the file can
  rewrite entries and recompute the chain so it verifies `valid:true`.
- **H6. Breach/anomaly detection is log-only.** Runs on `/api/query` only and appends a line to
  `logs/anomalies.log` that nothing reads. No alert, no breach workflow. Fails 45 CFR
  164.308(a)(1)(ii)(D) and (a)(6).
- **H7. 90-day retention/purge is a no-op on the PHI store.** `lib/retentionPolicy.ts` scans
  `ceiba_sec_*` keys, but the PHI stores write to `ceiba_saved_charts`/`ceiba_dashboards`/etc.
  The one store holding patient rows is never purged.
- **H8. Persistence writes 500 / lose data on the serverless FS** (same class as B3/B4;
  `app/api/dashboards/route.ts:21-24` has no try/catch around `writeFileSync`).
- **H9. No CI/CD pipeline.** No `.github` or workflow files gate build/typecheck/lint/audit/tests.
- **H10. NL→SQL is broken end-to-end through the shipped UI.** `app/api/sql-generate/route.ts:83`
  returns JSON, but the client (`app/data-explorer/page.tsx:308-321`) only handles
  `text/event-stream`; a valid response throws `Unexpected response`. Every successful generation
  surfaces as "SQL generation failed."
- **H11. LLM told to write PostgreSQL against a Trino engine, both catalogs injected blindly.**
  `app/api/sql-generate/route.ts:7` says "Generate PostgreSQL queries"; engine is Trino.
  `schemaInjector.ts:74` feeds both catalogs and the generate route never receives the selected
  `database`, so generation is catalog-blind and produced SQL frequently fails.
- **H12. Client-side "encryption" uses a hardcoded key + base64 sync path** (detail with H3).
- **H13. Global, fail-open license gate.** `app/api/billing/licenses/status/route.ts:13` returns
  `hasActive` if *any* license row is active (no tenant tie); the catch returns
  `{hasActive:true}` and `middleware.ts:43-45` fails open. (The endpoint *is* Clerk-protected,
  not world-callable — but entitlement is global and fail-open.)
- **H14. Flat-file writes are non-atomic;** a crash mid-write silently zeroes the entire store.
  `app/api/dashboards/route.ts:14-24`, `lib/licenseStore.ts:55-58` do whole-array
  read-modify-write with bare `writeFileSync`; a truncated file → swallowed parse error →
  `return []` → next write persists the empty array, permanently discarding all data.

## 4a. Additional High-Priority Issues — second pass [A]

- **H15. [A] `scrubPHI` is an inadequate control — the report's "apply it more widely" fix under-solves B5.**
  `lib/phiScrubber.ts:8-35` matches PHI by a fixed **column-name allowlist** + a single Turkish-ID regex.
  Free-text columns that *contain* PHI (`ClinicalNotes.Summary`, `NoteType`, `AlertType` — exposed by
  `schemaInjector.ts:68`) and any embedded emails/addresses pass through unscrubbed. So `narrative` (which
  already runs scrubPHI) still leaks free-text PHI, and running it on `chart-suggest` rows would create false
  confidence. **Fix:** send schema + aggregates only to any LLM without a BAA; never row-level data. Treat
  scrubPHI as best-effort masking, not a compliance boundary.
- **H16. [A] Additional committed secrets beyond `NEXTAUTH_SECRET`.** `COMPLIANCE_REPORT.md:340` contains a
  live-format `sk-proj-…` OpenAI project key and `:254-258` the shared plaintext login password `ceiba2026`
  (with bcrypt source for all seeded users). All three are burned — rotate the OpenAI key, retire `ceiba2026`
  everywhere, and purge from git history (`git filter-repo`), not just the working tree.
- **H17. [A] Unreported runtime dependency advisories.** Beyond the middleware-bypass CVE and `xlsx`, `npm audit`
  against the lockfile shows (all reachable at runtime): Next **authorization-bypass** GHSA-7gfc-8cq8-jh5f,
  **cache-poisoning** GHSA-gp8f-8m3g-qvj9, **RSC DoS ×5**, middleware **SSRF** GHSA-4342-x723-ch2f, and
  transitive **js-cookie prototype-hijack** GHSA-qjx8-664m-686j via `@clerk/shared`. `next@14.2.35` (non-major)
  clears the entire Next cluster + transitive `postcss` XSS; a Clerk bump clears js-cookie.
- **H18. [A] License `PATCH` mass-assignment + no Stripe webhook idempotency.**
  `app/api/billing/licenses/[id]/route.ts:37-42` spreads arbitrary request fields into the license
  (only `id`/`createdAt` stripped) — an admin session can forge `status:active`, `gracePeriodEnd`,
  `stripeCustomerId` with no payment. `app/api/billing/webhook/route.ts:42` logs but never dedups `event.id`;
  Stripe's at-least-once retries double-process `checkout.session.completed` → duplicate/orphan license rows.
  **Fix:** allowlist mutable fields with enum validation; persist processed `event.id`s and no-op on repeats;
  make license upsert atomic.
- **H19. [A] Audit coverage is incomplete (distinct from H5's forgeability).** `DATA_EXPORT_CSV`/`DATA_EXPORT_EXCEL`
  are defined `AuditAction`s but **never emitted** — CSV/Excel exports of patient data produce no audit record.
  `chart-suggest` (the confirmed PHI-egress route) and dashboard/chart reads/writes (which cache raw PHI) log
  nothing. **Fix:** emit audit events on every PHI read, export, and AI-egress path.
- **H20. [A] Error responses leak Trino/OpenAI internals.** `app/api/query/route.ts:89` returns `String(e)` —
  exposing raw Trino errors incl. the fully-qualified `eclinics."Shared"."Patients"` path; AI routes forward
  raw OpenAI error bodies. **Fix:** log server-side, return a generic message + correlation id.
- **H21. [A] `phiScrubber` uses module-global mutable state (`_letterIndex`) that races across concurrent requests.**
  `lib/phiScrubber.ts:47` — two concurrent `/api/narrative` scrubs reset/advance a shared counter, producing
  non-deterministic, aliasing de-identification tokens under load. **Fix:** make the counter a local inside
  `scrubPHI`.
- **H22. [A] `schema`/`limit` are unvalidated into Trino (elevates the report's Low note).** `query/route.ts:39` →
  `trinoClient.ts:27,41`: caller-controlled `schema` is set directly as `X-Trino-Schema` (header injection /
  arbitrary schema targeting) and `limit` is unbounded (`{"limit":100000000}` buffers up to 100M rows → OOM).
  **Fix:** enum-validate `schema` per catalog; clamp `limit` to a hard max.
- **H23. [A] Trino client has no request timeout and an unbounded poll loop.** `lib/trinoClient.ts:21,39-48` —
  no `AbortSignal`, `while(true)` with no deadline/max-iterations. A hung query pins a serverless invocation
  until platform kill (mid-write → corrupts audit chain / flat files per B4/H14). **Fix:** `AbortSignal.timeout`,
  a wall-clock deadline + max-poll cap, and `export const maxDuration`.
- **H24. [A] Missing subprocessor BAAs/DPAs beyond OpenAI.** Clerk (identity/email), Vercel (hosts all PHI in
  transit + ephemeral FS), and Stripe (billing PII) all touch PHI/PII and each needs a signed BAA/DPA. The
  report's Section 5 "OpenAI BAA" row should be a full subprocessor matrix.
- **H25. [A] Prompt injection; the LLM "clinical scope" guard is model-self-enforced.** `sql-generate`,
  `chart-suggest`, `narrative`, `chat` interpolate caller text directly into prompts; the scope filter is a
  prompt instruction, not a control. Injected instructions can coax arbitrary SQL (then run via the
  bypassable B1 guard) or context exfiltration. **Fix:** enforce table/statement allowlisting on generated SQL
  server-side before execution; never rely on the model to self-police.

## 5. Compliance Claims vs Reality

| Claim (marketing / docs) | Reality | Verdict |
|---|---|---|
| Read-only DB access | First-token guard bypassable; DB-side enforcement unverified (`SECURITY.md:33`) | ❌ False |
| PHI scrubbed before every OpenAI call | Scrubbing only in `narrative`; `chart-suggest` sends raw rows; `chat` unscrubbed path | ❌ False |
| OpenAI BAA in place | `SECURITY.md:43`: "NOT SIGNED" | ❌ Absent |
| AES-256 encryption at rest | Plaintext + base64; hardcoded key; AES path dead code | ❌ False |
| Tamper-evident audit log (SHA-256 chain) | Unkeyed, forgeable end-to-end; lost on redeploy | ❌ False |
| Audit logging + 6-yr retention (§164.312(b)) | Ephemeral FS; silent write failure on serverless | ❌ False |
| Multi-tenant isolation | No tenant scoping on dashboards, charts, audit, licenses | ❌ False |
| MFA for all users | Not implemented anywhere; Clerk doesn't enforce by default | ❌ False |
| Anomaly / breach detection & alerting | Log-only, one route, no alerting, no workflow | ❌ False |
| Data Subject Rights portal (KVKK Art. 11 / GDPR) | Intake log only; no requester verification, no fulfillment | ❌ False |
| 90-day data retention/purge | Key mismatch — never runs on PHI stores | ❌ False |
| Authentication (Clerk middleware) | Real, but on a Next version with a critical middleware-bypass CVE | ⚠️ Undermined |
| RBAC enforced server-side | Audit/dashboard/query routes not permission-gated; roles depend on an undocumented Clerk session claim | ⚠️ Partial/broken |
| License / entitlement enforcement | Not applied to APIs; fail-open; global scope | ❌ False |
| Stripe webhook signature verification | Genuinely enforced (`STRIPE_WEBHOOK_SECRET`) | ✅ Holds |
| **[A]** Data residency (KVKK cross-border) | PHI egresses to US (OpenAI + Vercel); `SECURITY.md:95` box unchecked | ❌ Absent (N1) |
| **[A]** 15-min automatic session timeout (`privacy/page.tsx:231`) | No idle handler / Clerk `sessionOptions` anywhere in code | ❌ False |
| **[A]** Export activity audited | `DATA_EXPORT_CSV/EXCEL` actions defined but never emitted | ❌ False (H19) |
| **[A]** Subprocessor BAAs (Clerk/Vercel/Stripe) | None evidenced; only OpenAI discussed | ❌ Absent (H24) |

## 6. Medium / Low

**Medium**
- **MFA misrepresented** to users (`app/privacy/page.tsx:227`) and docs
  (`docs/USER_MANAGEMENT.md:23` claims Clerk auto-enforces — false); `otplib`/`qrcode` unused.
- **RBAC depends on a non-default Clerk session claim** (`lib/apiAuth.ts:19` reads
  `sessionClaims.publicMetadata`). If unconfigured, everyone silently downgrades to `clinician`.
  Fail-safe direction, but undocumented and fragile.
- **DSAR portal is intake-only theater** (`app/api/privacy/request/route.ts:43-72`): logs
  name/email/IP to a plaintext file, no verification, no fulfillment, no auth. New PII sink.
- **No real test suite; QA is a live-server smoke script** with a tautological "no API key"
  assertion (`scripts/qa-agent.mjs:61-69`); the committed 21/21-pass report ran with auth bypassed.
- **Lint non-functional in automation** — no `.eslintrc`, `next lint` drops to an interactive prompt.
- **Full `NEXTAUTH_SECRET` (and OpenAI key prefix) committed in tracked markdown**
  (`COMPLIANCE_REPORT.md:340-341`). Rotate + scrub history + add secret scanning.
- **12 dependency advisories (1 critical, 9 high)** incl. `xlsx@0.18.5` (no npm fix,
  prototype pollution/ReDoS — used only on export).
- **No `.env.example`; secret docs reference NextAuth and omit Clerk + Stripe secrets**
  (`SECURITY.md:11-34`).
- **Audit hash-chain is O(n)-per-write, single-file, no failure observability.**

**Low**
- Middleware SSRF surface — internal fetch built from request `Host` (`middleware.ts:25-27`);
  header value is a constant, so blast radius small.
- Unvalidated `schema`/`limit` flow into Trino headers (`app/api/query/route.ts:23,38-39`).
- `/api/query` enforces auth but not `query:run`/`query:export` — latent RBAC inconsistency.
- `checkout.session.completed` activates a license without checking `session.payment_status`
  (`app/api/billing/webhook/route.ts:138`) — matters only for async payment methods.
- Trino client has no request timeout / poll deadline (`lib/trinoClient.ts:16-52`).

## 6a. Additional Medium / Low — second pass [A]

**Medium**
- **[A] False "15-minute session timeout" claim** (`app/privacy/page.tsx:231`) — same class as the MFA
  misrepresentation, on the same page; a §164.312(a)(2)(iii) auto-logoff control both required and falsely
  advertised. Clerk session TTL / token rotation / revocation-on-suspend never audited.
- **[A] No DR / backup / RPO-RTO** (§164.308(a)(7) contingency plan). B3 notes ephemeral state but never names
  backup/restore as a requirement — a team could ship Postgres with no backups and think they're done.
- **[A] No monitoring / observability / IR-plan / pen-test evidence.** No error monitoring, uptime alerting, or
  centralized logs; `SECURITY.md` "Penetration test scheduled" box unchecked.
- **[A] `webkitSpeechRecognition` voice input streams clinician audio to Google** (`hooks/useVoiceInput.ts`;
  `Permissions-Policy: microphone=(self)` in `next.config.js:14`) — an un-BAA'd PHI voice egress in the same
  class as the OpenAI egress.
- **[A] No pagination / unbounded response bodies** on `/api/dashboards`, `/api/audit` (fixed 500), `/api/billing/licenses`.
- **[A] No request body-size limit** on any POST route — large-body CPU/memory DoS (compounded by no rate limit, N3).
- **[A] Non-atomic concurrent license-create race** in the webhook (distinct from the replay case, H18).
- **[A] Spoofable/injectable `x-forwarded-for`** written to the public DSAR log (`privacy/request/route.ts:53-56`) —
  log injection + false accountability.
- **[A] Narrative audit event logged *before* the OpenAI call resolves** (`narrative/route.ts:56-66`) — audit says
  "generated" even when egress failed.
- **[A] `.gitignore` misses `.env.production`/`.env.staging`** (only `.env`/`*.local` covered) and **`.qa-reports/` is
  tracked** — QA reports capture response snippets from PHI routes on failure. Both latent PHI/secret leaks.
- **[A] Static PBKDF2 salt** (`lib/secureStorage.ts:18-20`) makes the "AES-GCM" key a public constant computable from
  the bundle — no per-user/deploy protection, rotation impossible without redeploy (extends H3/H12).
- **[A] Frontend data races.** Dashboard-detail stale-closure always discards fresher server data
  (`app/dashboards/[id]/page.tsx:314-324`); out-of-order `/api/narrative` and `/api/chat` responses attach to the
  wrong query/message (`app/data-explorer/page.tsx:183-231,270-499`); `Date.now()`-based React `key`s can bleed
  message content across list items.
- **[A] Suspended-account "Update Payment Method" CTA is a hardcoded test placeholder URL**
  (`app/suspended/page.tsx:63`) — a suspended paying customer cannot self-serve reactivate.

**Low**
- **[A] CSP weakened by `unsafe-eval` + `unsafe-inline` in `script-src`** (`next.config.js:25`) — should be nonce/hash-based.
- **[A] `cache-stats` exposes internals to any authenticated user** (`app/api/cache-stats/route.ts:9-12`) — gate behind admin.
- **[A] Divergent hand-rolled admin guards** (`billing/licenses` routes read `sessionClaims` directly vs.
  `requireAuthWithPermission` elsewhere) — authz drift hazard.
- **[A] Inconsistent status codes / error envelopes** across AI routes (422 shapes differ; 500 vs 502) — client must special-case each.
- **[A] No results virtualization** — the LIMIT dropdown offers 10,000 rows rendered as raw `<tr>` nodes
  (`components/DataExplorer/SqlPanel.tsx:49,449-488`) → main-thread stall / mobile crash.
- **[A] Modal a11y** — `SaveToDashboardModal` lacks `role="dialog"`/focus trap/Escape/focus restore; systemic
  low-contrast tertiary text (`#44444b` on `#0d0d10` ≈ 2.1:1) fails WCAG AA.
- **[A] `MobileNav` active-tab defaults unknown routes to "explorer"** (`components/MobileNav.tsx:16-23`) — mislabels
  `/billing`, `/audit`, `/help`, `/suspended`.

## 7. Recommended Path to Production *(updated, second pass)*

**Phase 0 — Toolchain & bleeding-stop (do not touch production PHI until all done).**
0. **[A] Establish a strict, CI-enforced toolchain FIRST.** Adopt **oxlint (oxc)** as the primary linter
   (fast, zero-config, catches correctness classes the missing eslintrc never did), keep a thin
   `eslint-config-next` layer only for Next-specific rules if needed; wire `lint`/`typecheck` into CI as
   blocking gates. **Upgrade all dependencies to their latest stable versions** — this is the lever that
   clears B6, B7, H17 and the whole Next advisory cluster at once: Next → latest 15.x (Clerk-supported,
   clears the peer conflict and CVE-2025-29927), Clerk/Stripe/recharts/lucide/etc. to latest; replace or
   remove `xlsx@0.18.5` (no-fix advisory). Regenerate the lockfile; verify `npm ci` succeeds clean; pin
   Node via `engines`.
1. **[A] Secrets & git hygiene.** `git rm --cached .data/dashboards.json`, add `.data/`, `.env.production`,
   `.env.staging`, `.qa-reports/` to `.gitignore` (N2). Rotate the OpenAI key + `NEXTAUTH_SECRET`, retire
   `ceiba2026`, redact `COMPLIANCE_REPORT.md`, and purge all three from history with `git filter-repo`
   (H16). Add secret scanning to CI.
2. Enforce read-only at Trino with a real SELECT-only role, verified at the **connector *and* source-DB
   grant** level (not just a Trino role); replace the first-token SQL guard with parser-based validation;
   enforce a server-side table/statement allowlist on generated SQL before execution (B1, H25).
3. **[revised] Replace Clerk with a local RBAC auth system** (session + hashed credentials + the existing
   `lib/permissions.ts` role/permission map); remove `@clerk/nextjs`. *Then* add **per-user owner scoping**
   to dashboards/charts and the audit route and enforce write/`audit:read` permissions (B2, H1, H2). Clerk
   Organizations / multi-tenant deferred with the auth-provider milestone.
4. **[descoped]** Billing/licensing removed entirely (Stripe, webhook, license store, `/suspended`) — B8/H13
   no longer apply. The API trust boundary is now enforced by local RBAC + owner scoping, failing **closed**.
5. Stop PHI egress: **[A]** send schema + aggregates only (never row-level PHI) to any LLM without a BAA —
   do not merely widen `scrubPHI`, which misses free-text PHI (B5, H15); disable/round-trip
   `webkitSpeechRecognition`. **[A] Resolve data residency (N1)** — establish the KVKK cross-border basis
   and in-region hosting *before* any PHI touches OpenAI/Vercel. BAA alone does not cure residency.
6. **[A] Harden the API trust boundary:** universal `req.json()` validation → 400 (N5); shared tenant-scoped
   **rate limiting** on all AI/query routes (N3); tenant-prefix + SHA-256 cache keys (N4); clamp `limit` /
   enum-validate `schema` (H22); Trino timeout + poll deadline + `maxDuration` (H23); generic error envelopes,
   no internal leakage (H20); request body-size limits.

**Phase 1 — Durable, auditable foundation.**
7. Introduce a real datastore (Postgres, in-region per N1) for dashboards/charts/licenses/audit with
   row-level tenant scoping; make the server authoritative; remove PHI from localStorage **atomically with
   standing up the server store** (do not remove one without the other) (B3, H4, H8, H14).
8. Move audit logging to a durable append-only sink that fails closed/alerts on write failure; replace the
   unkeyed chain with **externally-custodied HMAC / WORM / SIEM anchoring** (a local HMAC key is still
   forgeable) (B4, H5). **[A]** Emit the missing audit events — exports and all PHI-egress/read paths (H19);
   log AI-egress outcomes *after* the call resolves (§6a).
9. Fix retention to target the real PHI keys with a test (H7); wire anomaly flags to real alerting + a
   breach-response workflow with 60-day clock handling (H6). **[A]** Define DR/backup with explicit RPO/RTO.
10. **[descoped]** Billing integrity items (H18/L4 — license PATCH allowlist, Stripe webhook idempotency)
    removed with the billing subsystem. Revisit when Stripe is reintroduced.

**Phase 2 — Correct the product and the claims.**
11. Fix NL→SQL client/server contract and the Postgres-vs-Trino/catalog bugs; integration test
    NL→populated editor→executed query (H10, H11). **[A]** Fix the frontend data races (dashboard stale
    closure, out-of-order narrative/chat, `Date.now()` keys), the suspended-account Stripe portal CTA,
    results virtualization, and modal/contrast a11y (§6a).
12. Reconcile every compliance claim with reality — AES-at-rest, MFA, tamper-evident, retention, DSAR,
    scrubbing, **[A] the false 15-min session-timeout claim**, and the **[A] subprocessor BAA matrix**
    (Clerk/Vercel/Stripe, H24). Implement/verify enforced MFA + real session timeout; build a real DSAR
    fulfillment workflow (H3, §5).

**Phase 3 — Operational hardening.**
13. CI blocking merge: oxlint + typecheck + `npm audit` + secret scanning + tests + `npm ci` (H9, Phase-0
    toolchain enforced permanently); commit `.env.example`.
14. Replace the smoke script with real unit/integration tests for auth, permissions, PHI scrubbing, and SQL
    safety, runnable in CI without external services. **[A]** Add monitoring/observability + an IR plan;
    schedule a pen test.
15. **[A]** Harden CSP (nonce/hash, drop blanket `unsafe-eval`/`unsafe-inline`), gate `cache-stats`, unify
    admin authz, standardize error/status envelopes.

**Bottom line:** treat all current server-side data as untrusted, all "applied" compliance fixes as
unverified, and all committed secrets as burned. **[A]** Two second-pass items rise to blocker level —
**data residency (N1)** and **`.data/` PHI tracked in git (N2)** — and the report's own "widen scrubPHI"
guidance is insufficient (H15). This is a promising prototype, but it is multiple phases of focused work —
not touch-ups — away from lawfully handling real patient data.

## 8. [A] Second-Pass Meta-Review — verification & report corrections

A dedicated meta-reviewer re-checked this report against the cited code.

**Verification result:** B1–B8, H1–H5, H10–H13, L4, and the committed-secret claims were each confirmed
at the cited file:line — **zero false alarms, zero overstatements, zero wrong-locations.** The report is
safe to act on. Two nuances: (a) the chart-suggest PHI leak (B5) is reachable by the **default `clinician`
role** with no privilege escalation — if anything B5 is *understated*; (b) H10's phrasing ("only handles
`text/event-stream`") is slightly imprecise — the client handles non-stream responses, just not the success
shape — but the conclusion (valid generations surface as failures) holds.

**Recommendations in this report that, as written, could create a false sense of safety — corrected above:**
- **"Scrub `chart-suggest` rows" (old Phase 0.5) under-solves B5.** `scrubPHI` is an allowlist+single-regex
  masker that misses free-text PHI. Corrected to "send schema/aggregates only" (H15).
- **"HMAC/signature" for the audit chain is insufficient with a local key.** An attacker with write access
  also has the key. Corrected to external key custody / WORM / SIEM anchoring (Phase 1.8).
- **Fail-open is a standing pattern, not a one-off.** The fixes are now stated as a principle — security
  controls fail **closed** — so it is not reintroduced elsewhere (Phase 0.4).

---
*One finding was downgraded during verification: the license-status endpoint was initially
flagged as anonymously world-callable (BLOCKER) but is in fact Clerk-protected; the real defect
is that entitlement is global and fail-open (HIGH). This is noted for transparency about the
review process.*
