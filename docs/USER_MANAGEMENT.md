# User Management — Local RBAC

> The application uses a **local, self-contained RBAC system** with organization
> (tenant) scoping. There is **no external identity provider** (no Clerk, no
> dashboard). Users, organizations, roles, and passwords are all managed in-app.
>
> Source of truth in code:
> - `lib/authStore.ts` — user + organization store (bcrypt password hashes)
> - `lib/permissions.ts` — role → permission matrix
> - `lib/session.ts` — signed cookie sessions
> - `lib/apiAuth.ts` — server-side auth/permission guards
> - `app/api/auth/*` — login / logout / me / register routes

---

## Where users live

Users are stored as JSON in **`data/users.json`**, which is under the gitignored
`data/` directory (it holds bcrypt credential hashes — never commit it). Each user
record is:

```jsonc
{
  "id": "uuid",
  "email": "user@example.com",   // stored lowercased
  "passwordHash": "bcrypt-hash", // never plaintext
  "role": "admin" | "analyst" | "clinician",
  "orgId": "org-ceiba",          // tenant key — every user belongs to exactly one org
  "name": "Display Name",
  "createdAt": "ISO-8601"
}
```

`data/users.json` is created and **seeded automatically on first use** if it is
missing/empty (see "Seed users" below). It is server-only — never import `authStore`
from a client component.

---

## Organizations (tenants)

Every user belongs to exactly one **organization**, identified by `orgId`. The `orgId`
is the tenant key: it is copied into the signed session at login and is used to scope
all dashboards, charts, and audit records (see `docs/ARCHITECTURE.md`).

Organizations are **implicit** in this interim implementation — an org "exists" simply
because one or more users reference its `orgId`. There is no separate orgs table.
Human-readable display names live in the `ORG_REGISTRY` map in `lib/authStore.ts`:

| `orgId` | Display name |
|---|---|
| `org-ceiba` | Ceiba Healthcare |
| `org-demo` | Demo Hospital |

**To add a new organization:** create a user with a new `orgId` (see "Adding a user"),
and — for a friendly display name — add the id to `ORG_REGISTRY` in `lib/authStore.ts`.

---

## Roles & Permissions

Roles and their permissions are defined **exactly** in `lib/permissions.ts`. There are
three roles and ten permissions.

| Permission | `admin` | `analyst` | `clinician` |
|---|:---:|:---:|:---:|
| `query:run` — run SQL queries | ✅ | ✅ | ✅ |
| `query:export` — export CSV / Excel | ✅ | ✅ | — |
| `narrative:generate` — AI narrative generation | ✅ | ✅ | ✅ |
| `dashboard:read` — view dashboards | ✅ | ✅ | ✅ |
| `dashboard:write` — create / edit dashboards | ✅ | ✅ | — |
| `chart:write` — create / edit charts | ✅ | ✅ | — |
| `alert:write` — create / edit alerts | ✅ | ✅ | — |
| `report:write` — create / edit reports | ✅ | ✅ | — |
| `audit:read` — view the audit log | ✅ | — | — |
| `admin:manage` — user management (provision users) | ✅ | — | — |

Summary:

- **`admin`** — every permission, including `audit:read` and `admin:manage` (the only
  role that can provision users and read the audit log).
- **`analyst`** — full data/authoring access (`query:run`, `query:export`,
  `narrative:generate`, `dashboard:read`/`write`, `chart:write`, `alert:write`,
  `report:write`) but **no** `audit:read` and **no** `admin:manage`.
- **`clinician`** — read/run only: `query:run`, `narrative:generate`, `dashboard:read`.
  Cannot export, cannot author dashboards/charts/alerts/reports, cannot manage users or
  read audit.

Enforcement: `hasPermission(role, permission)` / `requirePermission(role, permission)`
in `lib/permissions.ts`, surfaced to routes via `requireAuthWithPermission(req,
permission)` in `lib/apiAuth.ts` (403 on failure). RBAC is enforced **server-side** in
route handlers, not only in the UI.

