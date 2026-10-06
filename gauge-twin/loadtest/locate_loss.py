#!/usr/bin/env python3
"""Locates where the messages that state had to ask for again were lost.

Reads the JSON logs of state ("resend requested") and of the mqtt-bridge
replicas started with TRACE_SEQ=true ("trace"). A requested sequence number
that the bridge received only as the resent copy never reached the bridge the
first time: it was lost in the MQTT broker. One the bridge had received
before was lost inside the bridge or behind it.
"""

import argparse
import json
import sys
from collections import Counter
from pathlib import Path


def records(path: Path):
    for line in path.read_text(errors="replace").splitlines():
        if line.startswith("{"):
            try:
                yield json.loads(line)
            except json.JSONDecodeError:
                continue


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--state", type=Path, required=True)
    parser.add_argument("--bridge", type=Path, nargs="+", required=True)
    args = parser.parse_args()

    requested = set()
    for rec in records(args.state):
        if rec.get("msg") == "resend requested":
            requested.update((rec["edge_id"], seq) for seq in range(rec["from_seq"], rec["to_seq"] + 1))
    received, produced = Counter(), Counter()
    for path in args.bridge:
        for rec in records(path):
            if rec.get("msg") == "trace":
                (received if rec["stage"] == "received" else produced)[(rec["edge_id"], rec["seq"])] += 1

    never = sum(1 for key in requested if received[key] == 0)
    broker = sum(1 for key in requested if received[key] == 1)
    bridge = sum(1 for key in requested if received[key] > 1 and produced[key] <= 1)
    behind = sum(1 for key in requested if received[key] > 1 and produced[key] > 1)
    print(f"sequence numbers state asked for: {len(requested)}")
    print(f"lost in the MQTT broker (bridge saw only the resent copy): {broker}")
    print(f"lost in the bridge (received before, produced only once): {bridge}")
    print(f"reached Kafka before (requested although not lost): {behind}")
    print(f"never seen by the bridge, not even resent: {never}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
