# Ceiba Data AI Explorer Agent

> AI-powered natural language data exploration for Ceiba Healthcare

![Next.js](https://img.shields.io/badge/Next.js-15-black?logo=next.js)
![TypeScript](https://img.shields.io/badge/TypeScript-5-blue?logo=typescript)
![Tailwind CSS](https://img.shields.io/badge/Tailwind-3-38bdf8?logo=tailwindcss)

---

## Overview

The **Ceiba Data AI Explorer Agent** is a clinical data assistant that lets healthcare
teams query, visualize, and interpret complex datasets using plain English — no SQL
required. It runs on Next.js 15 (App Router) with a dark-themed UI, a Gemini-style
animated chat interface, AI SQL generation, and interactive charting over a read-only
Trino data warehouse.

> **Status:** this is an early-stage prototype undergoing security/compliance
> remediation. It is **not cleared to handle real patient data** — see
> `PRODUCTION_READINESS_REPORT.md` for the current gate and open blockers. Do not point
> it at production PHI until the outstanding items (data residency, signed OpenAI BAA,
> durable audit/persistence) are resolved.

---

## Features

- **Natural language → SQL** — ask questions, get queries (AI-generated, run against Trino)
- **Auto-visualization** — charts generated from results (Recharts)
- **AI Chat Panel** — Gemini-style animated glow border, streaming responses
- **Query Templates** — pre-built clinical query library
- **Multi-tab SQL editor** — with syntax highlighting
- **Healthcare domain aware** — understands ICD, LOINC, patient flow
- **Dashboards & charts** — save, organize, and share within your organization
- **Audit log** — every login and (where wired) data action recorded (admin-visible)

---

## Getting Started

### Prerequisites

- Node.js **>= 20.19.0** (pinned via `engines` in `package.json`)
- A running Trino/Presto endpoint for live queries (optional for UI development)
- An OpenAI API key for the AI features (optional for non-AI development)

### Install & run

```bash
# Install dependencies from the committed lockfile (reproducible, CI-safe)
npm ci

# Copy the env template and fill in real values
cp .env.example .env.local
#   → set SESSION_SECRET (required) and, ideally, AUTH_SEED_PASSWORD
#   → node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"

# Run the development server
npm run dev

# Open in browser (default Next.js port)
open http://localhost:3000
```

> Use `npm ci` (not `npm install`) — it installs exactly what is in
> `package-lock.json` and is the same command CI runs. `npm ci` is green from a clean
> checkout.

### Other scripts

| Command | What it does |
|---|---|
| `npm run dev` | Start the Next.js dev server |
| `npm run build` | Production build |
| `npm run start` | Serve the production build |
| `npm run lint` | Lint with **oxlint** (`.oxlintrc.json`) |
| `npm test` | Run the **Vitest** unit/integration suite once |
| `npm run test:watch` | Vitest in watch mode |
| `npm run test:coverage` | Vitest with coverage |

Testing strategy (Vitest unit/integration + Playwright E2E) is documented in
[`docs/TEST_STRATEGY.md`](./docs/TEST_STRATEGY.md).

---

## Authentication

Authentication is a **local, self-contained RBAC system with organization (tenant)
scoping** — there is no external identity provider. Sessions are signed, `httpOnly`
cookies (HMAC-SHA256, 8-hour TTL).

### Logging in with seed users

On first run the app seeds a set of users into the gitignored `data/users.json` file,
across **two organizations** (so tenant isolation can be exercised). Their password is
taken from `AUTH_SEED_PASSWORD`; if that is unset a **dev-only** default
(`ChangeMe!DevSeed2026`, see `lib/authStore.ts`) is used.

| Email | Role | Org |
|---|---|---|
| `admin@ceiba-healthcare.com` | admin | `org-ceiba` (Ceiba Healthcare) |
| `analyst@ceiba-healthcare.com` | analyst | `org-ceiba` |
| `clinician@ceiba-healthcare.com` | clinician | `org-ceiba` |
| `admin@demo-hospital.test` | admin | `org-demo` (Demo Hospital) |
| `clinician@demo-hospital.test` | clinician | `org-demo` |

Sign in at `/sign-in`. Roles and permissions are defined in `lib/permissions.ts`.

### How organizations (tenants) work

Every user belongs to exactly one organization (`orgId`), which is the **tenant key**.
It travels inside the signed session and is used to scope all dashboards, charts, and
audit records: users only ever see records for their own org (and, for owner-private
entities, their own records). All org/owner enforcement lives in one place —
`lib/repository.ts` — so route handlers never issue an unscoped read or write.

### Provisioning users (invite-only)

Self sign-up is **disabled**. Only an authenticated **admin** (`admin:manage`
permission) can create users, via `POST /api/auth/register`. New users are created in
the admin's own org by default (an explicit `orgId` may be supplied to place them in
another org). See [`docs/USER_MANAGEMENT.md`](./docs/USER_MANAGEMENT.md) for the full
flow.

---

## Project Structure

```
data-ai-explorer/
├── app/                      # Next.js App Router
│   ├── api/                  # API route handlers
│   │   ├── auth/             # login / logout / me / register (local RBAC)
│   │   ├── query/            # SQL execution against Trino
│   │   ├── narrative/ chat/ chart-suggest/ sql-generate/   # AI routes
│   │   ├── dashboards/ audit/ ...
│   ├── data-explorer/        # Main explorer page
│   ├── dashboards/           # Saved dashboards
│   └── sign-in/              # Local sign-in page
├── components/
│   ├── DataExplorer/         # ChatPanel, SqlPanel, ChartPreview, QueryTemplates
│   └── Sidebar/
├── lib/
│   ├── apiAuth.ts            # server-side auth guards (requireAuth / *WithPermission)
│   ├── session.ts            # signed httpOnly cookie sessions (HMAC-SHA256)
│   ├── authStore.ts          # local user + org store (bcrypt hashes, seed users)
│   ├── permissions.ts        # RBAC role → permission matrix
│   ├── repository.ts         # THE data-access seam — all org/owner scoping lives here
│   ├── domain.ts             # canonical Chart / Dashboard domain types
│   ├── validation.ts         # zod body schemas + parseBody + body-size guard
│   ├── errors.ts             # standard error envelope + safeError
│   ├── rateLimiter.ts        # per-user+route rate limiting
│   ├── auditLog.ts           # hash-chained audit log (org-scoped)
│   └── trinoClient.ts        # read-only Trino client
├── middleware.ts             # coarse auth gate (session present? → allow / 401 / redirect)
├── docs/                     # ARCHITECTURE, USER_MANAGEMENT, TEST_STRATEGY, ...
├── styles/globals.css        # global styles incl. gemini-glow animation
└── MASTER_PROMPT.md          # Agent system prompt & behavioral spec
```

---

## Toolchain

- **Framework:** Next.js 15 (App Router), React 18, TypeScript 5
- **Linter:** [oxlint](https://oxc.rs/) — config in `.oxlintrc.json`
- **Tests:** Vitest (unit/integration) + Playwright (E2E) — see `docs/TEST_STRATEGY.md`
- **Validation:** zod (request-body schemas in `lib/validation.ts`)
- **Auth:** local RBAC — bcryptjs for password hashing, `node:crypto` HMAC for sessions

---

## Documentation

- [`docs/ARCHITECTURE.md`](./docs/ARCHITECTURE.md) — current-state architecture (auth, tenancy, trust boundary, persistence, AI egress)
- [`docs/USER_MANAGEMENT.md`](./docs/USER_MANAGEMENT.md) — users, orgs, roles, provisioning
- [`docs/TEST_STRATEGY.md`](./docs/TEST_STRATEGY.md) — test strategy
- [`SECURITY.md`](./SECURITY.md) — security controls, secrets, BAA/residency gate
- [`MASTER_PROMPT.md`](./MASTER_PROMPT.md) — agent specification
- [`PRODUCTION_READINESS_REPORT.md`](./PRODUCTION_READINESS_REPORT.md) — audit findings & remediation plan

---

## UI — Gemini Glow Effect

The chat input features a rotating conic-gradient border inspired by Google Gemini:

| State | Speed | Opacity |
|-------|-------|---------|
| Idle | 8s/cycle | 45% |
| Focused | 4s/cycle | 80% |
| Streaming (AI responding) | 1.8s/cycle | 100% |

Colors are configurable via CSS variables in `globals.css`:
```css
:root {
  --glow-c1: #4c8dff;  /* blue        */
  --glow-c2: #7c68ff;  /* purple      */
  --glow-c3: #c084fc;  /* pink-violet */
  --glow-c4: #22d3ee;  /* cyan        */
}
```

Respects `prefers-reduced-motion`. Safari 15.4+ supported via `@property`.

---

## Built by Ceiba Healthcare
