# Architecture — Ceiba Data AI Explorer (current state)

> Concise, accurate description of the system **as built** on the
> `remediation/phase-0-foundation` branch. Where something is planned but not yet
> implemented it is explicitly marked **planned**. For the full audit and remediation
> plan see `PRODUCTION_READINESS_REPORT.md` (this doc reflects its scope-change note,
> §7 revised plan, and §7a architecture review).

---

## 1. Overview

A Next.js 15 (App Router) application that turns natural-language questions into SQL,
runs them read-only against a Trino data warehouse, and visualizes/summarizes the
results. Authentication and multi-tenancy are handled locally (no external IdP, no
billing). Persistence is currently flat-file JSON behind a repository interface, with a
Postgres/Prisma backing **planned**.

Key modules:

| Concern | Module |
|---|---|
| Auth guards (route handlers) | `lib/apiAuth.ts` |
| Session signing/verification | `lib/session.ts` |
| User + org store | `lib/authStore.ts` |
| RBAC matrix | `lib/permissions.ts` |
| Coarse auth gate | `middleware.ts` |
| Data-access seam (org/owner scoping) | `lib/repository.ts` |
| Canonical domain types | `lib/domain.ts` |
| Request validation / body-size | `lib/validation.ts` |
| Error envelope | `lib/errors.ts` |
| Rate limiting | `lib/rateLimiter.ts` |
| Audit log | `lib/auditLog.ts` |
| Trino client | `lib/trinoClient.ts` |

---

## 2. Auth & session model

Local RBAC — no external identity provider.

- **Credentials.** Users live in `data/users.json` (gitignored) with **bcrypt** password
  hashes (`lib/authStore.ts`). Seeded on first use across two orgs.
- **Sessions.** A session is a JSON payload `{ userId, orgId, role, iat, exp }` encoded
  base64url and signed with **HMAC-SHA256** over `SESSION_SECRET`
  (`cookie = base64url(payload) + "." + base64url(mac)`). It is **stateless** — the
  signed cookie *is* the session; there is no server session table.
- **Cookie.** `ceiba_session`, `httpOnly`, `SameSite=Lax`, `Secure` in production, 8-hour
  TTL. Signature verified constant-time on every read; `exp` enforced.
- **Two verifiers, one scheme.** `verifySession` (Node runtime, `node:crypto`) for route
  handlers; `verifySessionEdge` (Edge runtime, WebCrypto `SubtleCrypto`) for middleware.
  Cookies signed on either side verify on the other.
- **RBAC.** Three roles (`admin`, `analyst`, `clinician`) → ten permissions, defined in
  `lib/permissions.ts` (see `docs/USER_MANAGEMENT.md` for the full matrix). Enforced
  server-side via `requireAuthWithPermission(req, permission)`.
- **Middleware** (`middleware.ts`) is a **coarse authentication gate only**: it checks a
  valid session exists and otherwise returns `401` (for `/api/*`) or redirects to
  `/sign-in` (for pages). It carries **no permission logic** — per-route authorization
  (403) is done in the handlers. Public routes: `/sign-in`, `/sign-up`, `/privacy`,
  `/api/auth/login`, `/api/auth/logout`, `/api/privacy/request`.
- **Provisioning** is invite-only: only `admin:manage` can create users via
  `POST /api/auth/register`.

---

## 3. Org / owner tenancy and where it is enforced

Every user belongs to exactly one **organization** (`orgId`) — the tenant key. It is
carried in the signed session and is the basis for all data scoping.

**All tenancy enforcement lives in one place: `lib/repository.ts`** (the AR2/AR3/B2
seam). Route handlers never issue an unscoped read or write; they call a repository with
the session, and the repository is solely responsible for:

- `list(session)` / `get(session, id)` → return **only** records whose `orgId ===
  session.orgId`. A cross-org `get` is indistinguishable from "not found" (existence is
  not leaked).
- `upsert(session, entity)` → **stamps** `orgId = session.orgId` and (on create) `owner
  = session.userId` from the session; any client-supplied `orgId`/`owner` is ignored. An
  update that targets a record in **another** org is **rejected** (returns `null`) — this
  closes the B2 IDOR.
- `delete(session, id)` → deletes **only** within `session.orgId`; a cross-org id is a
  no-op.

