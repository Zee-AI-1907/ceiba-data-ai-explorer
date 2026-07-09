"""ceiba_nl2sql_service — the FastAPI NL->SQL runtime service (Phase 2, DARK).

Exposes POST /nl2sql/generate, POST /nl2sql/execute, POST /nl2sql/explain,
GET /healthz, GET /readyz over the shared `ceiba_nl2sql` library. No TS route
calls this service yet (docs/PYTHON_NL2SQL_SERVICE_PLAN.md Phase 3 wires the
cutover) — this phase only needs the service to boot, be `/readyz`-green
against the fixture bundle, and pass its own hermetic pytest suite.
"""
