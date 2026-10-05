#!/usr/bin/env bash
# Shared helpers of the load-test scenarios (SPEC section 8).
#
# Everything talks to the stack from inside the Docker network (docker exec or
# a container on the network), so the scripts also work on a server where no
# port is published on the host.
#
# Environment:
#   FULL=1                  run the scenario at the size and duration of the spec
#   PROFILE=dev|cluster     infrastructure profile (scenarios pick a default)
#   KEEP=1                  leave the stack running afterwards
#   LOADTEST_OVERRIDES      extra "-f file" compose arguments (limits, no ports)
#   EDGE_SIM_CPUSET         CPU cores for edge-sim, e.g. 0-7 (empty = unpinned)
#   EDGE_SIM_CPUS/MEMORY    limits of an edge-sim container (default 4 / 2g)
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

PROJECT=gauge-twin
PROFILE="${PROFILE:-dev}"
FULL="${FULL:-0}"
RUN_ID="${RUN_ID:-$(date +%Y%m%d-%H%M%S)}"
RUN_DIR="$ROOT/data/loadtest/$RUN_ID"
REPORT_DIR="$ROOT/loadtest/reports"
TOOLS_IMAGE="${TOOLS_IMAGE:-$PROJECT-tools:$(cksum tools/Dockerfile | cut -d ' ' -f 1)}"
EDGE_SIM_IMAGE="${EDGE_SIM_IMAGE:-$PROJECT-edge-sim:local}"
# shellcheck disable=SC2086
INFRA="docker compose -f infra/compose/dev.yml ${LOADTEST_OVERRIDES:-}"
SERVER="docker compose -f infra/compose/server.yml ${LOADTEST_SERVER_OVERRIDES:-}"
# Credentials of the local stack: infra/compose/.env, written by gen-env.sh.
infra/compose/gen-env.sh
set -a
# shellcheck disable=SC1091
. infra/compose/.env
set +a
DB_URL="postgres://${POSTGRES_USER:-gauge}:${POSTGRES_PASSWORD}@timescaledb:5432/${POSTGRES_DB:-gauge}?sslmode=disable"

mkdir -p "$RUN_DIR" "$REPORT_DIR"
RESULTS="$RUN_DIR/results.jsonl"
STARTED_AT="$(date -u +%Y-%m-%dT%H:%M:%SZ)"

log() { echo "[$(date +%T)] $*" >&2; }

# pick <short> <full>: the value for a short or a FULL run.
pick() { if [ "$FULL" = "1" ]; then echo "$2"; else echo "$1"; fi; }

# net_run <command...>: run in the tools image on the stack network.
net_run() {
  docker run --rm --network "$PROJECT" --user "$(id -u):$(id -g)" -v "$ROOT":/work -w /work \
    -v "$PROJECT-tools-cache":/cache "$TOOLS_IMAGE" "$@"
}

psql_q() { docker exec -i "$PROJECT-timescaledb-1" psql -U gauge -d gauge -v ON_ERROR_STOP=1 -qAt -c "$1"; }

# prom <query>: the first value of an instant query, or empty.
prom() {
  docker exec "$PROJECT-prometheus-1" wget -q -O - --post-data "query=$1" http://127.0.0.1:9090/api/v1/query |
    python3 -c 'import sys, json
r = json.load(sys.stdin)["data"]["result"]
print(r[0]["value"][1] if r else "")'
}

# wait_until <seconds> <description> <command...>: poll until the command succeeds.
wait_until() {
  local limit="$1" what="$2" start
  shift 2
  start=$(date +%s)
  until "$@" >/dev/null 2>&1; do
    if [ $(($(date +%s) - start)) -ge "$limit" ]; then
      log "timed out after ${limit}s waiting for $what"
      return 1
    fi
    sleep 2
  done
  echo $(($(date +%s) - start))
}

