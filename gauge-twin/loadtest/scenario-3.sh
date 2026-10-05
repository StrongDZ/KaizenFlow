#!/usr/bin/env bash
# Scenario 3, reconnect storm: every EMQX node is restarted at once. All edges
# must be connected again within 2 minutes, the brokers stay below 80% CPU and,
# once state has asked the edges for what the brokers lost, nothing is missing.
PROFILE="${PROFILE:-cluster}"
export STATE_RESEND_ENABLED=true STATE_RESEND_AFTER="${STATE_RESEND_AFTER:-20s}"
# The bridge logs every sequence number so a loss can be located.
export BRIDGE_TRACE_SEQ=true
source "$(dirname "$0")/lib.sh"

MACHINES="${MACHINES:-$(pick 200 1000)}"
LEAD_S="${LEAD_S:-45}"
TAIL_S="${TAIL_S:-$(pick 120 300)}"
RECONNECT_LIMIT_S=300
NODES=("$PROJECT-emqx1-1" "$PROJECT-emqx2-1" "$PROJECT-emqx3-1")
trap 'stats_stop; stack_down' EXIT

stack_up
seed_configs "$MACHINES"
log "edge-sim: $MACHINES edges"
edge_sim_start main --machines "$MACHINES" --window 1 --duration "$((LEAD_S + RECONNECT_LIMIT_S + TAIL_S))s" --resend
sleep "$LEAD_S"
wait_until 120 "all edges to connect" all_connected main "$MACHINES" >/dev/null

log "restarting the whole EMQX cluster"
stats_start "$RUN_DIR/emqx-stats.txt" "${NODES[@]}"
restart_at=$(date +%s)
pids=()
for node in "${NODES[@]}"; do
  docker restart "$node" >/dev/null &
  pids+=($!)
done
# The cut must be noticed before the recovery is watched for.
sleep 5
wait "${pids[@]}"
wait_until "$RECONNECT_LIMIT_S" "all edges to reconnect" all_connected main "$MACHINES" >/dev/null && reconnect=$(($(date +%s) - restart_at)) || reconnect=""
sleep 30
stats_stop
cpu="$(stats_max_cpu "$RUN_DIR/emqx-stats.txt")"
log "edges reconnected after ${reconnect:-?}s; waiting for the resend requests to be answered"
gaps_filled() { [ "$(gap_candidates)" = "0" ]; }
# Gaps show up as soon as newer messages arrive; give them a moment to.
sleep 15
if wait_until "$TAIL_S" "the gaps to be filled" gaps_filled >/dev/null; then filled=$(($(date +%s) - restart_at)); else filled=""; fi
sleep 5
docker stop -t 30 "$PROJECT-edge-sim-main" >/dev/null
summary="$(edge_sim_wait main)"
settle 300
seqcheck main
docker logs "$PROJECT-server-state-1" >"$RUN_DIR/state.log" 2>&1
docker logs "$PROJECT-server-mqtt-bridge-1-1" >"$RUN_DIR/bridge-1.log" 2>&1
docker logs "$PROJECT-server-mqtt-bridge-2-1" >"$RUN_DIR/bridge-2.log" 2>&1
python3 loadtest/locate_loss.py --state "$RUN_DIR/state.log" --bridge "$RUN_DIR/bridge-1.log" "$RUN_DIR/bridge-2.log" |
  tee "$RUN_DIR/loss.txt" >&2
loss_value() { grep "^$1" "$RUN_DIR/loss.txt" | grep -o '[0-9]*$'; }

missing="$(seq_value missing)"
check "All edges connected again after the restart (s)" "< 120" "${reconnect:-not within $RECONNECT_LIMIT_S}" le "$reconnect" 119
check "Peak CPU of an EMQX node (% of the machine)" "< 80" "$cpu" le "$cpu" 79.9
check "Acknowledged messages missing from the database after resend" "0" "$missing" [ "$missing" = "0" ]
metric "Time from the restart until every gap was filled (s)" "${filled:-not within ${TAIL_S}s}"
metric "Messages lost after the PUBACK and asked for again" "$(loss_value 'sequence numbers state asked for')"
metric "... lost in the MQTT broker" "$(loss_value 'lost in the MQTT broker')"
metric "... lost in the bridge" "$(loss_value 'lost in the bridge')"
metric "... requested although they had reached Kafka" "$(loss_value 'reached Kafka before')"
metric "Messages the edges published again" "$(summary_field "$summary" resent)"
metric "Bridge stage counters (received / produced / acked, telemetry)" "$(prom 'sum(bridge_messages_total{stage="received",kind="telemetry"})') / $(prom 'sum(bridge_messages_total{stage="produced",kind="telemetry"})') / $(prom 'sum(bridge_messages_total{stage="acked",kind="telemetry"})')"
metric "Reconnects" "$(summary_field "$summary" reconnects)"
metric "Messages replayed from the edge buffers" "$(summary_field "$summary" replayed)"
metric "Messages the edges could not deliver" "$(summary_field "$summary" unacked)"
metric "Messages dropped from full edge buffers" "$(summary_field "$summary" dropped)"
metric "Duplicate rows" "$(seq_value 'duplicate rows')"
metric "Late realtime messages (ingest_late_total)" "$(prom 'sum(ingest_late_total)')"
report 3 "Reconnect storm"
