#!/bin/sh
# Makes sure infra/compose/.env holds the credentials of the local stack.
# Nothing secret lives in the repository: every credential missing from .env
# is generated here, once, with a random value. Existing lines are kept, so
# ports or credentials set by hand stay as they are.
set -eu

ENV_FILE="$(dirname "$0")/.env"
touch "$ENV_FILE"

random() {
  LC_ALL=C tr -dc 'a-zA-Z0-9' < /dev/urandom | head -c 24
}

for name in POSTGRES_PASSWORD MINIO_ROOT_PASSWORD GRAFANA_PASSWORD EMQX_COOKIE; do
  if ! grep -q "^${name}=" "$ENV_FILE"; then
    printf '%s=%s\n' "$name" "$(random)" >> "$ENV_FILE"
  fi
done
