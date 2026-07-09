"""auth.py — internal service auth (docs/PYTHON_NL2SQL_SERVICE_PLAN.md §2.1
"Service auth (TS -> Python)").

The service trusts a shared internal Bearer token from
`NL2SQL_SERVICE_TOKEN` (present in both the TS process and this one). Any
request to a protected route without the EXACT token (constant-time compare)
is rejected 401. This is a *service* credential, not a user credential —
`tenantId`/`context` in the request body is trusted-but-scoped data from the
already-authenticated TS caller, never re-authorized here (§2.1, §2.5).

`/healthz` and `/readyz` are intentionally NOT behind this check (§7.2: "
`/readyz` does not require the token so orchestration health checks don't
depend on it") — they carry no tenant data and orchestration probes must not
need a secret to determine liveness/readiness.
"""

from __future__ import annotations

import hmac

from fastapi import Header, HTTPException

from ceiba_nl2sql_service.settings import Settings, get_settings


def require_internal_token(authorization: str | None = Header(default=None)) -> None:
    """FastAPI dependency: raises 401 if the Authorization header does not
    carry the exact configured `NL2SQL_SERVICE_TOKEN` as a Bearer token.
    Constant-time compare (hmac.compare_digest) so a timing side-channel
    cannot leak the token byte-by-byte.
    """
    settings: Settings = get_settings()
    expected = settings.nl2sql_service_token

    if not expected:
        # Fail closed: an unconfigured token means this service must never
        # accept ANY request claiming to be the trusted TS caller — a
        # misconfiguration must not silently degrade into "open to anyone".
        raise HTTPException(status_code=401, detail="Service authentication is not configured.")

    if not authorization or not authorization.startswith("Bearer "):
        raise HTTPException(status_code=401, detail="Missing or malformed Authorization header.")

    provided = authorization[len("Bearer ") :]
    if not hmac.compare_digest(provided, expected):
        raise HTTPException(status_code=401, detail="Invalid service token.")
