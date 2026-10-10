#!/bin/sh
# Demo of three factories, one fake camera (RTSP stream) per camera position. Run from the repository root, after `make up`:
#
#   sh infra/compose/sim/demo-factory.sh
#
# Publishes data/sim-factory/<stream>/video.mp4 as rtsp://mediamtx:8554/<stream>, starts the server services and the
# simulated edge, and registers the cameras (cameras.json) and the station configs (stations/*.json) through
# config-api. With PRUNE=1 it first removes every other station config and camera, so that only the demo factories
# are listed (their readings stay in the history). It also starts discover-svc, which looks for gauges nobody has
# declared yet (camera cam-tu-dien-moi has three); DISCOVERY=0 leaves it out, as its image is about 2 GB.
# docs/DEMO_RTSP.md lists the streams and how to watch them.
set -eu

DATA="${SIM_DATA_DIR:-$PWD/data/sim-factory}"
MODELS="${EDGE_MODEL_DIR:-$PWD/data/ml-runs/demo-all2}"
export CONFIG_API_PORT="${CONFIG_API_PORT:-8090}" SIM_DATA_DIR="$DATA" EDGE_SEED_CONFIGS=0
export EDGE_MODEL_DIR="$MODELS" PREVIEW_MODEL_DIR="${PREVIEW_MODEL_DIR:-$MODELS}"
if [ "${DISCOVERY:-1}" = 1 ]; then
  export COMPOSE_PROFILES=discovery DISCOVER_INTERVAL="${DISCOVER_INTERVAL:-60}"
  export DISCOVER_CPUS="${DISCOVER_CPUS:-6}" DISCOVER_THREADS="${DISCOVER_THREADS:-6}"
fi
API="http://localhost:$CONFIG_API_PORT"

[ -f "$DATA/cameras.json" ] || { echo "no demo data in $DATA" >&2; exit 1; }

# The edge keeps the configs of its last run; machines that are no longer served would leave it waiting on dead streams.
make edge-down DOWN_FLAGS=-v
make sim-down
make sim-up
make server-up CONFIG_API_PORT="$CONFIG_API_PORT"
# The edge gets its machines from config-api (edge assignment), not from EDGE_MACHINES.
make edge-up EDGE_MACHINES=

until curl -fs "$API/v1/cameras" >/dev/null; do sleep 1; done
python3 - "$DATA" "$API" "${PRUNE:-0}" "${EDGE_ID:-edge-0001}" <<'PY'
import json, sys, urllib.request
from pathlib import Path

data, api, prune, edge = Path(sys.argv[1]), sys.argv[2], sys.argv[3] == "1", sys.argv[4]


def call(method, path, body=None):
    raw = json.dumps(body).encode() if body is not None else None
    request = urllib.request.Request(api + path, raw, {"Content-Type": "application/json"}, method=method)
    with urllib.request.urlopen(request) as response:
        return json.loads(response.read() or "null")


cameras = json.loads((data / "cameras.json").read_text())
configs = [json.loads(p.read_text()) for p in sorted(data.glob("stations/*.json"))]
if prune:
    keep = {c["machine_id"] for c in configs}
    stale = [s["machine_id"] for s in call("GET", "/v1/stations")["stations"] if s["machine_id"] not in keep]
    for machine in stale:
        call("DELETE", f"/v1/stations/{machine}")
    unused = [c["camera_id"] for c in call("GET", "/v1/cameras")["cameras"] if c["camera_id"] not in cameras]
    for camera in unused:
        call("DELETE", f"/v1/cameras/{camera}")
    print(f"removed {len(stale)} other stations and {len(unused)} other cameras")
for camera_id, camera in cameras.items():
    call("PUT", f"/v1/cameras/{camera_id}", camera)
for config in configs:
    call("PUT", f"/v1/stations/{config['machine_id']}", config)
    print("registered", config["plant"], config["line"], config["machine_id"], len(config["gauges"]), "gauges")
# Every machine of the demo is read by the one simulated edge.
call("PUT", f"/v1/edges/{edge}", {"machine_ids": [c["machine_id"] for c in configs]})
print("assigned", len(configs), "machines to", edge)
PY
echo "streams: rtsp://localhost:${RTSP_PORT:-8554}/<stream>, see docs/DEMO_RTSP.md"
