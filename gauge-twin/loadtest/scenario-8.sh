#!/usr/bin/env bash
# Scenario 8, a real edge over a long time: the RTSP streams of every station
# in data/sim go through the pipeline and edge-agent. edge-agent must not leak
# memory (RSS growth < 5%) and nothing may restart. Until ds-pipeline exists
# the CPU reference pipeline ds-sim stands in, and its FPS is informational.
source "$(dirname "$0")/lib.sh"

# The spec asks for 72 h; the first FULL round runs 12 h with ds-sim.
DURATION_S="${DURATION_S:-$(pick 300 43200)}"
WARMUP_S="${WARMUP_S:-$(pick 150 600)}"
SAMPLE_S="${SAMPLE_S:-$(pick 10 60)}"
if [ -z "${EDGE_MODEL_DIR:-}" ] && [ -d "$ROOT/data/ml-runs/server/onnx" ]; then
  export EDGE_MODEL_DIR="$ROOT/data/ml-runs/server/onnx"
fi
# shellcheck disable=SC2086
EDGE="docker compose -f infra/compose/edge.yml ${LOADTEST_EDGE_OVERRIDES:-}"
SIM="docker compose -f infra/compose/sim.yml"
AGENT="$PROJECT-edge-edge-agent-1"
PIPELINE="$PROJECT-edge-ds-sim-1"
SAMPLES="$RUN_DIR/edge-samples.txt"
extra_down() { $EDGE down -v >/dev/null 2>&1; $SIM down >/dev/null 2>&1; }
trap stack_down EXIT

# heap_profile <label>: store a heap profile of edge-agent (go tool pprof reads it).
export EDGE_AGENT_PPROF=true
heap_profile() {
  docker exec "$PROJECT-prometheus-1" wget -q -O - "http://edge-agent:8080/debug/pprof/heap?gc=1" >"$RUN_DIR/heap-$1.pb.gz" 2>/dev/null ||
    log "heap profile $1 could not be taken"
}

# agent_metric <metric>: current value, summed over its series.
agent_metric() {
  docker exec "$PROJECT-prometheus-1" wget -q -O - http://edge-agent:8080/metrics 2>/dev/null |
    awk -v m="$1" '$1 == m || index($1, m "{") == 1 { s += $2 } END { printf "%.0f\n", s }'
}
# mem_bytes <container>: memory in use according to Docker.
mem_bytes() { docker stats --no-stream --format '{{.MemUsage}}' "$1" | python3 -c 'import sys, re
m = re.match(r"([0-9.]+)([A-Za-z]+)", sys.stdin.read().strip())
print(int(float(m.group(1)) * {"B": 1, "KiB": 2**10, "MiB": 2**20, "GiB": 2**30}[m.group(2)]))'; }

machines=()
mkdir -p "$RUN_DIR/configs"
for dir in data/sim/*/; do
  [ -f "$dir/station_config.json" ] || continue
  machine="$(basename "$dir")"
  machines+=("SIM/L01/$machine")
  cp "$dir/station_config.json" "$RUN_DIR/configs/$machine.json"
done
[ "${#machines[@]}" -gt 0 ] || { log "no rendered stations in data/sim (run make render)"; exit 1; }

stack_up
net_run loadtest/seed-configs.sh "data/loadtest/$RUN_ID/configs" http://config-api:8080 >/dev/null
log "starting ${#machines[@]} RTSP streams, the pipeline and edge-agent"
$SIM up -d --wait >/dev/null 2>&1
EDGE_MACHINES="$(IFS=,; echo "${machines[*]}")" $EDGE up -d --build >/dev/null 2>&1
log "warming up for ${WARMUP_S}s, then sampling every ${SAMPLE_S}s for ${DURATION_S}s"
sleep "$WARMUP_S"
: >"$SAMPLES"
heap_profile start
began=$(date +%s)
end=$((began + DURATION_S))
hour_taken=0
while [ "$(date +%s)" -lt "$end" ]; do
  if [ "$hour_taken" = "0" ] && [ $(($(date +%s) - began)) -ge 3600 ]; then
    heap_profile 1h
    hour_taken=1
  fi
  echo "$(date +%s) $(agent_metric process_resident_memory_bytes) $(agent_metric edge_agent_frames_received_total) $(mem_bytes "$PIPELINE")" >>"$SAMPLES"
  sleep "$SAMPLE_S"
done

heap_profile end

# Median of the first and of the last fifth of the samples.
read -r growth first_mb last_mb pipeline_growth fps < <(python3 - "$SAMPLES" "${#machines[@]}" <<'PY'
import statistics, sys
rows = [[float(v) for v in line.split()] for line in open(sys.argv[1]) if len(line.split()) == 4]
n = max(1, len(rows) // 5)
def growth(col):
    first, last = statistics.median(r[col] for r in rows[:n]), statistics.median(r[col] for r in rows[-n:])
    return (last - first) / first * 100, first, last
agent, first, last = growth(1)
fps = (rows[-1][2] - rows[0][2]) / (rows[-1][0] - rows[0][0]) / int(sys.argv[2])
print(f"{agent:.2f} {first / 2**20:.1f} {last / 2**20:.1f} {growth(3)[0]:.2f} {fps:.2f}")
PY
)
agent_restarts="$(restarts "$AGENT")"
pipeline_restarts="$(restarts "$PIPELINE")"
rows="$(psql_q "SELECT count(*) FROM gauge_reading WHERE edge_id = '${EDGE_ID:-edge-0001}' AND ingested_at >= '$STARTED_AT'")"

check "edge-agent memory growth (%)" "< 5" "$growth (${first_mb} MiB -> ${last_mb} MiB)" le "$growth" 4.999
check "edge-agent container restarts" "0" "$agent_restarts" [ "$agent_restarts" = "0" ]
check "Pipeline container restarts" "0" "$pipeline_restarts" [ "$pipeline_restarts" = "0" ]
check "Readings stored in the database" "> 0" "$rows" [ "$rows" -gt 0 ]
criterion "Frames per second and camera (ds-sim on CPU)" "informational" "$fps" info
metric "Heap profiles (start, after 1 h, end)" "data/loadtest/$RUN_ID/heap-*.pb.gz"
metric "Cameras" "${#machines[@]}"
metric "Measured for (s, after ${WARMUP_S}s warm-up)" "$DURATION_S"
metric "Pipeline (ds-sim) memory growth (%)" "$pipeline_growth"
metric "Pipeline restart commands sent by the watchdog" "$(docker exec "$PROJECT-prometheus-1" wget -q -O - http://edge-agent:8080/metrics | awk '/^edge_agent_pipeline_commands_total/ && /RESTART|restart/ { s += $2 } END { printf "%d", s }')"
metric "Publish errors" "$(agent_metric edge_agent_publish_errors_total)"
metric "MQTT reconnects" "$(agent_metric edge_agent_reconnects_total)"
metric "Frames dropped by edge-agent" "$(agent_metric edge_agent_frames_dropped_total)"
metric "Messages dropped from the buffer" "$(agent_metric edge_agent_buffer_dropped_total)"
: >"$RUN_DIR/seqcheck.txt"
report 8 "Real edge, long run"
