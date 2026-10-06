#!/usr/bin/env python3
"""Turns the results of a load-test scenario into a Markdown report."""

import argparse
import json
import sys
from datetime import datetime, timezone
from pathlib import Path


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--scenario", required=True)
    parser.add_argument("--title", required=True)
    parser.add_argument("--results", type=Path, required=True, help="JSON lines written by lib.sh")
    parser.add_argument("--run-id", required=True)
    parser.add_argument("--started", required=True)
    parser.add_argument("--full", default="0")
    parser.add_argument("--profile", default="dev")
    parser.add_argument("--snapshot", default="")
    parser.add_argument("--cpuset", default="")
    parser.add_argument("--seqcheck", type=Path)
    parser.add_argument("--out", type=Path, required=True)
    args = parser.parse_args()

    entries = [json.loads(line) for line in args.results.read_text().splitlines() if line.strip()]
    criteria = [e for e in entries if e["kind"] == "criterion"]
    metrics = [e for e in entries if e["kind"] == "metric"]
    judged = [c for c in criteria if c["result"] != "info"]
    failed = [c for c in judged if c["result"] == "fail"]
    verdict = "PASS" if judged and not failed else ("FAIL" if failed else "NO CRITERIA")
    mark = {"pass": "pass", "fail": "**FAIL**", "info": "measured only"}

    lines = [
        f"# Scenario {args.scenario}: {args.title}",
        "",
        f"**Result: {verdict}**" + (f" ({len(failed)} of {len(judged)} criteria failed)" if failed else ""),
        "",
        f"- Run: `{args.run_id}`, started {args.started}, report written "
        f"{datetime.now(timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ')}",
        f"- Size: {'FULL (as in SPEC section 8)' if args.full == '1' else 'short run (script check, not the spec size)'}",
        f"- Infrastructure profile: `{args.profile}`",
        "- Load generator: edge-sim on the same machine as the infrastructure"
        + (f", pinned to cores {args.cpuset}" if args.cpuset else ", not pinned to dedicated cores"),
        f"- Grafana snapshot: {args.snapshot or 'not available'}",
        "",
        "## Criteria",
        "",
        "| Criterion | Target | Measured | Result |",
        "| --- | --- | --- | --- |",
    ]
    lines += [f"| {c['name']} | {c['target']} | {c['measured']} | {mark[c['result']]} |" for c in criteria]
    if metrics:
        lines += ["", "## Figures", "", "| Figure | Value |", "| --- | --- |"]
        lines += [f"| {m['name']} | {m['value']} |" for m in metrics]
    if args.seqcheck and args.seqcheck.exists() and args.seqcheck.read_text().strip():
        lines += ["", "## Sequence check", "", "```text", args.seqcheck.read_text().rstrip(), "```"]
    args.out.write_text("\n".join(lines) + "\n")
    print(args.out)
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
