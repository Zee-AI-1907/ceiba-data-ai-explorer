# SECURITY.md — Ceiba Data AI Explorer

> **Classification:** CONFIDENTIAL — Internal Use Only  
> **Last Updated:** 2026-07-09  
> **Owner:** Security & Compliance Team

> **Status honesty:** this app is an early-stage prototype under active remediation and
> is **not cleared for real patient data**. This document describes what is **actually
> implemented** vs **planned**. Do not read any control below as complete unless it says
> so. The authoritative gap analysis is `PRODUCTION_READINESS_REPORT.md`.

---

## Authentication & Access Control (implemented)

- **Local RBAC** — self-contained; no external identity provider. Credentials are bcrypt
  hashes in the gitignored `data/users.json` (`lib/authStore.ts`).
- **Sessions** — signed `httpOnly` cookies (HMAC-SHA256 over `SESSION_SECRET`), 8-hour
  TTL, `SameSite=Lax`, `Secure` in production; signature verified constant-time on every
  request (`lib/session.ts`). Stateless — the signed cookie is the session.
- **RBAC** — three roles (`admin`/`analyst`/`clinician`) → ten permissions
  (`lib/permissions.ts`), enforced **server-side** in route handlers via
  `requireAuthWithPermission` (`lib/apiAuth.ts`). See `docs/USER_MANAGEMENT.md`.
- **Multi-tenancy** — org (`orgId`) + owner scoping enforced in a single data-access seam
  (`lib/repository.ts`); cross-tenant reads return not-found, cross-tenant writes/deletes
  are rejected. See `docs/ARCHITECTURE.md`.
- **Invite-only provisioning** — self sign-up disabled; only `admin:manage` can create
  users (`POST /api/auth/register`).

**Not yet implemented (planned):** MFA, an idle/inactivity session timeout (only the
8-hour absolute TTL exists), and a shared multi-instance rate-limit store. Do not
represent MFA or a 15-minute timeout as active.

---

## 🔑 Secrets

The full env var contract is in `.env.example`. Never commit `.env.local`,
`.env.production`, or `.env.staging` (all gitignored). For production, load secrets from
a secrets manager (AWS Secrets Manager / Vault / Doppler). See `SECRET_ROTATION.md`.

### 1. Session signing key (`SESSION_SECRET`) — **required**
- **Purpose:** signs/verifies the session cookie (HMAC-SHA256). The app will not sign or
  verify sessions without it; it must be ≥ 16 chars.
- **Generate:** `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`
- **Rotation impact:** rotating it **invalidates all active sessions** (forces re-login).
- **Production target:** AWS Secrets Manager / Vault / deployment env vars.

### 2. Seed-user password (`AUTH_SEED_PASSWORD`)
- **Purpose:** password applied to the seeded users created on first run into
  `data/users.json`. If unset, a **dev-only** default is used (`lib/authStore.ts`) — never
  acceptable outside local dev.
- **Action:** always set a strong value in staging/production and rotate the seeded
  accounts.

### 3. OpenAI API Key (`OPENAI_API_KEY`)
- **Purpose:** AI features (SQL generation, narratives, chart suggestions, chat).
- **Status:** rotate on any suspected exposure. See `SECRET_ROTATION.md`.
- **Constraint:** requires a signed BAA before any PHI-adjacent use (see below).

### 4. Trino connection (`TRINO_HOST`, `TRINO_PORT`, `TRINO_USER`, catalogs)
- **Status:** ensure the `readonly` service account has **SELECT-only** grants at the
  source DB and connector — verified read-only enforcement is a hardening item, not
  assumed complete.
- **Action:** verify database-level read-only enforcement; rotate on a 90-day cycle.

> There is **no** NextAuth, Clerk, or Stripe secret in this app — those subsystems were
> removed. If you see `NEXTAUTH_SECRET`, `CLERK_SECRET_KEY`, `NEXT_PUBLIC_CLERK_*`, or
> `STRIPE_*` referenced anywhere, it is stale and should be removed.

---

## 🏥 BAA & Data-Residency Gate

