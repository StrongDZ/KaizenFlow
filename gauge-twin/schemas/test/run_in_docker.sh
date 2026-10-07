#!/usr/bin/env bash
# Runs migrate_test.sh against a throwaway TimescaleDB container.
# Usage: run_in_docker.sh <tools-image>
set -euo pipefail

TOOLS_IMAGE="${1:?usage: run_in_docker.sh <tools-image>}"
# Keep in sync with infra/compose/dev.yml.
TIMESCALE_IMAGE="${TIMESCALE_IMAGE:-timescale/timescaledb:2.17.2-pg16}"
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
NAME="gauge-twin-sqltest-$$"

cleanup() {
  docker rm -f "$NAME" >/dev/null 2>&1 || true
  docker network rm "$NAME" >/dev/null 2>&1 || true
}
trap cleanup EXIT

docker network create "$NAME" >/dev/null
docker run -d --name "$NAME" --network "$NAME" \
  -e POSTGRES_USER=gauge -e POSTGRES_HOST_AUTH_METHOD=trust -e POSTGRES_DB=gauge \
  "$TIMESCALE_IMAGE" >/dev/null

docker run --rm --network "$NAME" --user "$(id -u):$(id -g)" \
  -v "$ROOT":/work -w /work \
  -e DATABASE_URL="postgres://gauge@$NAME:5432/gauge?sslmode=disable" \
  "$TOOLS_IMAGE" schemas/test/migrate_test.sh
