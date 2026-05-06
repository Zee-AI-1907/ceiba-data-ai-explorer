# SECURITY.md — Ceiba Data AI Explorer

> **Classification:** CONFIDENTIAL — Internal Use Only  
> **Last Updated:** 2026-05-07  
> **Owner:** Security & Compliance Team

---

## 🔑 Secrets That Need Rotation

### 1. OpenAI API Key (`OPENAI_API_KEY`)
- **Current location:** `.env.local`
- **Status:** ⚠️ ROTATE IMMEDIATELY — key was visible in compliance audit report
- **Action:**
  1. Go to https://platform.openai.com/api-keys
  2. Revoke the existing key
  3. Generate a new key
  4. Update `.env.local` (dev) and your secrets manager (production)
- **Production target:** AWS Secrets Manager / Vercel Environment Variables

### 2. NextAuth Secret (`NEXTAUTH_SECRET`)
- **Current location:** `.env.local`
- **Status:** ⚠️ Rotate if `.env.local` was ever shared or committed
- **Action:**
  ```bash
  openssl rand -base64 32
  ```
  Replace in `.env.local` and all deployment environments.
- **Production target:** AWS Secrets Manager / Vercel Environment Variables

### 3. Trino Credentials (`TRINO_USER`, `TRINO_HOST`)
- **Current location:** `.env.local`
- **Status:** Review — ensure `readonly` user has only SELECT permissions
- **Action:** Verify database-level read-only enforcement; rotate password on a 90-day cycle

---

## 🏥 BAA Requirements

### OpenAI Business Associate Agreement (BAA)
- **Required before:** Processing any real patient PHI through AI narrative/chat features
- **How to obtain:** OpenAI Enterprise Agreement — contact enterprise@openai.com
- **Current status:** ⚠️ NOT SIGNED — do not use production PHI data until BAA is in place
- **Reference:** HIPAA 45 CFR § 164.502(e)

---

## 🔒 Moving to Production Secrets Management

### Recommended: AWS Secrets Manager

```bash
# Store a secret
aws secretsmanager create-secret \
  --name ceiba/openai-api-key \
  --secret-string '{"OPENAI_API_KEY":"sk-..."}'

# Retrieve at runtime (IAM role-based access)
aws secretsmanager get-secret-value --secret-id ceiba/openai-api-key
```

### Alternative: Vercel Environment Variables
For Vercel deployments, set secrets in the Vercel Dashboard → Project → Settings → Environment Variables. Never commit `.env.local` with real keys.

### Alternative: HashiCorp Vault
For self-hosted or on-premise deployments, use Vault with AppRole or Kubernetes auth.

---

## 🚨 Security Incident Contact

| Role | Contact |
|------|---------|
| Security Officer | security@ceiba.com |
| Privacy Officer | privacy@ceiba.com |
| HIPAA Compliance | compliance@ceiba.com |
| Emergency (24/7) | oncall@ceiba.com |

**For a suspected breach:**
1. Immediately notify the Security Officer
2. Preserve all logs (`logs/audit.log`)
3. Do NOT delete or modify any files
4. HIPAA breach notification must be filed within **60 days** of discovery (45 CFR § 164.400–414)

---

## 📋 HIPAA Compliance Checklist

- [ ] OpenAI BAA signed before enabling AI features with real PHI
- [ ] NEXTAUTH_SECRET rotated and stored in secrets manager
- [ ] OPENAI_API_KEY rotated and stored in secrets manager
- [ ] `.env.local` removed from development machines once deployed
- [ ] Audit logs shipped to tamper-evident SIEM
- [ ] Penetration test scheduled
- [ ] KVKK cross-border data transfer authorization obtained (if Turkish patient data)

---

## 🛡️ Security Headers (Applied)

The following headers are set in `next.config.js` for all routes:

| Header | Value | Purpose |
|--------|-------|---------|
| `X-Frame-Options` | `DENY` | Clickjacking protection |
| `X-Content-Type-Options` | `nosniff` | MIME sniffing prevention |
| `Referrer-Policy` | `strict-origin-when-cross-origin` | PHI in referrer prevention |
| `X-XSS-Protection` | `1; mode=block` | XSS filter (legacy browsers) |
| `Permissions-Policy` | `camera=(), microphone=(self), geolocation=()` | Browser API restriction |
| `Strict-Transport-Security` | `max-age=63072000; includeSubDomains; preload` | HTTPS enforcement |
| `Content-Security-Policy` | See `next.config.js` | XSS / injection mitigation |

---

*This document should be reviewed quarterly or after any security incident.*