### OpenAI Business Associate Agreement (BAA)
- **Required before:** processing any real patient PHI through the AI features.
- **How to obtain:** OpenAI Enterprise Agreement — contact enterprise@openai.com.
- **Current status:** ⚠️ **NOT SIGNED** — do not process real PHI through AI features.
- **Egress model:** AI routes are intended to send **schema + aggregates only, never
  row-level PHI**, and to be gated behind an `OPENAI_BAA_SIGNED` flag so they refuse to
  call OpenAI until a BAA is in place. **This BAA gate is currently being finalized** by
  the AI-egress workstream. Column-name masking (`lib/phiScrubber.ts`) is best-effort
  only and is **not** a compliance boundary.
- **Reference:** HIPAA 45 CFR § 164.502(e).

### Data residency (KVKK cross-border) — **unresolved blocker (N1)**
- There is **no** data-residency control implemented. Turkish PHI egressing to US-region
  OpenAI/Vercel has **no KVKK cross-border basis** established.
- A signed OpenAI BAA does **not** cure a residency violation. Establish the TR/EU
  residency requirement and in-region hosting/model endpoint (or send no row-level PHI
  off-region) **before** any real PHI is processed.

---

## 🔒 Production Secrets Management

### Recommended: AWS Secrets Manager
```bash
aws secretsmanager create-secret \
  --name ceiba/session-secret \
  --secret-string '{"SESSION_SECRET":"<hex>"}'
aws secretsmanager get-secret-value --secret-id ceiba/session-secret
```

### Alternative: deployment platform env vars
Set secrets in your platform's environment configuration. Never commit `.env.local`.

### Alternative: HashiCorp Vault
For self-hosted/on-prem deployments, use Vault with AppRole or Kubernetes auth.

---

## 🚨 Security Incident Contact

| Role | Contact |
|------|---------|
| Security Officer | security@ceiba.com |
| Privacy Officer | privacy@ceiba.com |
| HIPAA Compliance | compliance@ceiba.com |
| Emergency (24/7) | oncall@ceiba.com |

**For a suspected breach:**
1. Immediately notify the Security Officer.
2. Preserve all logs (the audit log file written by `lib/auditLog.ts`).
3. Do NOT delete or modify any files.
4. HIPAA breach notification must be filed within **60 days** of discovery
   (45 CFR § 164.400–414).

> Note: the current audit log is a **local hash-chained file** and is not yet a durable,
> externally-anchored/WORM sink — that is a Phase-1 item. Treat local logs as
> best-effort until the durable sink lands.

---

## 📋 HIPAA / KVKK Readiness Checklist

- [ ] OpenAI BAA signed before enabling AI features with real PHI
- [ ] `OPENAI_BAA_SIGNED` egress gate finalized and enabled (AI routes refuse without it)
- [ ] Data residency (KVKK cross-border) resolved — in-region hosting/model endpoint (N1)
- [ ] `SESSION_SECRET` and `AUTH_SEED_PASSWORD` set from a secrets manager, seeded users rotated
- [ ] `OPENAI_API_KEY` rotated and stored in a secrets manager
- [ ] `.env.local` removed from development machines once deployed
- [ ] Durable, externally-anchored audit sink in place (replace local hash-chained file)
- [ ] Durable Postgres persistence (replace flat-file store)
- [ ] MFA and idle session timeout implemented
- [ ] Penetration test scheduled

---

## 🛡️ Security Headers (applied)

Set in `next.config.js` for all routes:

| Header | Purpose |
|--------|---------|
| `X-Frame-Options: DENY` | Clickjacking protection |
| `X-Content-Type-Options: nosniff` | MIME sniffing prevention |
| `Referrer-Policy: strict-origin-when-cross-origin` | PHI-in-referrer prevention |
| `X-XSS-Protection: 1; mode=block` | XSS filter (legacy browsers) |
| `Permissions-Policy` | Browser API restriction |
| `Strict-Transport-Security` | HTTPS enforcement |
| `Content-Security-Policy` | XSS / injection mitigation (see `next.config.js`) |

> CSP hardening (removing blanket `unsafe-eval`/`unsafe-inline` in favor of nonce/hash) is
> a tracked hardening item in `PRODUCTION_READINESS_REPORT.md`.

---

*Review this document quarterly or after any security incident.*
