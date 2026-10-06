#!/usr/bin/env bash
# Scenario 5, broker node failure: one EMQX node and one Kafka broker are
# killed and started again later. MODE=a runs without resend requests and
# measures what is really lost; MODE=b lets state ask the edges for the
# missing sequence numbers and must end without loss.
PROFILE="${PROFILE:-cluster}"
MODE="${MODE:?MODE must be a or b}"
source "$(dirname "$0")/lib.sh"

MACHINES="${MACHINES:-$(pick 200 1000)}"
LEAD_S="${LEAD_S:-60}"
DOWN_S="${DOWN_S:-$(pick 60 300)}"
TAIL_S="${TAIL_S:-$(pick 150 600)}"
EMQX_NODE="$PROJECT-emqx2-1"
KAFKA_NODE="$PROJECT-redpanda-1-1"
sim_args=()
if [ "$MODE" = "b" ]; then
  export STATE_RESEND_ENABLED=true STATE_RESEND_AFTER="${STATE_RESEND_AFTER:-$(pick 20s 1m)}"
  sim_args=(--resend)
else
  export STATE_RESEND_ENABLED=false
fi
trap stack_down EXIT

emqx_nodes() { docker exec "$PROJECT-emqx1-1" emqx ctl cluster status | tr -d '\n' | sed 's/stopped_nodes.*//' | grep -o 'emqx@' | wc -l | tr -d ' '; }
cluster_healthy() {
  [ "$(emqx_nodes)" = "3" ] && docker exec "$PROJECT-redpanda-0-1" rpk cluster health | grep -Eq 'Healthy:.+true'
}
gaps_filled() { [ "$(gap_candidates)" = "0" ]; }

stack_up
seed_configs "$MACHINES"
log "edge-sim: $MACHINES edges, resend $([ "$MODE" = "b" ] && echo on || echo off)"
edge_sim_start main --machines "$MACHINES" --window 1 --duration "$((LEAD_S + DOWN_S + TAIL_S))s" ${sim_args[@]+"${sim_args[@]}"}
sleep "$LEAD_S"
log "killing $EMQX_NODE and $KAFKA_NODE"
killed_at=$(date +%s)
docker kill "$EMQX_NODE" "$KAFKA_NODE" >/dev/null
sleep "$DOWN_S"
docker start "$EMQX_NODE" "$KAFKA_NODE" >/dev/null
started_at=$(date +%s)
healed="$(wait_until 300 "the clusters to be whole again" cluster_healthy || echo "")"
log "clusters whole again ${healed:-?}s after the nodes were started"
filled=""
if [ "$MODE" = "b" ]; then
  # Requests go out once a gap is RESEND_AFTER old and the edge is online
  # with an empty buffer; the edge-sim is still running and answers them.
  log "waiting for the resend requests to be answered"
  wait_until "$TAIL_S" "the gaps to be filled" gaps_filled >/dev/null && filled=$(($(date +%s) - killed_at))
fi
summary="$(edge_sim_wait main)"
settle 300
seqcheck main

missing="$(seq_value missing)"
check "Clusters whole again after the nodes came back (s)" "<= 300" "${healed:-not within 300}" le "$healed" 300
if [ "$MODE" = "b" ]; then
  check "Acknowledged messages missing from the database after resend" "0" "$missing" [ "$missing" = "0" ]
  metric "Time from the node kill until every gap was filled (s)" "${filled:-not within the wait}"
  metric "Resend requests sent by state" "$(prom 'sum(state_resend_requests_total)')"
  metric "Sequence numbers asked for" "$(prom 'sum(state_resend_requested_messages_total)')"
  metric "Messages the edges published again" "$(prom 'sum(state_resend_resent_messages_total)')"
else
  criterion "Acknowledged messages missing from the database (no resend)" "measured" "$missing" info
fi
metric "Nodes down for (s)" "$((started_at - killed_at))"
metric "Messages acknowledged by the broker" "$(summary_field "$summary" acked)"
metric "Reconnects" "$(summary_field "$summary" reconnects)"
metric "Messages replayed from the edge buffers" "$(summary_field "$summary" replayed)"
metric "Messages the edges could not deliver" "$(summary_field "$summary" unacked)"
metric "Publish errors at the edges" "$(summary_field "$summary" publish_errors)"
metric "Duplicate rows" "$(seq_value 'duplicate rows')"
metric "Sequence numbers state counted as lost" "$(prom 'sum(edge_seq_gap_total)')"
if [ "$MODE" = "b" ]; then report 5b "Broker node failure, automatic resend"; else report 5a "Broker node failure, no resend"; fi