Canonical entities (`lib/domain.ts`) all extend an `OwnedEntity` envelope
(`id, orgId, owner, createdAt, updatedAt`). `domain.ts` reconciles the previously
duplicated/incompatible `Chart`/`Dashboard` shapes into one canonical type each, so a
dashboard or chart authored by either UI round-trips without loss.

Audit records also carry `orgId` (`lib/auditLog.ts`); the `/api/audit` route filters by
`session.orgId` and requires `audit:read` (admin-only).

> The write path flips source-of-truth to the **server** (the repository), per AR4.
> localStorage is a render cache only, not the authority.

---

## 4. API trust-boundary pattern

Data/AI route handlers follow a consistent, layered guard order. The building blocks are
stable contracts in `lib/`; the canonical order is:

```
auth (requireAuth / requireAuthWithPermission)   → 401 / 403   lib/apiAuth.ts
  → rateLimit(session, routeName)                → 429         lib/rateLimiter.ts
  → enforceBodySize(req)                         → 413         lib/validation.ts
  → parseBody(req, <ZodSchema>)                  → 400         lib/validation.ts
  → handler (repository / Trino / OpenAI)
  → safeError(e, { context, status })            → 500 / 502   lib/errors.ts
```

- **Auth first** — `lib/apiAuth.ts` returns a discriminated union `{ session, error }`;
  handlers check `error` first. `apiAuth`'s 401/403 bodies are a stable pre-existing
  contract and are intentionally not reshaped by the error envelope.
- **Rate limiting** — per-user + per-route fixed-window limiter
  (`rateLimit(session, routeName)`). Expensive AI/query routes are throttled tightest
  (see `ROUTE_LIMITS`). The default store is an in-process `Map`; a `RateLimitStore` seam
  exists to inject Redis/Upstash for multi-instance deployments (**planned** for
  production — the in-memory store is per-instance only).
- **Body-size guard** — `enforceBodySize` rejects oversized bodies (default 1 MB) via
  `Content-Length` (413). A hard streaming cap belongs at the platform edge (**planned**,
  infra).
- **Body parse + validate** — `parseBody(req, schema)` wraps `req.json()` + a **zod**
  schema; malformed JSON or a bad shape → `400` with a **safe** message (field paths
  only, never received values / zod internals / stack). Per-route schemas
  (`QueryBodySchema`, `ChatBodySchema`, `NarrativeBodySchema`, `ChartSuggestBodySchema`,
  `SqlGenerateBodySchema`) live in `lib/validation.ts`.
- **Standard error envelope** — every non-auth error is
  `{ error: { code, message, correlationId? } }` with a stable machine-readable `code`
  (`lib/errors.ts`). `safeError` logs full detail server-side under a `correlationId` and
  returns a generic client message — **no Trino/OpenAI internals or stack ever reach the
  client** (fixes the previous `String(e)` leakage).
- **Fail closed.** Guards fail closed (deny on doubt); this is a stated principle, not a
  one-off — see the audit note in `PRODUCTION_READINESS_REPORT.md` §8.

Status-code convention: `400` validation, `401` unauthenticated, `403` forbidden, `404`
not-found/not-visible, `413` too-large, `422` semantic/scope rejection, `429` rate-limited,
`500` internal, `502` upstream.

---

## 5. Persistence model

- **Today:** flat-file JSON under a gitignored data directory.
  - Users/orgs → `data/users.json` (`lib/authStore.ts`).
  - Dashboards/charts → `.data/dashboards.json`, `.data/charts.json` behind the
    repository (`lib/repository.ts`; directory overridable via `CEIBA_DATA_DIR`).
  - Audit log → hash-chained file (`lib/auditLog.ts`).
  - Writes are **crash-safe**: the repository writes to a temp file then `rename`s, so a
    crash mid-write cannot zero the store.
- **Planned (not yet implemented):** a durable, in-region **Postgres + Prisma** backing.
  The repository interface (`Repository<T, Input>`) is the single seam WS-G will
  reimplement — the Postgres swap is bounded to `lib/repository.ts`, and every canonical
  entity already carries the tenancy tuple the row-level scoping needs.

> **Deferred / known limitation:** the flat-file store on an ephemeral serverless
> filesystem is **not** durable across redeploys or consistent across instances. This is
> why durable Postgres persistence and a durable append-only audit sink are Phase-1
> requirements, not done. Do not treat the current store as production-durable.

---

## 6. AI-egress model (schema/aggregates only; BAA + residency gate)

