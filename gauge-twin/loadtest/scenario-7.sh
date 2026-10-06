#!/usr/bin/env bash
# Scenario 7, dirty data: 5% of the messages are out of range, undecodable,
# duplicated or carry a skewed clock. Every one of them must end up flagged or
# in rejected_reading, and no row may be duplicated.
source "$(dirname "$0")/lib.sh"

MACHINES="${MACHINES:-$(pick 100 1000)}"
DURATION="${DURATION:-$(pick 2m 30m)}"
trap stack_down EXIT

stack_up
seed_configs "$MACHINES"
log "edge-sim: $MACHINES machines for $DURATION with 5% faulty messages"
edge_sim_start main --machines "$MACHINES" --window 1 --duration "$DURATION" \
  --faults out_of_range,bad_schema,duplicate,clock_skew --fault-rate 0.05
summary="$(edge_sim_wait main)"
settle 300
seqcheck main

missing="$(seq_value missing)"
duplicates="$(seq_value 'duplicate rows')"
bad_sent="$(seq_value 'bad_schema sent')"
bad_rejected="$(seq_value 'in rejected_reading')"
range_sent="$(seq_value 'out_of_range sent')"
range_flagged="$(grep -o 'out_of_range sent: [0-9]*, flagged in DB: [0-9]*' "$RUN_DIR/seqcheck.txt" | grep -o '[0-9]*$')"
skew_sent="$(seq_value 'clock_skew sent in real time')"
skew_flagged="$(grep -o 'replayed), flagged in DB: [0-9]*' "$RUN_DIR/seqcheck.txt" | grep -o '[0-9]*$')"

check "Acknowledged messages missing from the database" "0" "$missing" [ "$missing" = "0" ]
check "Duplicate rows" "0" "$duplicates" [ "$duplicates" = "0" ]
check "Undecodable messages in rejected_reading" "$bad_sent (all sent)" "$bad_rejected" [ "$bad_sent" = "$bad_rejected" ]
check "Out-of-range messages flagged" "$range_sent (all sent)" "$range_flagged" [ "$range_sent" = "$range_flagged" ]
check "Clock-skewed messages flagged" "$skew_sent (all sent in real time)" "$skew_flagged" [ "$skew_sent" = "$skew_flagged" ]
metric "Messages acknowledged by the broker" "$(summary_field "$summary" acked)"
metric "Faults injected" "$(summary_field "$summary" faults)"
metric "Dead-lettered records" "$(prom 'sum(ingest_messages_total{result="dlq"})')"
report 7 "Dirty data"
