#!/usr/bin/env bash
# Scenario 6, slow database: the connection from ingest to TimescaleDB is
# throttled for a while (Toxiproxy). Data must pile up in Kafka, nothing may
# be dropped or dead-lettered, and ingest must catch up by itself afterwards.
LOADTEST_SERVER_OVERRIDES="${LOADTEST_SERVER_OVERRIDES:-} -f infra/compose/loadtest/ingest-via-toxiproxy.yml"
source "$(dirname "$0")/lib.sh"

MACHINES="${MACHINES:-$(pick 200 1000)}"
LEAD_S="${LEAD_S:-30}"
SLOW_S="${SLOW_S:-$(pick 120 1800)}"
TAIL_S="${TAIL_S:-$(pick 60 300)}"
# Upstream limit in KB/s and added latency per packet group, in ms.
SLOW_KBPS="${SLOW_KBPS:-$(pick 2 10)}"
SLOW_LATENCY_MS="${SLOW_LATENCY_MS:-500}"
CATCH_UP_LIMIT_S="${CATCH_UP_LIMIT_S:-$(pick 600 3600)}"
TOXI="docker compose -f infra/compose/loadtest/toxiproxy.yml"
toxi() { docker exec "$PROJECT-loadtest-toxiproxy-1" /toxiproxy-cli "$@" >/dev/null; }
before_server() { $TOXI up -d >/dev/null 2>&1; sleep 2; }
extra_down() { $TOXI down >/dev/null 2>&1; }
trap stack_down EXIT

stack_up
seed_configs "$MACHINES"
log "edge-sim: $MACHINES machines; database throttled to ${SLOW_KBPS} KB/s for ${SLOW_S}s"
edge_sim_start main --machines "$MACHINES" --window 1 --duration "$((LEAD_S + SLOW_S + TAIL_S))s"
sleep "$LEAD_S"
toxi toxic add -n slow-up -t bandwidth -a rate="$SLOW_KBPS" --upstream timescaledb
toxi toxic add -n lag-down -t latency -a latency="$SLOW_LATENCY_MS" --downstream timescaledb
sleep "$SLOW_S"
lag_end="$(group_lag)"
lag_metric_end="$(prom 'sum(kafka_consumer_lag)')"
toxi toxic remove -n slow-up timescaledb
toxi toxic remove -n lag-down timescaledb
restored_at=$(date +%s)
log "throttle removed with a Kafka lag of ${lag_end:-?}; waiting for ingest to catch up"
summary="$(edge_sim_wait main)"
if wait_lag_zero "$CATCH_UP_LIMIT_S" >/dev/null; then catch_up=$(($(date +%s) - restored_at)); else catch_up=""; fi
seqcheck main

missing="$(seq_value missing)"
dlq="$(prom 'sum(ingest_messages_total{result="dlq"})')"
ingest_restarts=$(($(restarts gauge-twin-server-ingest-1-1) + $(restarts gauge-twin-server-ingest-2-1)))
check "Data piled up in Kafka while the database was slow (lag, messages)" "> 0" "$lag_end" [ "${lag_end%.*}" -gt 0 ]
check "Acknowledged messages missing from the database" "0" "$missing" [ "$missing" = "0" ]
check "Records dead-lettered" "0" "${dlq:-0}" [ "${dlq:-0}" = "0" ]
check "Ingest caught up by itself (s after the throttle was removed)" "<= $CATCH_UP_LIMIT_S" "${catch_up:-not within $CATCH_UP_LIMIT_S}" [ -n "$catch_up" ]
check "Ingest container restarts" "0" "$ingest_restarts" [ "$ingest_restarts" = "0" ]
metric "kafka_consumer_lag metric of ingest at the same moment" "${lag_metric_end:-none}"
metric "Infrastructure retries in ingest" "$(prom 'sum(ingest_infra_errors_total)')"
metric "Messages acknowledged by the broker" "$(summary_field "$summary" acked)"
metric "Duplicate rows" "$(seq_value 'duplicate rows')"
metric "p99 window end to database over the whole run (s)" "$(e2e_quantile 0.99)"
report 6 "Slow database"
