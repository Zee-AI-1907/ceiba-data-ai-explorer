#!/usr/bin/env bash
# =============================================================================
# mock-db-down.sh — tear down the local synthetic companion Postgres (Phase P1)
# =============================================================================
#   bash scripts/mock-db-down.sh              # stop + remove container (KEEP data)
#   bash scripts/mock-db-down.sh --volumes    # also wipe the named data volume
#   bash scripts/mock-db-down.sh -v           # (alias for --volumes)
#
# Wiping the volume + up again re-applies init SQL and yields the SAME data
# (the seed is deterministic — see docker/mock-postgres/init/02_seed.sql).
# =============================================================================
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
COMPOSE_FILE="${SCRIPT_DIR}/../docker/mock-postgres/docker-compose.yml"

WIPE_VOLUMES=0
for arg in "$@"; do
    case "${arg}" in
        --volumes|-v) WIPE_VOLUMES=1 ;;
        *) echo "Unknown argument: ${arg}" >&2; exit 2 ;;
    esac
done

if ! command -v docker >/dev/null 2>&1; then
    echo "ERROR: docker not found on PATH." >&2
    exit 1
fi

if [ "${WIPE_VOLUMES}" -eq 1 ]; then
    echo ">> Stopping mock Postgres and WIPING the data volume ..."
    docker compose -f "${COMPOSE_FILE}" down --volumes
    echo ">> Done. Next 'up' will re-seed from init SQL (deterministic)."
else
    echo ">> Stopping mock Postgres (data volume preserved) ..."
    docker compose -f "${COMPOSE_FILE}" down
    echo ">> Done. Data volume 'ceiba_mock_pgdata' preserved."
fi