---

## Sessions

- A session is a JSON payload `{ userId, orgId, role, iat, exp }` encoded base64url and
  signed with **HMAC-SHA256** using `SESSION_SECRET`. The signed cookie *is* the session
  (stateless — there is no server-side session table).
- Cookie name: `ceiba_session`. Flags: `httpOnly` (JS can never read it), `SameSite=Lax`,
  `Secure` in production, `Path=/`.
- **TTL: 8 hours** (a clinical work shift), enforced by the `exp` claim on every read.
- The signature is verified with a constant-time comparison on every request. Middleware
  verifies it on the Edge runtime (`verifySessionEdge`); route handlers verify it on the
  Node runtime (`verifySession`) — same signing scheme.
- **Rotating `SESSION_SECRET` invalidates all existing sessions.**

> There is no idle/inactivity timeout and no MFA in this interim system (both are
> **planned, not yet implemented** — see `docs/ARCHITECTURE.md` "Known-deferred items").

---

## Seed users

On first use (empty/missing `data/users.json`) the store seeds five users across two
orgs so tenant isolation can be tested. All seeded users share the password from
`AUTH_SEED_PASSWORD`; if that env var is unset, a **dev-only** default is used
(`ChangeMe!DevSeed2026`, defined as `DEV_SEED_PASSWORD` in `lib/authStore.ts`).

| Email | Role | Org |
|---|---|---|
| `admin@ceiba-healthcare.com` | admin | `org-ceiba` |
| `analyst@ceiba-healthcare.com` | analyst | `org-ceiba` |
| `clinician@ceiba-healthcare.com` | clinician | `org-ceiba` |
| `admin@demo-hospital.test` | admin | `org-demo` |
| `clinician@demo-hospital.test` | clinician | `org-demo` |

**In staging/production always set `AUTH_SEED_PASSWORD`** to a strong value and rotate
the seeded accounts. The dev default is clearly not a real secret and must never be used
with real data.

---

## Adding a user (invite-only)

Self sign-up is **intentionally disabled** for this clinical app. Only an authenticated
**admin** (holding `admin:manage`) can create users, through the register endpoint:

```
POST /api/auth/register
Content-Type: application/json
Cookie: ceiba_session=<admin session cookie>

{
  "email":    "new.user@ceiba-healthcare.com",
  "password": "at-least-8-characters",
  "name":     "New User",
  "role":     "analyst",          // admin | analyst | clinician
  "orgId":    "org-ceiba"          // optional — defaults to the admin's own org
}
```

Behavior (`app/api/auth/register/route.ts`):
- Requires `admin:manage` (401 if unauthenticated, 403 if not an admin).
- Validates the body: `email`, `password`, `name`, `role` required; `role` must be one
  of `admin`/`analyst`/`clinician`; `password` must be **≥ 8 characters**.
- New users default into the **creating admin's org** unless an explicit `orgId` is given
  (this is how you place a user into a different tenant).
- The password is hashed with bcrypt before storage. Returns `201` with the public user
  (no password hash), or `409` if the email already exists.
- The action is recorded in the audit log.

There is currently **no self-service password reset or account-disable UI**. To reset a
password or remove a user in this interim system, an operator edits `data/users.json`
directly (re-hash with bcrypt for a new password, or remove the record) or re-seeds.
Managed self-service flows are planned for the durable-datastore milestone.

---

## Logging in / out

- `POST /api/auth/login` with `{ email, password }` → verifies against bcrypt, sets the
  signed `ceiba_session` cookie, returns the public user. Failures return `401` with a
  non-enumerating message and are audit-logged (`LOGIN_FAILED`).
- `POST /api/auth/logout` → clears the session cookie.
- `GET /api/auth/me` → returns the current session's user, or `401` if not signed in.
- Sign in through the UI at **`/sign-in`**.
