# Multi-Org Auth — Implementation Plan

**Branch:** `remediation/phase-0-foundation`
**Status:** Design (implementation-ready). READ-ONLY — no code changed by this document.
**Scope:** TypeScript auth/RBAC/routes layer only. The NL→SQL runtime extraction to Python is a *separate* plan; this document defines the boundary contract that plan consumes (Section 9).

---

## 0. Decision & Guiding Invariant

**Decision:** A user may belong to **multiple organizations** via **memberships**, but operates with **exactly one active org at a time**. Switching orgs re-issues the session. This serves multi-tenant admins / consultants who serve several hospitals, **without ever blending tenants in a single query**.

**The one invariant that makes this safe (and cheap):**

> Downstream scoping code (`repository.ts`, cache keys, `auditLog.ts`, audit route, the Python service) continues to read **exactly one** tenant key — `session.orgId`. Multi-org changes *only how that single key is chosen* (it becomes the active membership's org). **Not one line of the scoping layer changes.**

This is the backward-compatibility spine of the whole plan: `session.orgId` remains the name and shape of the tenant key. Everything the scoping layer does today keeps working verbatim.

### Terminology
- **Membership** — a `{ orgId, role }` pair on a user. A user has ≥1 membership.
- **Active org** — the single org the session is currently scoped to (`activeOrgId`).
- **Effective role** — the role of the *active* membership. This is what `session.role` carries. A user can be `admin` in org-A and `clinician` in org-B; the effective role flips on switch.

---

## 1. Data Model Change (`lib/authStore.ts`)

### 1.1 New types

```ts
// lib/permissions.ts — unchanged (Role, Permission, ROLE_PERMISSIONS, hasPermission stay as-is)

// lib/authStore.ts

/** A user's role within one org. Role may differ per org. */
export type Membership = {
  orgId: string
  role: Role
}

export type User = {
  id: string
  email: string
  /** bcrypt hash — never a plaintext password. */
  passwordHash: string
  /** One or more org memberships. MUST contain ≥1 entry. */
  memberships: Membership[]
  /**
   * The org selected at login when the user does not pick one. Falls back to
   * memberships[0].orgId if unset/stale. Updated to the last-switched org so a
   * returning user lands where they left off ("last-active").
   */
  defaultOrgId: string
  name: string
  createdAt: string
}

/** Client-safe shape (no passwordHash). Drives the UI org-switcher. */
export type PublicUser = {
  id: string
  email: string
  name: string
  memberships: Membership[]     // [{orgId, role}, ...] — powers the switcher
  defaultOrgId: string
}
```

**Removed from `User`/`PublicUser`:** the single `orgId` and top-level `role`. They are superseded by `memberships` (+ the *session* still exposes a resolved `orgId`/`role` — see Section 2).

### 1.2 New store helpers (`lib/authStore.ts`)

```ts
/** True iff the user has a membership in orgId. The membership-boundary check. */
export function isMemberOf(user: User, orgId: string): boolean {
  return user.memberships.some((m) => m.orgId === orgId)
}

/** Resolve the role of a user in a given org, or null if not a member. */
export function roleInOrg(user: User, orgId: string): Role | null {
  return user.memberships.find((m) => m.orgId === orgId)?.role ?? null
}

/**
 * Choose the active org at login: preferred (if a member), else defaultOrgId
 * (if still a member), else the first membership. Never returns an org the
 * user is not a member of.
 */
export function resolveActiveOrg(user: User, preferred?: string): string {
  if (preferred && isMemberOf(user, preferred)) return preferred
  if (isMemberOf(user, user.defaultOrgId)) return user.defaultOrgId
  return user.memberships[0].orgId
}

/** Add or update a membership (admin provisioning). Idempotent on orgId. */
export function grantMembership(userId: string, orgId: string, role: Role): PublicUser | null

/** Remove a membership. Refuses to remove the last one (a user must keep ≥1). */
export function revokeMembership(userId: string, orgId: string): PublicUser | null

/** Persist last-active org after a switch. */
export function setDefaultOrg(userId: string, orgId: string): void
```

`toPublicUser` returns `{ id, email, name, memberships, defaultOrgId }`.

`findUserById` / `findUserByEmail` / `verifyCredentials` keep their signatures — only the returned `User` shape changes.

`addUser` (Section 6) changes its input to take an initial membership instead of `{ role, orgId }`.

`ORG_REGISTRY` is unchanged and now also serves the switcher's display names.

### 1.3 Migration of `data/users.json` (and seed)

Existing records are single-org: `{ ..., role, orgId, ... }`. Migration is **idempotent and lazy**, run inside `getUsers()`/`ensureSeeded()` on first read after deploy, so it is invisible to callers.

**Migration rule (per record):**
```ts
// Pseudocode inside readAll() normalization
function migrateRecord(raw: any): User {
  if (Array.isArray(raw.memberships)) return raw as User   // already migrated
  // Legacy single-org record → one membership.
  const orgId = raw.orgId
  const role  = raw.role
  return {
    id: raw.id,
    email: raw.email,
    passwordHash: raw.passwordHash,
    memberships: [{ orgId, role }],
    defaultOrgId: orgId,
    name: raw.name,
    createdAt: raw.createdAt,
  }
}
```

- The migrated array is **written back once** (so `users.json` on disk becomes the new shape) the first time a legacy record is detected. Subsequent reads short-circuit (`Array.isArray(raw.memberships)`).
- **Seed data:** `SEED_USERS` becomes `{ email, name, memberships: [{orgId, role}] }`. Add **one multi-org seed user** to exercise the new path from day one, e.g.:

  ```ts
  { email: 'consultant@ceiba-healthcare.com', name: 'Cross-Org Consultant',
    memberships: [
      { orgId: 'org-ceiba', role: 'admin' },
      { orgId: 'org-demo',  role: 'analyst' },
    ],
    defaultOrgId: 'org-ceiba' }
  ```

**Backward-compat guarantee:** every existing single-org user becomes a one-membership user whose *only* active org equals its old `orgId`, and whose effective role equals its old `role`. Their session behaves identically to today.

---

## 2. Session Model (`lib/session.ts`, `lib/apiAuth.ts`)

### 2.1 What goes in the cookie — decision

**Recommendation: the cookie stays minimal. It carries the *active* org + resolved role ONLY. The membership list is NOT in the cookie; it is looked up server-side from the store.**

Rationale:
- **Cookie size** — memberships are unbounded (a consultant could have 20 orgs). Cookies must stay < 4 KB; keeping only `activeOrgId` + `role` keeps the cookie the same tiny size it is today.
- **Revocation** — if a membership is revoked, an in-cookie list would be stale until the 8-hour TTL expires, letting a revoked user keep switching. Looking up memberships from the store on every switch/`me` means revocation takes effect immediately. (See Section 5 for the switch-time re-check.)
- **The scoping layer never needs the list** — it only ever needs one active org, which *is* in the cookie.

So the cookie changes **only** in that `orgId` is now interpreted as "the active org", and gains nothing else. In fact, no field is added to the wire payload — we **rename the concept**, not the field. To keep the scoping layer literally unchanged, **the wire field stays named `orgId`** and carries the active org.

### 2.2 New session types

```ts
// lib/session.ts — the wire payload is UNCHANGED in shape.
export type SessionPayload = {
  userId: string
  orgId: string   // = the ACTIVE org. (Same field name; scoping code untouched.)
  role: Role       // = the resolved role for the active org.
}
```

No change to `signSession`, `verifySession`, `verifySessionEdge`, `sessionCookieOptions`, TTL, or the HMAC scheme. The validator's `if (!parsed.userId || !parsed.orgId || !parsed.role)` guard still holds.

```ts
// lib/apiAuth.ts
export type Session = {
  userId: string
  orgId: string   // the ACTIVE org — the single scoping key. UNCHANGED name.
  role: Role       // effective role FOR the active org.
}
```

`Session` is **byte-for-byte the same type**. `repository.ts` (`session.orgId`, `session.userId`), audit (`session.orgId`), and cache keys keep compiling and behaving identically. **This is the crux of backward compatibility.**

### 2.3 How guards resolve the role

The guards themselves need almost no change, because the resolved role is already baked into the cookie at login/switch time. The one hardening addition: `requireAuthWithPermission` re-validates the active membership against the store, so a revoked/downgraded membership can't ride an old cookie.

```ts
// lib/apiAuth.ts

export async function getSession(request?: Request): Promise<Session | null> {
  const raw = await readSessionCookie(request)
  const payload = verifySession(raw)
  if (!payload) return null
  return { userId: payload.userId, orgId: payload.orgId, role: payload.role }
}

// requireAuth / requireOrg: UNCHANGED.

/**
 * requireAuthWithPermission — now resolves the effective role from the ACTIVE
 * membership at check time (defence-in-depth against a stale cookie), then
 * applies hasPermission. If the user is no longer a member of the active org,
 * this is 401 (the session is invalid), NOT 403.
 */
export async function requireAuthWithPermission(
  request: Request | undefined,
  permission: Permission
): Promise<AuthResult> {
  const { session, error } = await requireAuth(request)
  if (error) return { session: null, error }

  // Re-resolve against the store (revocation-safe).
  const user = findUserById(session.userId)
  const effectiveRole = user ? roleInOrg(user, session.orgId) : null
  if (!user || effectiveRole === null) {
    // Membership for the active org was revoked → treat session as invalid.
    return unauthorized()
  }

  if (!hasPermission(effectiveRole, permission)) {
    return forbidden(permission, effectiveRole)
  }
  // Return the freshly-resolved role so downstream reads the current truth.
  return { session: { ...session, role: effectiveRole }, error: null }
}
```

> Note: `getSession`/`requireAuth`/`requireOrg` do **not** hit the store (cheap, stateless — same as today). Only `requireAuthWithPermission` does the extra lookup, which is exactly the call sites that gate privileged actions. This keeps hot read paths stateless while making authorization revocation-safe.

---

## 3. Org-Switch Flow

### 3.1 `POST /api/auth/switch-org` (new)

**Request:**
```json
{ "orgId": "org-demo" }
```

**Behavior:**
1. `requireAuth(req)` → 401 if no session.
2. `findUserById(session.userId)`; `isMemberOf(user, orgId)`.
   - **Not a member → 403** `{ "error": "Forbidden", "reason": "not_a_member" }`. (This is the membership-boundary enforcement point — see Section 5.)
3. Resolve `role = roleInOrg(user, orgId)`.
4. Re-issue the cookie: `signSession({ userId, orgId, role })`.
5. `setDefaultOrg(userId, orgId)` (last-active).
6. Audit `ORG_SWITCH` (Section 7).
7. Respond `200`.

**Success response:**
```json
{
  "activeOrgId": "org-demo",
  "role": "analyst",
  "orgName": "Demo Hospital"
}
```
with `Set-Cookie: ceiba_session=...` (new active org + role).

**Failure responses:** `401` (no session), `403` (not a member), `400` (missing/invalid `orgId`).

**Idempotency:** switching to the already-active org is a 200 no-op that still re-issues the cookie (harmless, keeps the handler simple).

### 3.2 `GET /api/auth/me` (change)

Return memberships + active org so the UI can render the switcher and highlight the current org.

```json
{
  "user": {
    "id": "...",
    "email": "consultant@ceiba-healthcare.com",
    "name": "Cross-Org Consultant",
    "memberships": [
      { "orgId": "org-ceiba", "role": "admin",   "orgName": "Ceiba Healthcare" },
      { "orgId": "org-demo",  "role": "analyst", "orgName": "Demo Hospital" }
    ],
    "defaultOrgId": "org-ceiba"
  },
  "activeOrgId": "org-ceiba",
  "activeRole": "admin",
  "orgName": "Ceiba Healthcare"
}
```

`activeOrgId`/`activeRole` come from the **session** (`session.orgId`, `session.role`), not from `defaultOrgId` — the session is the source of truth for "what am I scoped to right now". `orgName` per membership is resolved via `ORG_REGISTRY`.

---

## 4. RBAC Per Active Org

`hasPermission(role, permission)` and `ROLE_PERMISSIONS` are **unchanged**. The only thing that changes is *which* role is passed in: the effective role of the **active** membership.

Resolution chain:
1. Cookie carries `role` = effective role for the active org (stamped at login/switch).
2. `requireAuthWithPermission` **re-resolves** `roleInOrg(user, session.orgId)` at check time and uses that (Section 2.3), so:
   - A user who is `admin` in org-A and `analyst` in org-B, **active on org-A**, passes `admin:manage`.
   - The same user after `switch-org` to org-B is `analyst`, so `admin:manage` → **403**, but `query:run` still passes.
3. If the active membership was revoked mid-session, `roleInOrg` returns `null` → **401** (session invalid).

**Worked example (single request):**
`requireAuthWithPermission(req, 'audit:read')` for the consultant while active on `org-demo`:
- `session.orgId = 'org-demo'`, `roleInOrg(user, 'org-demo') = 'analyst'`.
- `hasPermission('analyst', 'audit:read')` → `false` → **403**. Correct: they are only an analyst in Demo Hospital, so they cannot read Demo's audit log even though they are a Ceiba admin.

---

## 5. Cross-Tenant Isolation Invariant (Critical Safety Property)

**Property:** A user MUST NOT read, write, or query an org they are not a member of, and the **active org strictly bounds every** query / repository / audit operation.

### 5.1 Where it is enforced (defence in depth)

| Layer | Enforcement | Notes |
|---|---|---|
| **Session issuance** | `login` and `switch-org` will only ever stamp `orgId` into the cookie via `resolveActiveOrg`/`isMemberOf`. There is **no code path** that puts a non-member org into a session. | The cookie is HMAC-signed → a user cannot forge `orgId`. |
| **Switch boundary** | `switch-org` returns 403 unless `isMemberOf(user, orgId)`. | The only endpoint that mutates `activeOrgId`. |
| **Repository** | `FlatFileRepository` already filters `list`/`get`/`delete` by `session.orgId` and rejects cross-org `upsert` (the B2 IDOR guard). **Unchanged.** | Because the session can only carry a member org, the repo's existing `orgId` filter *is* the membership boundary. |
| **Audit** | `logWithSession` stamps `orgId` from the session; `GET /api/audit` filters by `session.orgId`. **Unchanged.** | Same reasoning. |
| **Permission check** | `requireAuthWithPermission` re-resolves role from the live membership; revoked membership → 401. | Revocation-safe. |

**Key insight:** the existing single-key scoping is *already* the isolation mechanism. Multi-org does not weaken it — it just guarantees (via signed cookie + member-only switch) that the single key is always a member org. **The IDOR surface is unchanged from today.**

### 5.2 The exact tests that prove the IDOR is closed

Given seed users:
- `only-A` — memberships `[{org-A, analyst}]`
- `both` — memberships `[{org-A, admin}, {org-B, analyst}]`

Records: dashboard `dash-B` owned in `org-B`.

**Test IDOR-1 — member-of-only-A can never reach B (no switch possible):**
1. Login `only-A` → session `orgId=org-A`.
2. `dashboardRepository.get(session, 'dash-B')` → `null` (cross-org read = not found). ✅
3. `dashboardRepository.upsert(session, {id:'dash-B', ...})` → `null` (B2 IDOR reject). ✅
4. `POST /api/auth/switch-org {orgId:'org-B'}` → **403** `not_a_member`. ✅ (cannot even become active on B)
5. `GET /api/audit` → returns only `org-A` events; zero `org-B` events. ✅

**Test IDOR-2 — member-of-both, active on A, cannot touch B's data without switching:**
1. Login `both` → active `org-A`.
2. `dashboardRepository.get(session, 'dash-B')` → `null`. ✅ (active org bounds the read even though the user *is* a B member)
3. `GET /api/audit` → only `org-A` events. ✅
4. `POST /api/auth/switch-org {orgId:'org-B'}` → 200; new session `orgId=org-B`, `role=analyst`.
5. Now `dashboardRepository.get(session, 'dash-B')` → the record. ✅ (access only after explicit switch)

**Test IDOR-3 — role is per active org:**
1. `both` active on A → `requireAuthWithPermission('admin:manage')` passes (admin in A).
2. Switch to B → same guard → **403** (analyst in B). ✅

**Test IDOR-4 — forged/stale cookie:**
1. Hand-craft a cookie with `orgId=org-B` for `only-A` (wrong HMAC) → `verifySession` returns null → 401. ✅
2. Revoke `both`'s `org-B` membership while a B-active session is live → next `requireAuthWithPermission` → 401 (membership gone). ✅

These four tests are the **gate**: no phase merges without IDOR-1 and IDOR-2 green.

---

## 6. Admin Provisioning & The Cross-Org Grant Question

### 6.1 The governance decision

A platform super-admin was **NOT** chosen; **memberships are the mechanism**. So we need a rule for *who may grant a membership in org-X*.

**Recommended smallest safe model:**

> **`admin:manage` is per-org.** A user may grant/revoke memberships **only in an org where their active session's effective role is `admin`.** To grant a membership in org-X, you must yourself be an admin of org-X (and be actively switched into it, since the effective role is per-active-org).

Consequences:
- The Ceiba consultant (admin in org-ceiba, analyst in org-demo) can add users to **org-ceiba** but **not** to org-demo — because they are only an analyst there.
- There is **no cross-org escalation**: you cannot mint yourself into an org you don't already administer.
- Bootstrapping a brand-new org (its first admin) is an **operational/seed action**, not a runtime endpoint — done by editing seed config / a one-off script, exactly as new orgs are created today. This keeps "no platform super-admin" honest: the app has no runtime path to unilaterally create cross-org admins.

### 6.2 New endpoint `POST /api/auth/memberships`

Gated by `requireAuthWithPermission(req, 'admin:manage')` — which, per Section 4, resolves admin-ness **for the active org**.

**Request:**
```json
{ "userId": "…", "orgId": "org-ceiba", "role": "analyst" }
```

**Server rules:**
1. `admin:manage` check passes → caller is admin of *their active org*.
2. **Enforce same-org:** `orgId` in the body **must equal `session.orgId`**. Reject `403 cross_org_grant` otherwise. (An org-ceiba admin can only grant memberships *into org-ceiba*.)
3. `grantMembership(userId, orgId, role)`.
4. Audit `MEMBERSHIP_GRANTED`.

**Revoke:** `DELETE /api/auth/memberships` `{ userId, orgId }` — same `orgId === session.orgId` rule; `revokeMembership` refuses to remove a user's last membership (returns null → `409`). Audit `MEMBERSHIP_REVOKED`.

### 6.3 `POST /api/auth/register` (change)

Still `admin:manage`. New users are created **in the admin's active org** with a single initial membership:

```ts
// orgId defaults to session.orgId; an explicit body.orgId MUST equal session.orgId
addUser({ email, password, name, membership: { orgId: session.orgId, role } })
```

Adding a *second* org to an existing user is done via `POST /api/auth/memberships`, not register.

---

## 7. Audit

Two new actions in the `AuditAction` union (`lib/auditLog.ts`):

```ts
export type AuditAction =
  | 'QUERY_RUN' | 'DATA_EXPORT_CSV' | 'DATA_EXPORT_EXCEL' | 'DATA_VIEW'
  | 'LOGIN' | 'LOGOUT' | 'LOGIN_FAILED' | 'QUERY_FAILED' | 'NARRATIVE_GENERATED'
  | 'ORG_SWITCH'            // NEW
  | 'MEMBERSHIP_GRANTED'    // NEW
  | 'MEMBERSHIP_REVOKED'    // NEW
```
(Also acceptable: `USER_CREATED` to replace the current `register` overloading of `LOGIN`.)

Auditing rules:
- **`ORG_SWITCH`** is logged with `orgId = the NEW active org`, `detail = "Switched from org-ceiba to org-demo (role admin→analyst)"`, `severity INFO`. This produces a clean, per-org trail: the switch event lands in the destination org's log, so an auditor reading org-demo's events sees exactly when this user entered.
- **`MEMBERSHIP_GRANTED` / `MEMBERSHIP_REVOKED`** logged with `orgId = the affected org` (= admin's active org, by the same-org rule), `severity WARNING` (privilege change), `detail` naming actor + subject + role.
- **All queries/exports remain attributed to `session.orgId`** — the active org. This is the safety *benefit* of one-active-org: every PHI touch in the log is unambiguously tied to a single tenant, with no membership-list ambiguity.

`getRecentAuditEvents(500, session.orgId)` and the hash chain are **unchanged**.

---

## 8. UI — Org Switcher

**Where:** `components/DataNav.tsx`, in the right-hand cluster next to the user avatar (before the sign-out button). Only rendered when `memberships.length > 1` (single-org users see nothing new — backward compatible).

**Data source:** the existing `GET /api/auth/me` fetch in `DataNav` (already wired). Extend the local `SessionUser` type to `{ id, email, name, memberships, defaultOrgId }` and read `activeOrgId`/`orgName` from the response.

**Component behavior (`OrgSwitcher`):**
- A `ChevronDown` pill showing the **active** `orgName` (from `me.orgName`).
- Dropdown lists each membership: `orgName` + a small role badge (reuse the `roleColor` map already in `DataNav`). The active org is checkmarked.
- Selecting another org → `POST /api/auth/switch-org { orgId }`:
  - On 200: `router.refresh()` (server components re-render under the new active org) and re-fetch `/api/auth/me`. All data on the page is now org-scoped to the new active org because the cookie changed.
  - On 403: toast "You are no longer a member of that organization" and re-fetch `/api/auth/me` (memberships may have changed).
- The active org name is also shown in the avatar `title` for at-a-glance context.

**Admin link derivation:** `showAdmin` currently derives from `sessionUser?.role === 'admin'`. Change to derive from `me.activeRole === 'admin'` so the Audit Log nav item appears/disappears correctly as the user switches orgs.

---

## 9. Interaction With the Python NL→SQL Service (Boundary Contract)

The TS route is the **only** component that understands memberships. When a TS route invokes the Python NL→SQL service, it resolves `{ userId, activeOrgId, role }` from the session (via `requireOrg` / `requireAuthWithPermission`) and passes **`activeOrgId` as the tenant context** — a single opaque tenant id.

**Contract:**
- The Python service receives **only** the resolved active org (`tenantId = session.orgId`) plus `userId`/`role` as needed for query shaping. It **never** receives the membership list.
- The service treats `tenantId` as an immutable scoping key for the request; it has no concept of "switching" and no way to widen scope.
- Org switching is a **TS-side, cookie-level** operation. The Python service is stateless w.r.t. identity and simply honours whatever single tenant the TS layer hands it per request.

This keeps the isolation invariant provable at the TS boundary: the service cannot leak across tenants because it is never told more than one tenant exists.

---

## 10. Phased, Tested Rollout

Each phase is independently mergeable and backward-compatible. Tests listed are the merge gate.

### Phase 1 — Data model + migration (backward compatible, no behavior change)
- Change `User`/`PublicUser`/`Membership` types; add `isMemberOf`, `roleInOrg`, `resolveActiveOrg`, `grantMembership`, `revokeMembership`, `setDefaultOrg`.
- Lazy idempotent migration in `readAll`/`ensureSeeded`; write-back once.
- Update `SEED_USERS` (+ one multi-org seed user); update `addUser` input.
- `toPublicUser` new shape.
- **`login` and `me` still return a working session** — `login` uses `resolveActiveOrg(user)` for a single-membership user (= their old org), stamps role via `roleInOrg`.
- **Tests:** migration idempotency (legacy JSON → memberships, second read no-ops); single-org seed user logs in and gets identical `orgId`/`role` as before; multi-org seed user logs in with default org active. **Gate: existing single-org user unaffected.**

### Phase 2 — Session activeOrgId semantics
- `login` stamps `orgId = resolveActiveOrg(user, body.orgId?)`, `role = roleInOrg(user, activeOrgId)`.
- `requireAuthWithPermission` re-resolves role from live membership (Section 2.3).
- No wire-format change; `repository.ts`/audit untouched.
- **Tests:** stale-cookie/revocation → 401; per-org role resolves in the guard. **Gate: IDOR-4 (revocation) green; repository test suite unchanged and green.**

### Phase 3 — Switch endpoint + RBAC-per-org
- `POST /api/auth/switch-org`; `GET /api/auth/me` returns memberships + activeOrgId/activeRole.
- Audit `ORG_SWITCH`.
- **Tests:** IDOR-1, IDOR-2, IDOR-3 (Section 5.2); switch to already-active org is a 200 no-op; switch to non-member → 403. **Gate: IDOR-1 + IDOR-2 + IDOR-3 green.**

### Phase 4 — Admin provisioning (memberships endpoint + register change)
- `POST /DELETE /api/auth/memberships` with the same-org rule; `register` scoped to active org.
- Audit `MEMBERSHIP_GRANTED`/`MEMBERSHIP_REVOKED`.
- **Tests:** org-ceiba admin can grant into org-ceiba; cross-org grant → 403; analyst-in-B cannot grant into B; cannot revoke last membership → 409. **Gate: cross_org_grant blocked; last-membership protected.**

### Phase 5 — UI switcher
- `OrgSwitcher` in `DataNav`; `showAdmin` from `activeRole`; single-org users unchanged.
- **Tests (Playwright):** multi-org user sees switcher, switches, page data re-scopes; single-org user sees no switcher; Audit Log nav toggles with active role.

---

## 11. Summary Table

| Phase | Files touched | Definition of Done | Gating safety test |
|---|---|---|---|
| **1. Data model + migration** | `lib/authStore.ts`, `data/users.json` (lazy, auto), `lib/permissions.ts` (unchanged, verified) | Types migrated; lazy idempotent migration writes back once; seed incl. 1 multi-org user; single-org login byte-identical to today | Single-org seed user's session `{orgId, role}` identical pre/post migration; migration idempotent |
| **2. Session activeOrgId** | `lib/session.ts` (doc/semantics only — wire shape unchanged), `lib/apiAuth.ts`, `app/api/auth/login/route.ts` | `orgId` = active org; role resolved from active membership; guard re-resolves live role | **IDOR-4** (revoked membership → 401); full `repository.ts` suite still green (unchanged) |
| **3. Switch + RBAC-per-org** | `app/api/auth/switch-org/route.ts` (new), `app/api/auth/me/route.ts`, `lib/auditLog.ts` (`ORG_SWITCH`) | Switch re-issues cookie, member-only, audited; `me` returns memberships + activeOrgId/activeRole | **IDOR-1, IDOR-2, IDOR-3** (Section 5.2) |
| **4. Admin provisioning** | `app/api/auth/memberships/route.ts` (new), `app/api/auth/register/route.ts`, `lib/auditLog.ts` (`MEMBERSHIP_*`), `lib/authStore.ts` (grant/revoke) | Membership grant/revoke gated by per-org `admin:manage`; same-org rule; last-membership protected; audited | Cross-org grant → 403 `cross_org_grant`; revoke-last → 409 |
| **5. UI switcher** | `components/DataNav.tsx` (+ `OrgSwitcher` sub-component) | Switcher shown iff >1 membership; switch re-scopes page; admin nav follows active role; single-org UI unchanged | Playwright: multi-org switch re-scopes data; single-org sees no switcher |
| **(boundary) Python NL→SQL** | *No TS code owns this beyond passing `session.orgId`* | Service receives only `tenantId = session.orgId` (+ userId/role); never the membership list | Service request carries exactly one tenant id; no membership leakage |

---

## 12. Backward-Compatibility Checklist (must all hold)

- [ ] `Session` type shape unchanged (`{ userId, orgId, role }`) — `repository.ts`, cache keys, `auditLog.ts`, `/api/audit` compile and behave identically.
- [ ] Session cookie wire format unchanged — no size growth, existing HMAC scheme, 8h TTL, `sessionCookieOptions()` untouched.
- [ ] Existing single-org users in `data/users.json` migrate to a single membership; their active org + role are exactly their old `orgId` + `role`.
- [ ] `middleware.ts` unchanged — still a coarse `verifySessionEdge` gate; no permission logic added.
- [ ] `hasPermission` / `ROLE_PERMISSIONS` unchanged — only the *input role* is now the active-membership role.
- [ ] Repository IDOR guards (`get` cross-org → null, `upsert` cross-org → null, `delete` cross-org → false) unchanged and still the enforcement point.
- [ ] The single tenant key `session.orgId` remains the sole scoping key everywhere downstream — multi-org changes only *how it is chosen*, not that there is exactly one.
