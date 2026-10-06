"""Compares what reached the database with the ground truth of the real
stations (gauge_ml.real_stations), end to end.

    psql ... -c "\\copy (select machine_id, extract(epoch from ts), value, quality,
        array_to_string(flags, ' '), n_frames from gauge_reading
        where machine_id like 'pump_%' order by ts) to stdout csv" > readings.csv
    python -m gauge_ml.e2e_real --stations data/sim-real --readings readings.csv

The videos loop on the RTSP server and readings carry wall-clock times, so
the position in the video is (ts + phase) modulo the video length. The phase
of each stream is the one that makes the readings fit the ground truth best:
a single number per stream against hundreds of readings.
"""

from __future__ import annotations

import argparse
import csv
import json
import sys
from pathlib import Path

import numpy as np

TARGET_PERCENT_FS = 1.5
QUALITY_THRESHOLD = 0.7  # the gauge_1m view keeps readings at or above it


def load_groundtruth(path: Path) -> tuple[np.ndarray, np.ndarray]:
    with path.open() as f:
        rows = [(float(r["t_s"]), float(r["value"])) for r in csv.DictReader(f) if r["clear"] == "1"]
    t, v = np.array(rows).T
    return t, v


def truth_at(t_video: np.ndarray, gt_t: np.ndarray, gt_v: np.ndarray, window_s: float) -> np.ndarray:
    """Ground truth at the middle of the window that ends at t_video."""
    return np.interp(t_video - window_s / 2, gt_t, gt_v)


def fit_phase(
    ts: np.ndarray, values: np.ndarray, gt_t: np.ndarray, gt_v: np.ndarray, duration: float, window_s: float
) -> float:
    """Phase (s) minimising the mean absolute error, searched in 0.1 s steps.

    The mean, not the median: on a gauge that moves only for a few seconds a
    median would not see the moving part at all.
    """
    best, best_cost = 0.0, np.inf
    for phase in np.arange(0.0, duration, 0.1):
        cost = np.abs(values - truth_at((ts + phase) % duration, gt_t, gt_v, window_s)).mean()
        if cost < best_cost:
            best, best_cost = float(phase), float(cost)
    return best


def summarise(errors: np.ndarray) -> dict:
    if len(errors) == 0:
        return {"windows": 0}
    return {
        "windows": int(len(errors)),
        "mean": float(errors.mean()),
        "median": float(np.median(errors)),
        "p95": float(np.percentile(errors, 95)),
        "max": float(errors.max()),
        "share_within_target": float((errors <= TARGET_PERCENT_FS).mean()),
    }


def check(stations: Path, readings: Path, window_s: float) -> dict:
    meta = json.loads((stations / "summary.json").read_text())
    by_machine: dict[str, list] = {}
    with readings.open() as f:
        for machine, ts, value, quality, flags, n_frames in csv.reader(f):
            by_machine.setdefault(machine, []).append(
                (float(ts), float(value) if value else np.nan, float(quality or 0), flags, int(n_frames or 0))
            )
    report = {}
    for machine, rows in sorted(by_machine.items()):
        if machine not in meta:
            continue
        ts = np.array([r[0] for r in rows])
        value = np.array([r[1] for r in rows])
        quality = np.array([r[2] for r in rows])
        flags = [r[3] for r in rows]
        has_value = ~np.isnan(value)
        gt_t, gt_v = load_groundtruth(stations / machine / "groundtruth.csv")
        duration, full_scale = meta[machine]["duration_s"], meta[machine]["full_scale"]
        entry: dict = {
            "windows": int(len(rows)),
            "share_without_value": float((~has_value).mean()),
            "flags": {f: sum(f in fl.split() for fl in flags) for f in sorted({x for fl in flags for x in fl.split()})},
            "mean_quality": float(quality.mean()),
        }
        if has_value.sum() >= 5:
            phase = fit_phase(ts[has_value], value[has_value], gt_t, gt_v, duration, window_s)
            truth = truth_at((ts + phase) % duration, gt_t, gt_v, window_s)
            errors = np.abs(value - truth) / full_scale * 100
            good = has_value & (quality >= QUALITY_THRESHOLD)
            entry.update(
                {
                    "phase_s": phase,
                    "percent_fs": summarise(errors[has_value]),
                    "share_quality_ok": float(good.mean()),
                    "percent_fs_quality_ok": summarise(errors[good]),
                    "value_range": [float(np.nanmin(value)), float(np.nanmax(value))],
                    "truth_range": [float(gt_v.min()), float(gt_v.max())],
                }
            )
        report[machine] = entry
    return report


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="e2e_real", description=__doc__.split("\n\n")[0])
    parser.add_argument("--stations", type=Path, required=True, help="directory written by real_stations")
    parser.add_argument("--readings", type=Path, required=True, help="CSV export of gauge_reading")
    parser.add_argument("--window", type=float, default=1.0, help="window_sec of the stations")
    parser.add_argument("--out", type=Path)
    args = parser.parse_args(argv)
    report = check(args.stations, args.readings, args.window)
    if args.out:
        args.out.write_text(json.dumps(report, indent=2) + "\n")
    print(json.dumps(report, indent=2))
    return 0


if __name__ == "__main__":
    sys.exit(main())
