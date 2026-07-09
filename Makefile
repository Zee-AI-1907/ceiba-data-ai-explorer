# =============================================================================
# Ceiba NL->SQL — dev convenience targets (docs/PYTHON_NL2SQL_SERVICE_PLAN.md §6)
# =============================================================================

.PHONY: dev dev-down dev-logs test test-py test-ts

# Bring up the full local two-process topology (web + nl2sql + mock-postgres).
dev:
	docker compose up --build

# Same, detached.
dev-up:
	docker compose up --build -d

# Tear everything down (keeps the mock-postgres data volume).
dev-down:
	docker compose down

# Follow logs for all services.
dev-logs:
	docker compose logs -f

# Run every test suite (TS + all Python packages).
test: test-ts test-py

test-ts:
	npm test

test-py:
	cd ceiba_nl2sql && pytest -q
	cd ceiba_nl2sql_service && pytest -q
	cd ceiba_nl2sql_eval && STAGING_DSN='' pytest -q
	cd prep && pytest -q