stack_up() {
  local rf=1
  [ "$PROFILE" = "cluster" ] && rf=3
  log "starting infrastructure (profile $PROFILE)"
  $INFRA --profile "$PROFILE" up -d --wait >/dev/null
  KAFKA_RF=$rf $INFRA run --rm kafka-init >/dev/null
  net_run migrate -path schemas/sql -database "$DB_URL" up >/dev/null 2>&1
  # Sequence tracking and latest values of an earlier run would look like
  # counter restarts and non-monotonic hour meters in this one.
  docker exec "$PROJECT-redis-1" redis-cli FLUSHDB >/dev/null
  if declare -F before_server >/dev/null; then before_server; fi
  log "starting server services"
  $SERVER up -d --build >/dev/null 2>&1
  wait_until 120 "config-api" net_run curl -sf http://config-api:8080/healthz >/dev/null
  # Prometheus may have been running with an older scrape config.
  docker kill -s HUP "$PROJECT-prometheus-1" >/dev/null
}

stack_down() {
  if [ "${KEEP:-0}" = "1" ]; then
    log "KEEP=1: leaving the stack running"
    return
  fi
  log "stopping the stack"
  docker rm -f $(docker ps -aq --filter "name=$PROJECT-edge-sim") >/dev/null 2>&1 || true
  if declare -F extra_down >/dev/null; then extra_down || true; fi
  $SERVER down >/dev/null 2>&1 || true
  $INFRA --profile dev --profile cluster --profile init down >/dev/null 2>&1 || true
}

# seed_configs <machines>: register station configs so ingest validates the load,
# then wait until ingest has picked them up (it refreshes every 30 s).
seed_configs() {
  log "registering $1 station configs"
  mkdir -p "$RUN_DIR/configs"
  docker run --rm --user "$(id -u):$(id -g)" -v "$RUN_DIR":/out "$EDGE_SIM_IMAGE" \
    --machines "$1" --emit-configs /out/configs >/dev/null
  net_run loadtest/seed-configs.sh "data/loadtest/$RUN_ID/configs" http://config-api:8080 >/dev/null
  sleep 35
}

# edge_sim_start <name> <args...>: start a detached edge-sim; its sequence log
# goes to $RUN_DIR/<name>.jsonl. The network alias lets Prometheus scrape it.
edge_sim_start() {
  local name="$1"
  shift
  local pin=()
  [ -n "${EDGE_SIM_CPUSET:-}" ] && pin=(--cpuset-cpus "$EDGE_SIM_CPUSET")
  docker rm -f "$PROJECT-edge-sim-$name" >/dev/null 2>&1 || true
  docker run -d --name "$PROJECT-edge-sim-$name" --network "$PROJECT" --network-alias edge-sim \
    --cpus "${EDGE_SIM_CPUS:-4}" --memory "${EDGE_SIM_MEMORY:-2g}" ${pin[@]+"${pin[@]}"} \
    --user "$(id -u):$(id -g)" -v "$RUN_DIR":/out "$EDGE_SIM_IMAGE" \
    --broker emqx:1883 --seq-log "/out/$name.jsonl" "$@" >/dev/null
}

# edge_sim_wait <name>: wait for an edge-sim to finish; prints its summary line.
edge_sim_wait() {
  docker wait "$PROJECT-edge-sim-$1" >/dev/null
  docker logs "$PROJECT-edge-sim-$1" 2>&1 | grep '"simulation finished"' | tail -1
  docker rm "$PROJECT-edge-sim-$1" >/dev/null
}

# sim_metric <name> <metric>: current value of a metric of one edge-sim
# (summed over its series), read directly so it is not a scrape interval old.
sim_metric() {
  docker exec "$PROJECT-prometheus-1" wget -q -O - "http://$PROJECT-edge-sim-$1:9100/metrics" 2>/dev/null |
    awk -v m="$2" '$1 == m || index($1, m "{") == 1 { s += $2; found = 1 } END { if (found) printf "%d\n", s }'
}

# all_connected <name> <edges>: every edge of that edge-sim is connected.
all_connected() { [ "$(sim_metric "$1" edge_sim_connected_edges)" = "$2" ]; }

# gap_candidates: sequence numbers state currently considers missing.
gap_candidates() {
  docker exec "$PROJECT-redis-1" redis-cli --raw EVAL \
    "local n = 0 for _, k in ipairs(redis.call('KEYS', 'seqgap:edge-*')) do n = n + redis.call('ZCARD', k) end return n" 0
}

