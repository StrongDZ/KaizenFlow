"""Turns the real pressure-gauge videos into stations the simulated edge can
run end to end (RTSP -> ds-sim -> edge-agent -> MQTT -> database).

    python -m gauge_ml.real_stations --public data/public --out data/sim-real

Output, one directory per video (same layout as the rendered stations):

    <out>/<machine_id>/video.mp4             the video, untouched
    <out>/<machine_id>/station_config.json   what commissioning would store
    <out>/<machine_id>/groundtruth.csv       t_s, value: the needle measured on every Nth frame

The station config holds one analog dial: the roi is the whole frame (the
videos are cropped to the gauge), the quad is the frame itself and calib is
the pivot with the first and last major ticks of dataset.public.pressure_gauge.
"""

from __future__ import annotations

import argparse
import csv
import json
import shutil
import sys
from pathlib import Path

import cv2
import numpy as np

from gauge_ml.dataset.public import pressure_gauge as pg

PLANT, LINE, GAUGE_ID = "REAL", "PUMP", "PRESSURE"


def machine_id(video: str) -> str:
    return f"pump_{video}"


def station_config(video: str, calib: pg.GaugeCalib, majors: np.ndarray, size: tuple[int, int], rtsp: str) -> dict:
    width, height = size
    cx, cy = calib.center
    radius = calib.tick_band[0]

    def at(deg: float) -> list[float]:
        return [round(cx + radius * np.cos(np.radians(deg)), 2), round(cy + radius * np.sin(np.radians(deg)), 2)]

    return {
        "config_version": 1,
        "machine_id": machine_id(video),
        "plant": PLANT,
        "line": LINE,
        "camera": {"url": f"{rtsp}/{machine_id(video)}", "sample_fps": 2},
        "window_sec": 1,
        "gauges": [
            {
                "gauge_id": GAUGE_ID,
                "type": "analog_dial",
                "unit": "bar",
                "roi": [0, 0, width, height],
                "quad": [{"x": 0, "y": 0}, {"x": width, "y": 0}, {"x": width, "y": height}, {"x": 0, "y": height}],
                # The frame is square; calib is in frame pixels.
                "rect_size": width,
                "calib": {
                    "center": [round(cx, 2), round(cy, 2)],
                    "min_pt": at(majors[0]),
                    "max_pt": at(majors[-1]),
                    "min_val": float(calib.values[0]),
                    "max_val": float(calib.values[-1]),
                    "sweep": "cw",
                    "scale": "linear",
                },
            }
        ],
    }


def groundtruth(path: Path, calib: pg.GaugeCalib, majors: np.ndarray, every: int) -> list[tuple[float, float, bool]]:
    """(time in the video in s, value, needle measured clearly) on every Nth frame."""
    capture = cv2.VideoCapture(str(path))
    fps = capture.get(cv2.CAP_PROP_FPS) or 30.0
    rows, index = [], 0
    while True:
        ok, frame = capture.read()
        if not ok:
            break
        if index % every == 0:
            angle, needle = pg.needle_angle(cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY), calib)
            clear = needle.score >= pg.MIN_SCORE and needle.score - needle.runner_up >= pg.MIN_MARGIN
            rows.append((index / fps, pg.value_at(angle, majors, calib.values), clear))
        index += 1
    capture.release()
    return rows


def build(public: Path, out: Path, rtsp: str, every: int) -> dict:
    summary = {}
    for video, clicked in pg.CALIB.items():
        source = public / "pressure-gauge" / f"{video}cropclipscale.mp4"
        if not source.exists():
            continue
        directory = out / machine_id(video)
        directory.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(source, directory / "video.mp4")
        calib, majors = pg.calibrate(source, clicked)
        capture = cv2.VideoCapture(str(source))
        size = int(capture.get(cv2.CAP_PROP_FRAME_WIDTH)), int(capture.get(cv2.CAP_PROP_FRAME_HEIGHT))
        frames, fps = capture.get(cv2.CAP_PROP_FRAME_COUNT), capture.get(cv2.CAP_PROP_FPS) or 30.0
        capture.release()
        config = station_config(video, calib, majors, size, rtsp)
        (directory / "station_config.json").write_text(json.dumps(config, indent=2) + "\n")
        rows = groundtruth(source, calib, majors, every)
        with (directory / "groundtruth.csv").open("w", newline="") as f:
            writer = csv.writer(f)
            writer.writerow(["t_s", "value", "clear"])
            writer.writerows((f"{t:.4f}", f"{v:.5f}", int(c)) for t, v, c in rows)
        values = [v for _, v, c in rows if c]
        summary[machine_id(video)] = {
            "duration_s": round(frames / fps, 3),
            "groundtruth_rows": len(rows),
            "value_range": [round(min(values), 3), round(max(values), 3)],
            "full_scale": float(calib.values[-1] - calib.values[0]),
        }
    (out / "summary.json").write_text(json.dumps(summary, indent=2) + "\n")
    return summary


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="real_stations", description=__doc__.split("\n\n")[0])
    parser.add_argument("--public", type=Path, required=True)
    parser.add_argument("--out", type=Path, required=True)
    parser.add_argument("--rtsp", default="rtsp://mediamtx:8554", help="base URL the videos are published under")
    parser.add_argument("--every", type=int, default=3, help="measure the needle on every Nth frame")
    args = parser.parse_args(argv)
    print(json.dumps(build(args.public, args.out, args.rtsp, args.every), indent=2))
    return 0


if __name__ == "__main__":
    sys.exit(main())
