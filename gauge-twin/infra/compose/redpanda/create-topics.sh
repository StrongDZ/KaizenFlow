#!/usr/bin/env bash
# Creates the Kafka topics of SPEC section 5. Safe to run repeatedly.
# Brokers come from RPK_BROKERS; KAFKA_RF is the replication factor.
set -euo pipefail

RF="${KAFKA_RF:-1}"
RETENTION_7D_MS=604800000

for _ in $(seq 1 60); do
  if rpk cluster info >/dev/null 2>&1; then break; fi
  sleep 1
done

create() { # create <topic> <partitions> [rpk topic create flags...]
  local topic="$1" partitions="$2"
  shift 2
  if rpk topic describe "$topic" >/dev/null 2>&1; then
    echo "topic $topic already exists"
  else
    rpk topic create "$topic" -p "$partitions" -r "$RF" "$@"
  fi
}

create gauge.telemetry 24 -c "retention.ms=$RETENTION_7D_MS"
create gauge.status 6
create gauge.rejected 6
create gauge.dlq 3

rpk topic list
