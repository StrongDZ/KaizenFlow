#!/usr/bin/env bash
# Scenario 2, five times the load: a base fleet runs all the time and a surge
# of four times its size joins for a while. After the surge ends the Kafka lag
# must be back at 0 within 5 minutes, and nothing may be lost.
source "$(dirname "$0")/lib.sh"

BASE="${BASE:-$(pick 100 1000)}"
SURGE="${SURGE:-$((BASE * 4))}"
LEAD_S="${LEAD_S:-30}"
SURGE_S="${SURGE_S:-$(pick 120 3600)}"
TAIL_S="${TAIL_S:-$(pick 90 600)}"
trap stack_down EXIT

stack_up
seed_configs $((BASE + SURGE))
log "edge-sim: $BASE machines, plus $SURGE more for ${SURGE_S}s"
edge_sim_start base --machines "$BASE" --window 1 --duration "$((LEAD_S + SURGE_S + TAIL_S))s"
sleep "$LEAD_S"
edge_sim_start surge --machines "$SURGE" --offset "$BASE" --window 1 --duration "${SURGE_S}s"
surge_summary="$(edge_sim_wait surge)"
log "surge ended; waiting for the Kafka lag to reach 0"
recovery="$(wait_lag_zero 900 || echo "")"
base_summary="$(edge_sim_wait base)"
settle 300
peak_lag="$(prom "max_over_time(sum(kafka_consumer_lag)[$(run_window):15s])")"
p99="$(e2e_quantile 0.99)"
seqcheck base surge

missing="$(seq_value missing)"
check "Kafka lag back at 0 after the surge (s)" "<= 300" "${recovery:-not within 900}" le "$recovery" 300
check "Acknowledged messages missing from the database" "0" "$missing" [ "$missing" = "0" ]
metric "Peak Kafka lag (messages)" "$peak_lag"
metric "p99 window end to database over the whole run (s)" "$p99"
metric "Messages acknowledged, base fleet" "$(summary_field "$base_summary" acked)"
metric "Messages acknowledged, surge" "$(summary_field "$surge_summary" acked)"
metric "Messages the edges could not deliver" "$(($(summary_field "$base_summary" unacked) + $(summary_field "$surge_summary" unacked)))"
metric "Publish errors at the edges" "$(($(summary_field "$base_summary" publish_errors) + $(summary_field "$surge_summary" publish_errors)))"
metric "Duplicate rows" "$(seq_value 'duplicate rows')"
report 2 "Five times the load"
