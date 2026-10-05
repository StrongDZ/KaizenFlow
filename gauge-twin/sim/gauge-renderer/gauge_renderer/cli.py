"""Command line entry point: render --stations 20 --minutes 30 --fps 10 --seed 42 --out data/sim/"""

from __future__ import annotations

import argparse
import os
import sys
import time
from concurrent.futures import ProcessPoolExecutor, as_completed
from pathlib import Path

from gauge_renderer.noise import LEVELS
from gauge_renderer.render import render_station


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        prog="render", description="Render synthetic gauge station videos with ground truth."
    )
    parser.add_argument("--stations", type=int, default=1, help="number of stations to render")
    parser.add_argument(
        "--minutes", type=float, default=1.0, help="length of each video in minutes"
    )
    parser.add_argument("--fps", type=float, default=10.0, help="video frame rate")
    parser.add_argument("--seed", type=int, default=42, help="seed; same seed, same output")
    parser.add_argument("--out", type=Path, required=True, help="output directory")
    parser.add_argument("--noise", choices=sorted(LEVELS), default="medium", help="noise level")
    parser.add_argument(
        "--keep-frames", type=int, default=3, help="lossless reference frames kept per station"
    )
    parser.add_argument(
        "--workers", type=int, default=0, help="parallel stations (default: one per CPU, at most 8)"
    )
    args = parser.parse_args(argv)
    if args.stations < 1 or args.minutes <= 0 or args.fps <= 0 or args.keep_frames < 0:
        parser.error("--stations, --minutes and --fps must be positive, --keep-frames non-negative")
    return args


def main(argv: list[str] | None = None) -> int:
    args = parse_args(argv)
    n_frames = max(1, int(round(args.minutes * 60.0 * args.fps)))
    workers = args.workers or min(args.stations, os.cpu_count() or 1, 8)
    args.out.mkdir(parents=True, exist_ok=True)
    started = time.monotonic()
    print(
        f"rendering {args.stations} station(s), {n_frames} frames each at {args.fps:g} fps, "
        f"noise={args.noise}, seed={args.seed}, workers={workers}",
        flush=True,
    )

    job = (args.seed, args.out, n_frames, args.fps, args.noise, args.keep_frames)
    failed = 0
    with ProcessPoolExecutor(max_workers=workers) as pool:
        futures = {
            pool.submit(render_station, job[0], index, *job[1:]): index
            for index in range(args.stations)
        }
        for future in as_completed(futures):
            try:
                result = future.result()
            except Exception as exc:  # noqa: BLE001 - report and keep rendering the others
                failed += 1
                print(f"station {futures[future]} failed: {exc}", file=sys.stderr, flush=True)
                continue
            rate = result.n_frames / result.seconds
            print(
                f"{result.machine_id}: {result.n_frames} frames in {result.seconds:.1f} s "
                f"({rate:.1f} fps)",
                flush=True,
            )

    print(f"done in {time.monotonic() - started:.1f} s, output in {args.out}", flush=True)
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
