#!/usr/bin/env bash
# Scenario 1, steady load: 1000 machines at 1 message per second. No message
# may be lost and the p99 from window end to the database stays below 2 s.
source "$(dirname "$0")/lib.sh"

MACHINES="${MACHINES:-$(pick 200 1000)}"
# The spec asks for 24 h; the first FULL round runs 4 h to find bottlenecks.
DURATION="${DURATION:-$(pick 3m 4h)}"
trap stack_down EXIT

stack_up
seed_configs "$MACHINES"
log "edge-sim: $MACHINES machines for $DURATION"
edge_sim_start main --machines "$MACHINES" --window 1 --duration "$DURATION"
summary="$(edge_sim_wait main)"
settle 300
seqcheck main
p99="$(realtime_delay 0.99)"
p50="$(realtime_delay 0.5)"

missing="$(seq_value missing)"
unacked="$(summary_field "$summary" unacked)"
check "Acknowledged messages missing from the database" "0" "$missing" [ "$missing" = "0" ]
check "Messages the edges could not deliver" "0" "$unacked" [ "$unacked" = "0" ]
check "p99 window end to database (s)" "< 2" "$p99" le "$p99" 2
metric "p50 window end to database (s)" "$p50"
metric "p99 from the ingest histogram, bucket resolution (s)" "$(e2e_quantile 0.99)"
metric "Messages acknowledged by the broker" "$(summary_field "$summary" acked)"
metric "Publish errors at the edges" "$(summary_field "$summary" publish_errors)"
metric "Duplicate rows" "$(seq_value 'duplicate rows')"
metric "Out-of-order realtime rows" "$(seq_value 'out-of-order realtime rows')"
metric "Infrastructure retries in ingest" "$(prom 'sum(ingest_infra_errors_total)')"
report 1 "Steady load"
