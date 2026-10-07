#!/usr/bin/env bash
# Emergency stop of every load test on this machine: stops the load-test
# scripts, then removes every container of the gauge-twin projects. Data
# volumes are kept. Nothing outside the gauge-twin projects is touched.
# Anyone allowed to use Docker can run it:  sudo loadtest/stop-full.sh
set -uo pipefail
DOCKER="${DOCKER:-docker}"

echo "stopping the load-test scripts"
pkill -TERM -f 'loadtest/(run-full|scenario-[0-9a-z]+)\.sh' 2>/dev/null
sleep 5
pkill -KILL -f 'loadtest/(run-full|scenario-[0-9a-z]+)\.sh' 2>/dev/null

echo "removing the gauge-twin containers"
ids="$( {
  for project in gauge-twin gauge-twin-server gauge-twin-edge gauge-twin-sim gauge-twin-loadtest; do
    $DOCKER ps -aq --filter "label=com.docker.compose.project=$project"
  done
  $DOCKER ps -aq --filter "name=^gauge-twin-edge-sim"
} | sort -u)"
if [ -n "$ids" ]; then
  # shellcheck disable=SC2086
  $DOCKER rm -f $ids >/dev/null
fi
echo "removed $(echo "$ids" | grep -c . ) container(s); remaining:"
$DOCKER ps --format '{{.Names}}' | grep '^gauge-twin' || echo "  none"
