#!/usr/bin/env bash
# Scenario 4, plant network outage: 20% of the edges lose the network for a
# while. Their buffers must drain completely afterwards without duplicates,
# and the realtime data of the other edges must not be delayed by more than 5 s.
source "$(dirname "$0")/lib.sh"

MACHINES="${MACHINES:-$(pick 100 1000)}"
CUT_S="${CUT_S:-$(pick 60 1800)}"
LEAD_S="${LEAD_S:-30}"
# Reconnect backoff (up to 60 s) plus the replay at 50 messages/s per edge.
TAIL_S="${TAIL_S:-$((90 + CUT_S / 25))}"
CUT=$((MACHINES / 5))
STAY=$((MACHINES - CUT))
trap stack_down EXIT

stack_up
seed_configs "$MACHINES"
total=$((LEAD_S + CUT_S + TAIL_S))
log "edge-sim: $STAY edges stay online, $CUT lose the network for ${CUT_S}s"
edge_sim_start stay --machines "$STAY" --window 1 --duration "${total}s"
edge_sim_start cut --machines "$CUT" --offset "$STAY" --window 1 --duration "${total}s" --buffer-max $((CUT_S * 2 + 1000))
sleep "$LEAD_S"
cut_at="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
docker network disconnect "$PROJECT" "$PROJECT-edge-sim-cut"
sleep "$CUT_S"
docker network connect --alias edge-sim "$PROJECT" "$PROJECT-edge-sim-cut"
log "network restored"
stay_summary="$(edge_sim_wait stay)"
cut_summary="$(edge_sim_wait cut)"
settle 300
seqcheck stay cut

# Delay of realtime readings of the edges that stayed online, from the cut on.
last_stay="$(printf 'edge-%04d' "$STAY")"
delay="$(psql_q "SELECT round(COALESCE(percentile_cont(0.99) WITHIN GROUP (ORDER BY extract(epoch FROM ingested_at - ts)), 0)::numeric, 3)
  FROM gauge_reading WHERE NOT replayed AND edge_id <= '$last_stay' AND ingested_at >= '$cut_at'")"
missing="$(seq_value missing)"
duplicates="$(seq_value 'duplicate rows')"
undelivered="$(summary_field "$cut_summary" unacked)"
dropped="$(summary_field "$cut_summary" dropped)"
check "Buffered messages never delivered" "0" "$undelivered" [ "$undelivered" = "0" ]
check "Messages dropped from full edge buffers" "0" "$dropped" [ "$dropped" = "0" ]
check "Acknowledged messages missing from the database" "0" "$missing" [ "$missing" = "0" ]
check "Duplicate rows" "0" "$duplicates" [ "$duplicates" = "0" ]
check "p99 delay of realtime data of the other edges (s)" "< 5" "$delay" le "$delay" 4.999
metric "Messages replayed from the buffers" "$(summary_field "$cut_summary" replayed)"
metric "Replayed rows in the database" "$(seq_value 'replayed rows')"
metric "Out-of-order realtime rows" "$(seq_value 'out-of-order realtime rows')"
metric "Messages acknowledged, edges that stayed online" "$(summary_field "$stay_summary" acked)"
report 4 "Plant network outage"
