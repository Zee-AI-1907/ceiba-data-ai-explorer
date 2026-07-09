"""errors.py — the service's error envelope + exception taxonomy, mirroring
`lib/errors.ts` (docs/PYTHON_NL2SQL_SERVICE_PLAN.md §2.4).

Every error response is exactly:

    { "error": { "kind": ErrorKind, "message": str, "detail"?: {} } }

`kind` is the plan §2.4 vocabulary the TS client maps onto `lib/errors.ts`'s
`ErrorCodes`:
    scope       -> 422 SCOPE       (model declined / out-of-clinical-scope)
    generation  -> 422 SCOPE       (repair budget exhausted)
    guard       -> 422 VALIDATION  (SQL rejected by the read-only re-guard —
                                    a REJECTED REQUEST, not an upstream failure:
                                    the caller submitted a write/DDL/unsafe
                                    statement. Reconciled to 422 to match the
                                    /nl2sql/execute route + its contract test;
                                    the TS client keys off `kind`, not status.)
    engine      -> 502 UPSTREAM    (DuckDB/driver failure — a genuine upstream)
    internal    -> 500 INTERNAL
    bad_request -> 400 VALIDATION
    auth        -> 401 UNAUTHENTICATED

`message` is ALWAYS safe to show a client — raw OpenAI/DuckDB error bodies
are logged server-side only (H20 discipline, mirrors `lib/errors.ts`
`safeError`), never returned in the envelope.
"""

from __future__ import annotations

import logging
import uuid

from fastapi import HTTPException
from fastapi.responses import JSONResponse

from ceiba_nl2sql_service.models import ErrorKind, ServiceErrorDetail, ServiceErrorEnvelope

logger = logging.getLogger("ceiba_nl2sql_service")

_KIND_TO_STATUS: dict[ErrorKind, int] = {
    "bad_request": 400,
    "auth": 401,
    "scope": 422,
    "generation": 422,
    # `guard` is 422 (a rejected request), reconciled with the /nl2sql/execute
    # route + its contract test. It is NOT 502 — a guard rejection is not an
    # upstream failure, it is the caller submitting unsafe SQL.
    "guard": 422,
    "engine": 502,
    "internal": 500,
}


class ServiceError(Exception):
    """Base for every error this service raises deliberately. `kind` selects
    both the HTTP status (`_KIND_TO_STATUS`) and how the TS client maps the
    envelope (§2.4). `message` must always be client-safe.
    """

    def __init__(self, kind: ErrorKind, message: str, *, detail: dict | None = None) -> None:
        super().__init__(message)
        self.kind = kind
        self.message = message
        self.detail = detail

    @property
    def status_code(self) -> int:
        return _KIND_TO_STATUS.get(self.kind, 500)


def envelope_response(kind: ErrorKind, message: str, *, detail: dict | None = None, status_code: int | None = None) -> JSONResponse:
    body = ServiceErrorEnvelope(error=ServiceErrorDetail(kind=kind, message=message, detail=detail))
    status = status_code if status_code is not None else _KIND_TO_STATUS.get(kind, 500)
    return JSONResponse(status_code=status, content=body.model_dump(exclude_none=True))


def safe_error_response(exc: Exception, *, context: str, kind: ErrorKind = "internal") -> JSONResponse:
    """Logs full detail server-side under a correlation id, returns a GENERIC
    client envelope. Mirrors lib/errors.ts `safeError`: no internal detail
    (DuckDB/OpenAI stack traces) is ever returned to the caller.
    """
    correlation_id = str(uuid.uuid4())
    logger.error("correlationId=%s context=%s kind=%s :: %s", correlation_id, context, kind, exc, exc_info=exc)
    message = (
        "An upstream dependency failed to respond. Please try again."
        if kind == "engine"
        else "An unexpected error occurred. Please try again."
    )
    return envelope_response(kind, message, detail={"correlationId": correlation_id})
