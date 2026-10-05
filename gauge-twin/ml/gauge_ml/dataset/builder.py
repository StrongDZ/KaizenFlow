"""Builds the training datasets from rendered stations.

    python -m gauge_ml.dataset.builder --sim data/sim-ml --out data/ml

Output:
    <out>/dial/<split>/images/<id>.jpg     256x256 unrectified crops
    <out>/dial/<split>/labels/<id>.txt     YOLO-pose labels (for baselines)
    <out>/dial/<split>/index.parquet       keypoints, visibility, crop box, quad, calib, value
    <out>/digits/<split>.npz               slot images (N, 48, 32) uint8 with labels and metadata
    <out>/summary.json                     counts per split
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

import cv2
import numpy as np
import pyarrow as pa
import pyarrow.parquet as pq

from gauge_ml import DIAL_INPUT, KEYPOINTS
from gauge_ml.dataset import dial, digits
from gauge_ml.dataset.split import SPLITS, assign_splits
from gauge_ml.dataset.station import Station

DIAL_TYPE = "analog_dial"
DIGIT_TYPES = ("seg7", "timer_mmss", "rolling_counter")


def find_stations(roots: list[Path]) -> list[Path]:
    """Every directory below the roots that holds a rendered station."""
    found = []
    for root in roots:
        found.extend(p.parent for p in sorted(root.rglob("station_config.json")))
    return found


def _yolo_label(sample: dial.DialSample, face: np.ndarray) -> str:
    """One YOLO-pose line: class, box (cx cy w h) and keypoints (x y v), all normalised."""
    lo, hi = np.clip(face.min(axis=0), 0, DIAL_INPUT), np.clip(face.max(axis=0), 0, DIAL_INPUT)
    box = [(lo[0] + hi[0]) / 2, (lo[1] + hi[1]) / 2, hi[0] - lo[0], hi[1] - lo[1]]
    fields = [f"{v / DIAL_INPUT:.6f}" for v in box]
    for (x, y), visible in zip(sample.keypoints, sample.visible, strict=True):
        fields += [f"{x / DIAL_INPUT:.6f}", f"{y / DIAL_INPUT:.6f}", "2" if visible else "1"]
    return "0 " + " ".join(fields)


def build(sim_roots: list[Path], out: Path, sample_fps: float, seed: int) -> dict:
    stations = find_stations(sim_roots)
    if not stations:
        raise SystemExit(f"no rendered stations found under {[str(r) for r in sim_roots]}")
    splits = assign_splits(stations)
    rng = np.random.default_rng(seed)

    dial_rows: dict[str, list[dict]] = {s: [] for s in SPLITS}
    slot_images: dict[str, list[np.ndarray]] = {s: [] for s in SPLITS}
    slot_meta: dict[str, list[tuple]] = {s: [] for s in SPLITS}
    for split in SPLITS:
        (out / "dial" / split / "images").mkdir(parents=True, exist_ok=True)
        (out / "dial" / split / "labels").mkdir(parents=True, exist_ok=True)
    (out / "digits").mkdir(parents=True, exist_ok=True)

    sequence = 0  # one id per (frame, digit gauge), for exact-match evaluation
    for station_index, directory in enumerate(sorted(stations)):
        split = splits[directory]
        station = Station(directory)
        tag = f"{directory.parent.name}-{station.machine_id}"
        for frame in station.frames(sample_fps):
            for gauge in station.gauges:
                row = frame.rows[gauge.gauge_id]
                if gauge.type == DIAL_TYPE:
                    sample = dial.make_sample(frame, gauge, rng)
                    sample_id = f"{tag}-{gauge.gauge_id}-{frame.index:06d}"
                    image_path = out / "dial" / split / "images" / f"{sample_id}.jpg"
                    cv2.imwrite(str(image_path), sample.image, [cv2.IMWRITE_JPEG_QUALITY, 95])
                    x0, y0, w, h = sample.crop
                    face = (gauge.quad - np.array([x0, y0])) * np.array([DIAL_INPUT / w, DIAL_INPUT / h])
                    (out / "dial" / split / "labels" / f"{sample_id}.txt").write_text(_yolo_label(sample, face) + "\n")
                    dial_rows[split].append(
                        {
                            "id": sample_id,
                            "station": tag,
                            "gauge_id": gauge.gauge_id,
                            "frame_idx": frame.index,
                            "noise_level": station.noise_level,
                            "value": sample.value,
                            "keypoints": sample.keypoints.reshape(-1).tolist(),
                            "visible": sample.visible.tolist(),
                            "crop": list(sample.crop),
                            "quad": gauge.quad.reshape(-1).tolist(),
                            "rect_size": gauge.rect_size,
                            "calib": json.dumps(gauge.calib),
                            "occluded": row["occluded"],
                            "glare_local": row["glare_local"],
                            "blur_len": row["blur_len"],
                        }
                    )
                elif gauge.type in DIGIT_TYPES:
                    images, labels = digits.make_slots(frame, gauge)
                    color = gauge.calib.get("color", "")
                    for slot, (image, label) in enumerate(zip(images, labels, strict=True)):
                        slot_images[split].append(image)
                        slot_meta[split].append(
                            (
                                label,
                                sequence,
                                slot,
                                station_index,
                                gauge.type,
                                color,
                                station.noise_level,
                                row["occluded"],
                                row["glare_local"],
                            )
                        )
                    sequence += 1

    summary: dict = {"stations": {s: sum(1 for v in splits.values() if v == s) for s in SPLITS}}
    for split in SPLITS:
        pq.write_table(
            pa.Table.from_pylist(dial_rows[split]) if dial_rows[split] else pa.table({"id": []}),
            out / "dial" / split / "index.parquet",
        )
        meta = slot_meta[split]
        images = np.stack(slot_images[split]) if meta else np.zeros((0, digits.DIGIT_H, digits.DIGIT_W), np.uint8)
        np.savez_compressed(
            out / "digits" / f"{split}.npz",
            images=images,
            labels=np.array([m[0] for m in meta], dtype=np.uint8),
            sequence=np.array([m[1] for m in meta], dtype=np.int64),
            slot=np.array([m[2] for m in meta], dtype=np.uint8),
            station=np.array([m[3] for m in meta], dtype=np.int32),
            gauge_type=np.array([m[4] for m in meta], dtype="U16"),
            color=np.array([m[5] for m in meta], dtype="U16"),
            noise_level=np.array([m[6] for m in meta], dtype="U8"),
            occluded=np.array([m[7] for m in meta], dtype=np.float32),
            glare_local=np.array([m[8] for m in meta], dtype=np.float32),
        )
        counts = (
            np.bincount(np.array([m[0] for m in meta], dtype=np.int64), minlength=12).tolist() if meta else [0] * 12
        )
        summary[split] = {"dial_samples": len(dial_rows[split]), "digit_slots": len(meta), "digit_class_counts": counts}
    summary["keypoints"] = list(KEYPOINTS)
    summary["sample_fps"] = sample_fps
    (out / "summary.json").write_text(json.dumps(summary, indent=2) + "\n")
    return summary


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="dataset-builder", description=__doc__.split("\n\n")[0])
    parser.add_argument("--sim", type=Path, nargs="+", required=True, help="directories with rendered stations")
    parser.add_argument("--out", type=Path, required=True, help="output directory")
    parser.add_argument("--sample-fps", type=float, default=2.0, help="frames taken per second of video")
    parser.add_argument("--seed", type=int, default=0, help="seed of the random crop margins")
    args = parser.parse_args(argv)
    summary = build(args.sim, args.out, args.sample_fps, args.seed)
    print(json.dumps(summary, indent=2))
    return 0


if __name__ == "__main__":
    sys.exit(main())
