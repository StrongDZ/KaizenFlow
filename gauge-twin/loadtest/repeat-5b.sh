#!/usr/bin/env bash
# Runs scenario 5b several times to measure how often it fails. For every
# failed run the stack is kept just long enough to collect what explains it:
# the consumer groups as the broker sees them, the logs of ingest, state and
# the bridges, and the Redpanda logs (group coordinator moves, rebalances).
# Usage: repeat-5b.sh [runs]   (default 10)
set -uo pipefail
cd "$(dirname "$0")/.."

RUNS="${1:-10}"
OUT="data/loadtest/repeat-5b-$(date +%Y%m%d-%H%M%S)"
mkdir -p "$OUT"
failed=0
for i in $(seq 1 "$RUNS"); do
  echo "[$(date +%T)] run $i of $RUNS" >&2
  if KEEP=1 RUN_ID="repeat-5b-$i-$(date +%H%M%S)" loadtest/scenario-5b.sh >"$OUT/run-$i.log" 2>&1; then
    echo "run $i: pass" | tee -a "$OUT/summary.txt"
  else
    failed=$((failed + 1))
    echo "run $i: FAIL ($(grep -E 'timed out|criterion.*fail' "$OUT/run-$i.log" | tail -1 | cut -c1-160))" | tee -a "$OUT/summary.txt"
    dir="$OUT/run-$i"
    mkdir -p "$dir"
    for group in ingest state-seq state-status; do
      docker exec gauge-twin-redpanda-0-1 rpk group describe "$group" -X brokers=redpanda-0:9092 >"$dir/group-$group.txt" 2>&1
    done
    docker exec gauge-twin-redpanda-0-1 rpk cluster health -X brokers=redpanda-0:9092 >"$dir/cluster-health.txt" 2>&1
    for c in server-ingest-1-1 server-ingest-2-1 server-state-1 server-mqtt-bridge-1-1 server-mqtt-bridge-2-1 \
      redpanda-0-1 redpanda-1-1 redpanda-2-1; do
      docker logs "gauge-twin-$c" >"$dir/$c.log" 2>&1
    done
    grep -hiE 'rebalanc|coordinator|join|leav|commit' "$dir"/server-ingest-*.log >"$dir/rebalance-events.txt" 2>/dev/null
  fi
  docker rm -f $(docker ps -aq --filter name=gauge-twin-edge-sim) >/dev/null 2>&1
  docker compose -f infra/compose/server.yml down >/dev/null 2>&1
  docker compose -f infra/compose/dev.yml --profile dev --profile cluster --profile init down >/dev/null 2>&1
done
echo "failed $failed of $RUNS runs; details in $OUT" | tee -a "$OUT/summary.txt"
