#!/usr/bin/env bash
# =============================================================================
# mock-db-up.sh — bring up the local synthetic companion Postgres (Phase P1)
# =============================================================================
# Starts docker/mock-postgres (OrbStack or plain Docker) and BLOCKS until the
# container reports healthy (init SQL applied, accepting connections).
#
#   bash scripts/mock-db-up.sh
#
# Local port: 55433 (avoids the 55432 staging SSH tunnel).
# Read-only role for engines: ceiba_ro / ceiba_ro_pw
#   MOCK_DSN=postgresql://ceiba_ro:ceiba_ro_pw@localhost:55433/mockdb
# =============================================================================
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
COMPOSE_DIR="${SCRIPT_DIR}/../docker/mock-postgres"
COMPOSE_FILE="${COMPOSE_DIR}/docker-compose.yml"
CONTAINER_NAME="ceiba-mock-postgres"

if ! command -v docker >/dev/null 2>&1; then
    echo "ERROR: docker not found on PATH." >&2
    exit 1
fi

echo ">> Starting mock Postgres (docker compose up -d) ..."
docker compose -f "${COMPOSE_FILE}" up -d

echo ">> Waiting for container '${CONTAINER_NAME}' to become healthy ..."
DEADLINE=$(( $(date +%s) + 90 ))
while true; do
    STATUS="$(docker inspect -f '{{.State.Health.Status}}' "${CONTAINER_NAME}" 2>/dev/null || echo "missing")"
    case "${STATUS}" in
        healthy)
            echo ">> Healthy."
            break
            ;;
        unhealthy)
            echo "ERROR: container reported unhealthy. Recent logs:" >&2
            docker logs --tail 40 "${CONTAINER_NAME}" >&2 || true
            exit 1
            ;;
    esac
    if [ "$(date +%s)" -ge "${DEADLINE}" ]; then
        echo "ERROR: timed out waiting for healthcheck (status='${STATUS}'). Recent logs:" >&2
        docker logs --tail 40 "${CONTAINER_NAME}" >&2 || true
        exit 1
    fi
    sleep 2
done

cat <<'EOF'

>> Mock Postgres is up.
   Admin (bootstrap only): postgresql://mock_admin:mock_admin_pw@localhost:55433/mockdb
   Read-only (engines):    postgresql://ceiba_ro:ceiba_ro_pw@localhost:55433/mockdb

   Set MOCK_DSN to the read-only DSN. See .env.example and docs/mock-topology.md.
   Tear down: bash scripts/mock-db-down.sh   (add --volumes to wipe data)
EOF
