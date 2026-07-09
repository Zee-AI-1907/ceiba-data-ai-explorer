# =============================================================================
# Ceiba NL->SQL — FastAPI service (uvicorn) dev image
# =============================================================================
# The Python NL->SQL runtime (docs/PYTHON_NL2SQL_SERVICE_PLAN.md §2, §6). Builds
# the shared `ceiba_nl2sql` library + the `ceiba_nl2sql_service` package. Used
# by the root docker-compose.yml `nl2sql` service. Dev-oriented: uvicorn runs
# with --reload and the repo is bind-mounted, so a code edit reloads live.
# =============================================================================
FROM python:3.11-slim

WORKDIR /app

# System deps kept minimal; duckdb/fastembed wheels are prebuilt.
RUN pip install --no-cache-dir --upgrade pip

# Install the shared library FIRST (the service depends on it by name), then the
# service. Both editable so a bind-mount reflects local edits without a rebuild.
COPY ceiba_nl2sql /app/ceiba_nl2sql
COPY ceiba_nl2sql_service /app/ceiba_nl2sql_service
RUN pip install --no-cache-dir -e /app/ceiba_nl2sql \
 && pip install --no-cache-dir -e /app/ceiba_nl2sql_service

EXPOSE 8088

# --reload for local dev; drop it (and bind-mounts) for a production image.
CMD ["uvicorn", "ceiba_nl2sql_service.app:app", "--host", "0.0.0.0", "--port", "8088", "--reload"]