# stats_start <file> <container...>: sample CPU and memory of containers every
# 2 s into <file> ("name cpu% mem") until stats_stop.
stats_start() {
  local file="$1"
  shift
  : >"$file"
  (while :; do
    docker stats --no-stream --format '{{.Name}} {{.CPUPerc}} {{.MemUsage}}' "$@" 2>/dev/null |
      tr -d '%' | awk '{print $1, $2, $3}' >>"$file" || true
    sleep 2
  done) &
  STATS_PID=$!
}
stats_stop() { kill "$STATS_PID" 2>/dev/null || true; wait "$STATS_PID" 2>/dev/null || true; }

# stats_max_cpu <file>: the highest CPU sample, as a percentage of all cores of the machine.
stats_max_cpu() {
  awk -v n="$(docker info --format '{{.NCPU}}')" '$2 > m { m = $2 } END { printf "%.1f\n", m / n }' "$1"
}

# restarts <container>: times Docker restarted it.
restarts() { docker inspect -f '{{.RestartCount}}' "$1"; }

# summary_field <summary json line> <field>
summary_field() { python3 -c 'import sys, json; print(json.loads(sys.argv[1]).get(sys.argv[2], ""))' "$1" "$2"; }

# seqcheck <name...>: compare the sequence logs of the given edge-sims with the
# database. The output is kept in $RUN_DIR/seqcheck.txt.
seqcheck() {
  local name
  : >"$RUN_DIR/all.jsonl"
  for name in "$@"; do cat "$RUN_DIR/$name.jsonl" >>"$RUN_DIR/all.jsonl"; done
  docker cp "$RUN_DIR/all.jsonl" "$PROJECT-timescaledb-1":/tmp/seq.jsonl >/dev/null
  SEQCHECK_PSQL="docker exec -i $PROJECT-timescaledb-1 psql -U gauge -d gauge" SEQCHECK_LOG_PATH=/tmp/seq.jsonl \
    loadtest/seqcheck.sh "$RUN_DIR/all.jsonl" | tee "$RUN_DIR/seqcheck.txt" >&2
}

# seq_value <label>: the number after "<label>: " in the seqcheck output.
seq_value() { grep -o "$1: [0-9]*" "$RUN_DIR/seqcheck.txt" | head -1 | grep -o '[0-9]*$'; }

# run_window: a Prometheus range covering this run only. The Prometheus
# volume outlives a run, so longer ranges would mix in earlier scenarios.
START_EPOCH="$(date +%s)"
run_window() { echo "$(($(date +%s) - START_EPOCH + 30))s"; }

# e2e_quantile <q>: quantile of window end to database over this run, from
# the ingest histogram (includes replayed messages).
e2e_quantile() { prom "histogram_quantile($1, sum(increase(ingest_end_to_end_seconds_bucket[$(run_window)])) by (le))"; }

# realtime_delay <q> [extra SQL condition]: quantile in seconds of
# ingested_at - ts over the realtime (not replayed) rows stored in this run.
realtime_delay() {
  psql_q "SELECT round(COALESCE(percentile_cont($1) WITHIN GROUP (ORDER BY extract(epoch FROM ingested_at - ts)), 0)::numeric, 3)
    FROM gauge_reading WHERE NOT replayed AND ingested_at >= '$STARTED_AT' ${2:+AND $2}"
}

# wait_lag_zero <seconds>: wait until ingest has caught up; prints the wait time.
# group_lag: records the ingest consumer group still has to read, as the
# broker sees it. The kafka_consumer_lag metric of ingest is only refreshed
# when a batch finishes, so it stays at its old value while ingest is blocked.
kafka_node() { if [ "$PROFILE" = "cluster" ]; then echo "redpanda-0"; else echo "redpanda"; fi; }
# rpk_net <args...>: rpk through the listener inside the Docker network. By
# default rpk follows the advertised host addresses (localhost:<port>), which
# only work inside the container for the node it runs on: in the cluster
# profile every request that another broker must answer would fail.
rpk_net() {
  local node
  node="$(kafka_node)"
  docker exec "$PROJECT-$node-1" rpk "$@" -X brokers="$node:9092"
}
group_lag() {
  rpk_net group describe "${INGEST_GROUP:-ingest}" 2>/dev/null |
    awk '$1 == "TOTAL-LAG" { print $2; found = 1 } END { if (!found) exit 1 }'
}
lag_is_zero() { [ "$(group_lag)" = "0" ]; }
wait_lag_zero() { wait_until "$1" "Kafka lag to reach 0" lag_is_zero; }

