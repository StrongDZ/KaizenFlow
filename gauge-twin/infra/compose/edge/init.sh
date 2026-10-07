#!/bin/sh
# Makes the shared edge volumes writable by the unprivileged edge processes
# and, when SEED_CONFIGS=1, copies the rendered station configs into the
# config directory as <machine_id>.json (stand-in for config-api).
set -eu

chown 65534:65534 /tmp/zmq /config /buffer
rm -f /tmp/zmq/frames /tmp/zmq/control

if [ "${SEED_CONFIGS:-0}" = "1" ]; then
  count=0
  for config in /sim/*/station_config.json; do
    [ -f "$config" ] || continue
    machine="$(basename "$(dirname "$config")")"
    # Never overwrite a config edge-agent already manages.
    if [ ! -f "/config/$machine.json" ]; then
      cp "$config" "/config/$machine.json"
      chown 65534:65534 "/config/$machine.json"
      count=$((count + 1))
    fi
  done
  echo "seeded $count station config(s)"
fi
