#!/usr/bin/env bash
# Scenario 3g, deliberate loss after the PUBACK: every edge skips 1% of its
# sequence numbers (edge-sim fault "gap") as if the broker had lost them.
# state must notice every gap and ask for it; afterwards nothing is missing.
export STATE_RESEND_ENABLED=true STATE_RESEND_AFTER="${STATE_RESEND_AFTER:-$(if [ "${FULL:-0}" = "1" ]; then echo 1m; else echo 20s; fi)}"
source "$(dirname "$0")/lib.sh"

MACHINES="${MACHINES:-$(pick 200 1000)}"
DURATION_S="${DURATION_S:-$(pick 180 1800)}"
GAP_RATE="${GAP_RATE:-0.01}"
# Time for the last gaps: RESEND_AFTER, a sweep (30 s), a heartbeat (30 s) and the resend itself.
LINGER_S="${LINGER_S:-$(pick 150 300)}"
trap stack_down EXIT
gaps_filled() { [ "$(gap_candidates)" = "0" ]; }

stack_up
seed_configs "$MACHINES"
log "edge-sim: $MACHINES edges for ${DURATION_S}s, skipping $GAP_RATE of the sequence numbers"
edge_sim_start main --machines "$MACHINES" --window 1 --duration "${DURATION_S}s" --linger "${LINGER_S}s" \
  --faults gap --fault-rate "$GAP_RATE" --resend
sleep "$DURATION_S"
ended_at=$(date +%s)
log "production ended; waiting for the remaining gaps to be filled"
sleep 5
if wait_until "$LINGER_S" "the gaps to be filled" gaps_filled >/dev/null; then filled=$(($(date +%s) - ended_at)); else filled=""; fi
summary="$(edge_sim_wait main)"
settle 300
seqcheck main

missing="$(seq_value missing)"
duplicates="$(seq_value 'duplicate rows')"
gaps="$(grep -c '"fault":"gap"' "$RUN_DIR/main.jsonl" || true)"
resent="$(summary_field "$summary" resent)"
lost="$(prom 'sum(edge_seq_gap_total)')"
check "Acknowledged messages missing from the database after resend" "0" "$missing" [ "$missing" = "0" ]
check "Skipped messages published again" "$gaps (all skipped)" "$resent" [ "$resent" -ge "$gaps" ]
check "Duplicate rows" "0" "$duplicates" [ "$duplicates" = "0" ]
check "Sequence numbers state counted as lost" "0" "${lost:-0}" [ "${lost:-0}" = "0" ]
metric "Time from the end of production until every gap was filled (s)" "${filled:-not within ${LINGER_S}s}"
metric "Sequence numbers skipped" "$gaps"
metric "Resend requests sent by state" "$(prom 'sum(state_resend_requests_total)')"
metric "Sequence numbers asked for" "$(prom 'sum(state_resend_requested_messages_total)')"
metric "p99 time from window end to database of resent rows (s)" "$(psql_q "SELECT round(COALESCE(percentile_cont(0.99) WITHIN GROUP (ORDER BY extract(epoch FROM ingested_at - ts)), 0)::numeric, 1) FROM gauge_reading WHERE replayed AND ingested_at >= '$STARTED_AT'")"
metric "Messages acknowledged by the broker" "$(summary_field "$summary" acked)"
report 3g "Deliberate loss after the PUBACK"
