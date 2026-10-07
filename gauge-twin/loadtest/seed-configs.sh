#!/usr/bin/env bash
# Registers station configs in config-api: PUT <dir>/<machine_id>.json for
# every file. Usage: seed-configs.sh <dir> [config-api-url]
set -euo pipefail

DIR="${1:?usage: seed-configs.sh <dir> [config-api-url]}"
URL="${2:-http://localhost:8090}"

count=0
for file in "$DIR"/*.json; do
  [ -f "$file" ] || continue
  machine="$(basename "$file" .json)"
  code="$(curl -s -o /tmp/seed-config.out -w '%{http_code}' -X PUT --data-binary "@$file" "$URL/v1/stations/$machine")"
  if [ "$code" != "200" ]; then
    echo "PUT $machine failed with HTTP $code: $(cat /tmp/seed-config.out)" >&2
    exit 1
  fi
  count=$((count + 1))
done
echo "registered $count station config(s) at $URL"
