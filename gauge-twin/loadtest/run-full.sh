#!/usr/bin/env bash
# Runs load-test scenarios one after another on a shared server (SPEC
# section 8): no host ports, CPU and memory limits, infrastructure and load
# generator pinned to separate cores. One scenario failing does not stop the
# next. The batch has a hard time limit; when it is reached everything is
# stopped with stop-full.sh so the run never spills into working hours.
#
# Usage: MAX_HOURS=<h> run-full.sh <scenario>...
#   night 1: MAX_HOURS=8    run-full.sh 2 3 3g 4 5a 5b 6 7
#   night 2: MAX_HOURS=5.5  run-full.sh 1
#   night 3: MAX_HOURS=13.5 run-full.sh 8
# Environment: FULL (default 1), INFRA_CPUSET (8-31), EDGE_SIM_CPUSET (0-7),
#   DOCKER_SUDO=1 when Docker is only usable through sudo (only the docker
#   command is elevated; run `sudo -v` first, the run keeps it fresh).
set -uo pipefail
cd "$(dirname "$0")/.."
ROOT="$PWD"

: "${MAX_HOURS:?MAX_HOURS is required: the hard time limit of the batch}"
[ "$#" -gt 0 ] || { echo "usage: MAX_HOURS=<h> $0 <scenario>..." >&2; exit 2; }

if [ "${DOCKER_SUDO:-0}" = "1" ]; then
  sudo -n -v 2>/dev/null || { echo "run 'sudo -v' first" >&2; exit 2; }
  export PATH="$ROOT/loadtest/sudo-bin:$PATH"
  # Keep the sudo timestamp valid for the whole batch.
  (while sleep 240; do sudo -n -v || exit; done) &
  KEEPALIVE=$!
  trap 'kill $KEEPALIVE 2>/dev/null' EXIT
fi

# The batch runs as a child under a hard limit; this outer level only waits,
# cleans up after a timeout and fixes file ownership.
if [ -z "${RUN_FULL_INNER:-}" ]; then
  limit="$(python3 -c "print(int(float('$MAX_HOURS') * 3600))")"
  # The batch gets its own process group (job control) so that the whole
  # tree can be stopped at the limit; works without GNU timeout.
  set -m
  RUN_FULL_INNER=1 "$0" "$@" &
  batch=$!
  set +m
  expired="$(mktemp)"
  rm -f "$expired"
  (sleep "$limit" && touch "$expired" && kill -TERM -- "-$batch" 2>/dev/null && sleep 300 && kill -KILL -- "-$batch" 2>/dev/null) &
  watchdog=$!
  wait "$batch"
  rc=$?
  pkill -P "$watchdog" 2>/dev/null
  kill "$watchdog" 2>/dev/null
  if [ -e "$expired" ]; then
    rm -f "$expired"
    rc=124
    echo "[$(date '+%F %T')] time limit of ${MAX_HOURS} h reached: stopping everything" >&2
    loadtest/stop-full.sh
  fi
  if [ "${DOCKER_SUDO:-0}" = "1" ]; then
    sudo -n chown -R "$(id -u):$(id -g)" "$ROOT/data" "$ROOT/gen" 2>/dev/null
  fi
  exit "$rc"
fi

export FULL="${FULL:-1}"
export INFRA_CPUSET="${INFRA_CPUSET:-8-31}" EDGE_SIM_CPUSET="${EDGE_SIM_CPUSET:-0-7}"
export EDGE_SIM_CPUS="${EDGE_SIM_CPUS:-8}" EDGE_SIM_MEMORY="${EDGE_SIM_MEMORY:-4g}"
export LOADTEST_OVERRIDES="-f infra/compose/loadtest/shared-server.infra.yml"
export LOADTEST_SERVER_OVERRIDES="-f infra/compose/loadtest/shared-server.server.yml"
export LOADTEST_EDGE_OVERRIDES="-f infra/compose/loadtest/shared-server.edge.yml"
export TOOLS_IMAGE="gauge-twin-tools:$(cksum tools/Dockerfile | cut -d ' ' -f 1)"

OUT="data/loadtest/full-$(date +%Y%m%d-%H%M%S)"
mkdir -p "$OUT"
echo "[$(date '+%F %T')] batch: $* (limit ${MAX_HOURS} h, FULL=$FULL)" | tee -a "$OUT/progress.txt"
for scenario in "$@"; do
  echo "[$(date '+%F %T')] scenario $scenario: start" | tee -a "$OUT/progress.txt"
  loadtest/scenario-"$scenario".sh >"$OUT/scenario-$scenario.log" 2>&1
  echo "[$(date '+%F %T')] scenario $scenario: exit $?" | tee -a "$OUT/progress.txt"
  sleep 20
done
echo "[$(date '+%F %T')] all done" | tee -a "$OUT/progress.txt"
