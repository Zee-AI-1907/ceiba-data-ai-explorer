# User Management — Clerk Dashboard

## Adding a New User
1. Go to [dashboard.clerk.com](https://dashboard.clerk.com)
2. Click **Users** → **Invite User**
3. Enter email — Clerk sends an invite with password setup link
4. After they sign up, click their name → **Public Metadata**
5. Set their role:
   ```json
   {"role": "admin"}
   ```
   Available roles: `"admin"` | `"analyst"` | `"clinician"`

## Resetting a Password
1. [dashboard.clerk.com](https://dashboard.clerk.com) → **Users** → select user
2. Click **"Reset password"** → Clerk emails them a reset link

## Disabling / Removing a User
1. [dashboard.clerk.com](https://dashboard.clerk.com) → **Users** → select user
2. Click **"Delete user"** to permanently remove, or toggle to inactive/locked

## MFA Setup
- Clerk enforces MFA automatically for all users
- Users set up their authenticator app on first login
- You can require MFA for all users in:
  `dashboard.clerk.com → Configure → MFA`

## Session Duration
- Configure in: `dashboard.clerk.com → Configure → Sessions`
- Recommended: **15 minutes inactivity timeout** for HIPAA compliance

## Viewing Active Sessions
- `dashboard.clerk.com → Users → select user → Active Sessions`
- You can revoke individual sessions from this view

## Roles & Permissions

| Role        | Capabilities                                                 |
|-------------|--------------------------------------------------------------|
| `admin`     | Full access: audit log, billing, all data, user management  |
| `analyst`   | Data explorer, SQL, dashboards, charts, reports              |
| `clinician` | Read-only data views, dashboards, alerts                     |

## Setting Roles via API (optional)
Use Clerk's Backend API to set roles programmatically:
```bash
curl -X PATCH https://api.clerk.com/v1/users/<USER_ID>/metadata \
  -H "Authorization: Bearer $CLERK_SECRET_KEY" \
  -H "Content-Type: application/json" \
  -d '{"public_metadata": {"role": "analyst"}}'
```