# settle [seconds]: wait for ingest to catch up before the database is
# checked. When the lag does not reach 0 the run goes on (the sequence check
# is what decides), and the consumer group as the broker sees it is kept in
# $RUN_DIR/group-ingest.txt for diagnosis.
settle() {
  if wait_lag_zero "${1:-300}" >/dev/null; then
    LAG_SETTLED=yes
  else
    LAG_SETTLED=no
    rpk_net group describe "${INGEST_GROUP:-ingest}" >"$RUN_DIR/group-ingest.txt" 2>&1 || true
    for c in ingest-1-1 ingest-2-1; do docker logs --since 15m "$PROJECT-server-$c" >"$RUN_DIR/$c.log" 2>&1 || true; done
    log "the consumer group lag did not reach 0; details in $RUN_DIR/group-ingest.txt"
  fi
  metric "Consumer group lag reached 0 before the check" "$LAG_SETTLED"
}

# grafana_snapshot: store the dashboard as a Grafana snapshot; prints its URL path.
grafana_snapshot() {
  local body
  body="$(python3 -c 'import json, sys
dash = json.load(open("infra/grafana/dashboards/gauge-twin.json"))
dash["time"] = {"from": sys.argv[1], "to": "now"}
print(json.dumps({"dashboard": dash, "name": "loadtest " + sys.argv[2], "expires": 0}))' "$STARTED_AT" "$RUN_ID")"
  docker exec "$PROJECT-grafana-1" wget -q -O - --header 'Content-Type: application/json' \
    --header "Authorization: Basic $(printf 'admin:admin' | base64)" --post-data "$body" \
    http://127.0.0.1:3000/api/snapshots 2>/dev/null |
    python3 -c 'import sys, json; print(json.load(sys.stdin).get("url", ""))' 2>/dev/null || true
}

# metric <name> <value>: a figure for the report.
metric() { python3 -c 'import json, sys; print(json.dumps({"kind": "metric", "name": sys.argv[1], "value": sys.argv[2]}))' "$1" "$2" >>"$RESULTS"; }

# criterion <name> <target> <measured> <pass|fail|info>
criterion() {
  python3 -c 'import json, sys
print(json.dumps({"kind": "criterion", "name": sys.argv[1], "target": sys.argv[2], "measured": sys.argv[3], "result": sys.argv[4]}))' \
    "$1" "$2" "$3" "$4" >>"$RESULTS"
  log "criterion: $1 | target $2 | measured $3 | $4"
}

# check <name> <target> <measured> <test expression...>: criterion from a shell test.
check() {
  local name="$1" target="$2" measured="$3"
  shift 3
  if "$@"; then criterion "$name" "$target" "$measured" pass; else criterion "$name" "$target" "$measured" fail; fi
}

# le <a> <b>: a <= b for decimal numbers; false when a is empty.
le() { [ -n "$1" ] && python3 -c 'import sys; sys.exit(0 if float(sys.argv[1]) <= float(sys.argv[2]) else 1)' "$1" "$2"; }

# report <scenario> <title>: write the Markdown report and print its path.
report() {
  local snapshot
  snapshot="$(grafana_snapshot)"
  python3 loadtest/report.py --scenario "$1" --title "$2" --results "$RESULTS" --run-id "$RUN_ID" \
    --started "$STARTED_AT" --full "$FULL" --profile "$PROFILE" --snapshot "$snapshot" \
    --cpuset "${EDGE_SIM_CPUSET:-}" --seqcheck "$RUN_DIR/seqcheck.txt" --out "$REPORT_DIR/$RUN_ID-scenario-$1.md"
}