The AI features (`/api/narrative`, `/api/chat`, `/api/chart-suggest`, `/api/sql-generate`)
call OpenAI. The governing rules:

- **Minimize what leaves.** Because OpenAI is a third party (and, for Turkish patient
  data, a cross-border processor), the intended egress model is **schema + aggregates
  only — never row-level PHI** to any LLM without a signed BAA. Column-name masking
  (`lib/phiScrubber.ts`) is treated as best-effort, **not** a compliance boundary (it
  misses free-text PHI), so it is not relied on as the control.
- **BAA gate — being finalized.** All AI routes are intended to be gated behind a
  signed-BAA flag (an `OPENAI_BAA_SIGNED` environment gate), so PHI-adjacent AI features
  refuse to call OpenAI until a BAA is in place. This gate is **mid-implementation by the
  AI-egress workstream** and is being finalized; treat "AI routes refuse without a signed
  BAA" as the intended, in-progress behavior. `SECURITY.md` tracks BAA status.
- **Data residency — planned/unresolved (blocker N1).** There is **no** data-residency
  control today. Turkish PHI egressing to US-region OpenAI/Vercel has no KVKK cross-border
  basis established. A signed BAA does **not** cure a residency violation. In-region
  hosting / an in-region model endpoint / sending no row-level PHI off-region must be
  established **before** any real PHI is processed.

---

## 7. PHI data flow (query path)

```
Clinician (browser)
   │  natural-language question
   ▼
/api/sql-generate ──► OpenAI  (schema/aggregates only; BAA gate being finalized)
   │  generated SQL (reviewed in editor)
   ▼
/api/query ──► lib/sqlGuard ──► lib/trinoClient ──► Trino (READ-ONLY)
   │            (statement safety)                    │  result rows (PHI)
   ▼                                                  ▼
results panel ──► /api/narrative | /api/chart-suggest ──► OpenAI
   │                (egress-minimized; BAA gate)
   ▼
save ──► lib/repository (stamps orgId + owner) ──► .data/*.json
   │
   └──► lib/auditLog (org-scoped, hash-chained)
```

Notes on the flow:
- Trino access is **read-only** by design; statement safety is checked by `lib/sqlGuard`
  before execution and `limit` is clamped / `schema` validated in the query path.
  Robust DB-side read-only enforcement and parser-based SQL validation are **hardening
  items** tracked in the readiness report.
- Result rows contain PHI. They are scoped to the caller's org/owner when persisted
  (repository), and their egress to OpenAI is governed by §6.
- Audit events are org-scoped; broader audit coverage (exports, all PHI read/egress
  paths) and a durable, externally-anchored sink are **planned** (Phase 1).

---

## 8. Known-deferred items (planned, NOT implemented)

These are explicitly not built yet; do not represent them as existing:

- **Postgres + Prisma** durable, in-region datastore (repository seam is ready).
- **Durable, externally-anchored audit sink** (fail-closed on write failure; WORM/SIEM /
  external key custody). Today's audit log is a local hash-chained file.
- **Data residency (N1)** — KVKK cross-border basis + in-region hosting/model endpoint.
- **Signed OpenAI BAA** and the `OPENAI_BAA_SIGNED` egress gate (gate being finalized).
- **MFA** and an **idle/inactivity session timeout** (only the 8-hour absolute TTL exists).
- **Shared (Redis/Upstash) rate-limit store** for multi-instance correctness.
- **Billing / licensing / subscriptions** — removed entirely; not part of the product.

---

## 9. Workstreams / phases (reference)

Remediation is organized into phases in `PRODUCTION_READINESS_REPORT.md` §7:

- **Phase 0** — toolchain (oxlint, Next 15, `npm ci` green, zod), secrets/git hygiene,
  Trino read-only + SQL safety, **local RBAC auth replacing Clerk**, org+owner scoping via
  the repository seam, API trust-boundary hardening, PHI-egress minimization + residency.
- **Phase 1** — durable Postgres persistence, durable/anchored audit sink, retention +
  breach workflow, DR/backup.
- **Phase 2** — product correctness (NL→SQL contract, data-race fixes) and reconciling all
  compliance claims with reality; MFA + real session timeout; DSAR fulfillment.
- **Phase 3** — CI gates (oxlint + typecheck + audit + secret-scan + tests + `npm ci`),
  real test suites, monitoring/IR, CSP hardening.

Billing/Stripe and the associated findings (B8, H13, H18, L4) are **descoped/removed**.
