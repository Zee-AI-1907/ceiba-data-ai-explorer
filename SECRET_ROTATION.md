# Secret Rotation & Git History Purge — Action Required

**Status:** OPEN — requires a human with account access and repo-admin rights.
**Created:** 2026-07-08 (Phase 0 remediation, Workstream B — Secrets & Git Hygiene)
**Related findings:** PRODUCTION_READINESS_REPORT.md N2, H16; COMPLIANCE_REPORT.md H-006, H-012.

---

## Why this document exists

Several real secrets were committed to `COMPLIANCE_REPORT.md` and are present in
this repository's **git history**. Workstream B redacted them from the *working
tree*, but **redaction in the current commit does NOT remove them from history** —
anyone with repo access can still recover the original values with:

```bash
git log -p -- COMPLIANCE_REPORT.md      # shows every past version, including secrets
git show 4b79496:COMPLIANCE_REPORT.md   # shows the file at the commit that carried the secrets
```

Therefore every secret below must be treated as **compromised** and **rotated**,
AND the history must be **purged** (separate, human-authorized step — see bottom).

---

## 1. Rotation checklist (do these FIRST — before any history rewrite)

Rotating first means that even if the old values are recovered from history
before the purge completes, they are already dead.

- [ ] **OpenAI API key** — `OPENAI_API_KEY`
  - Leaked value: `sk-proj-orw1py7...` (COMPLIANCE_REPORT.md:340, :872) — **format: `sk-proj-...`**
  - Action: Revoke the key at https://platform.openai.com/api-keys, create a new
    one, and store it in the secrets manager (NOT in a committed file).
  - Also confirm a signed **BAA + DPA** with OpenAI is in place before PHI-adjacent use.

- [ ] **NextAuth signing secret** — `NEXTAUTH_SECRET`
  - Leaked value: `Os/+nL0tN9...` (COMPLIANCE_REPORT.md:341)
  - Action: Generate a new secret (`openssl rand -base64 32`) and update the
    deployment. NOTE: auth has since migrated to **Clerk** (see below); if
    NextAuth is fully removed, this variable may no longer be used — verify and
    delete it from all environments rather than rotating.

- [ ] **Shared login password** — `ceiba2026`
  - Leaked value: `ceiba2026` (COMPLIANCE_REPORT.md:254-258, :261) — shared by all
    three seeded users (`afsin@ceiba.com`, `ege@ceiba.com`, `clinical@ceiba.com`).
  - Action: This credential is **burned**. Since auth migrated to Clerk, ensure
    the old hardcoded `USERS` array / `lib/auth.ts` seed is removed, and that no
    Clerk user still uses this password. Force a password reset for any real
    account that ever used it. Retire `ceiba2026` everywhere.

- [ ] **Clerk keys** — `CLERK_SECRET_KEY`, `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY`
  - Not known to be leaked in git history, but **verify** they were never
    committed in any local `.env*` file that got pushed. If in doubt, rotate the
    Clerk secret key from https://dashboard.clerk.com (Configure → API Keys).

- [ ] **Stripe keys** — `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`
  - Not known to be leaked, but confirm no live (`sk_live_` / `whsec_`) value was
    ever committed. If any was, roll it in the Stripe Dashboard immediately.

> After rotation, store all new values in a secrets manager (AWS Secrets Manager,
> HashiCorp Vault, or Doppler). Never re-commit them. `.env.example` documents the
> variable names with placeholders only.

---

## 2. Git history purge — DOCUMENTED, NOT EXECUTED

> ⚠️ **DANGER — DO NOT RUN WITHOUT HUMAN AUTHORIZATION AND TEAM COORDINATION.**
> `git filter-repo` **rewrites history**: every commit hash after the earliest
> touched commit changes. This requires a **force-push** and **every collaborator
> must re-clone or hard-reset** their local copy afterward. Any open PRs/branches
> based on the old history will need to be rebased or recreated. Coordinate a
> maintenance window and notify all contributors before proceeding.

**Prerequisites**
1. All secrets above have been ROTATED (dead keys are harmless if recovered).
2. `git filter-repo` is installed (`brew install git-filter-repo` /
   `pip install git-filter-repo`). It is NOT the same as `git filter-branch`.
3. A **full backup mirror** exists: `git clone --mirror <repo-url> repo-backup.git`.
4. Everyone has pushed/merged outstanding work; the team is ready for a rewrite.

**Step-by-step (run from a fresh, clean clone of the repo):**

```bash
# 0. Fresh mirror-style working clone and a backup.
git clone <repo-url> ceiba-purge && cd ceiba-purge
git clone --mirror <repo-url> ../ceiba-backup.git   # keep this backup safe

# 1. Create a replacements file mapping each leaked secret -> redaction marker.
#    literal:VALUE matches the exact string anywhere in history.
cat > /tmp/secret-replacements.txt <<'EOF'
literal:sk-proj-orw1py7DIUFAhtvyuJUPDyRxzE82PsFbDXyGSR6B7yP1Fdbp_==><REDACTED-OPENAI-KEY>
literal:Os/+nL0tN9mYc2MtGmj34rR518NSolwY5AP49HBsY50===><REDACTED-NEXTAUTH-SECRET>
literal:ceiba2026==><REDACTED-PASSWORD>
EOF

# 2. Rewrite ALL history, replacing the secret strings in every blob.
#    --force is required because filter-repo refuses to run on a non-fresh clone.
git filter-repo --replace-text /tmp/secret-replacements.txt --force

# 3. Inspect the result — the secrets must be gone from every past version.
git log -p -- COMPLIANCE_REPORT.md | grep -E 'sk-proj-orw1py7|Os/\+nL0tN9|ceiba2026' && \
  echo "STILL PRESENT — DO NOT PUSH" || echo "clean"

# 4. Re-add the remote (filter-repo drops it) and force-push all refs + tags.
#    COORDINATE FIRST. This is the irreversible, team-affecting step.
git remote add origin <repo-url>
git push origin --force --all
git push origin --force --tags

# 5. Delete the temp replacements file (it contains the plaintext secrets).
shred -u /tmp/secret-replacements.txt 2>/dev/null || rm -f /tmp/secret-replacements.txt
```

**After the push:**
- [ ] Notify every collaborator to **re-clone** (or `git fetch` + `git reset --hard origin/<branch>`).
- [ ] Ask the git host (GitHub/GitLab/Azure DevOps) to **expire cached views** and
      garbage-collect: on GitHub, old commits may linger in the API/forks —
      open a support request to purge cached/forked copies if the leak is severe.
- [ ] Invalidate any PR that referenced the old commit SHAs.
- [ ] Re-run the secret scanner against the rewritten history:
      `gitleaks detect --config .gitleaks.toml --redact`.
- [ ] Securely delete the backup mirror once the rewrite is verified good.

---

## 3. Preventing recurrence
- Secrets now blocked pre-merge by CI: `.github/workflows/secret-scan.yml` +
  `.gitleaks.toml` (default rules + placeholder allowlist).
- `.gitignore` now ignores `.data/`, `.qa-reports/`, and all `.env*` except
  `.env.example`.
- Consider a local pre-commit hook: `gitleaks protect --staged --redact`.
- Move all runtime secrets into a secrets manager; keep only `.env.example`
  (placeholders) in the repo.
