"""Builds the training datasets from real public images only.

    python -m gauge_ml.dataset.build_real --public data/public --out data/ml-real

Same layout as dataset.builder, so train_digit / train_dial / eval_* work
unchanged:

    <out>/digits/<split>.npz              slots (N, 48, 32) uint8 with labels and metadata
    <out>/dial/<split>/images/<id>.jpg    256x256 crops
    <out>/dial/<split>/index.parquet      keypoints, visibility, crop, quad, calib, value
    <out>/summary.json                    counts per dataset and split

Samples are split by group (the original photo or capture), never by sample,
so augmented copies and neighbouring video frames stay on one side. Datasets
marked eval_only go to the test split only (unknown licence, or a domain kept
apart to measure generalisation); a loader may also mark single samples
eval_only (licence per photo). No real dataset labels blank (unlit) digit
positions; --synthetic-blanks adds the blank slots, and only those, of a
synthetic dataset to train and val. The "color" field of the digit archive
holds the dataset name, so eval_digit reports accuracy per dataset.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import sys
from pathlib import Path

import cv2
import numpy as np
import pyarrow as pa
import pyarrow.parquet as pq

from gauge_ml import CLASS_BLANK, DIGIT_H, DIGIT_W, N_DIGIT_CLASSES
from gauge_ml.dataset.public import LOADERS, DialSource, DigitSource
from gauge_ml.dataset.public.slots import frame_digit

SPLITS = ("train", "val", "test")
# Share of groups per split for datasets used in training.
FRACTIONS = (0.8, 0.1, 0.1)


def split_of(dataset: str, group: str, eval_only: bool) -> str:
    """Deterministic split from a hash of (dataset, group)."""
    if eval_only:
        return "test"
    h = int(hashlib.sha1(f"{dataset}/{group}".encode()).hexdigest()[:8], 16) / 0xFFFFFFFF
    return "train" if h < FRACTIONS[0] else "val" if h < FRACTIONS[0] + FRACTIONS[1] else "test"


def to_slot(crop: np.ndarray, source: DigitSource) -> np.ndarray:
    if not source.framed:
        return frame_digit(crop, source.polarity)
    if crop.shape != (DIGIT_H, DIGIT_W):
        return cv2.resize(crop, (DIGIT_W, DIGIT_H), interpolation=cv2.INTER_AREA)
    return crop


def synthetic_blanks(sim_data: Path, split: str) -> np.ndarray:
    """Blank slots (class blank) of a synthetic dataset written by dataset.builder."""
    path = sim_data / "digits" / f"{split}.npz"
    if not path.exists():
        return np.zeros((0, DIGIT_H, DIGIT_W), np.uint8)
    with np.load(path) as archive:
        return archive["images"][archive["labels"] == CLASS_BLANK]


def build_digits(public: Path, out: Path, names: list[str], blanks_from: Path | None = None) -> dict:
    images: dict[str, list[np.ndarray]] = {s: [] for s in SPLITS}
    meta: dict[str, list[tuple]] = {s: [] for s in SPLITS}
    summary: dict = {}
    sequence_base = 0
    for station, name in enumerate(names):
        source = LOADERS[name]
        counts = {s: 0 for s in SPLITS}
        top = 0
        for crop, label, m in source.load(public / name):
            eval_only = source.eval_only or bool(m.get("eval_only", False))
            split = split_of(name, str(m.get("group", m["sequence"])), eval_only)
            images[split].append(to_slot(crop, source))
            meta[split].append((label, sequence_base + m["sequence"], m.get("slot", 0), station, m["gauge_type"], name))
            counts[split] += 1
            top = max(top, m["sequence"])
        sequence_base += top + 1
        summary[name] = counts
        print(f"digits {name}: {counts}", flush=True)
    if blanks_from is not None:
        # No real dataset labels unlit digit positions: the blank class alone
        # may come from the renderer. Train and val only; test stays real.
        counts = {s: 0 for s in SPLITS}
        for split in ("train", "val"):
            for image in synthetic_blanks(blanks_from, split):
                images[split].append(image)
                meta[split].append((CLASS_BLANK, sequence_base, 0, len(names), "seg7", "synthetic-blank"))
                sequence_base += 1
                counts[split] += 1
        summary["synthetic-blank"] = counts
        print(f"digits synthetic-blank: {counts}", flush=True)
    (out / "digits").mkdir(parents=True, exist_ok=True)
    for split in SPLITS:
        rows = meta[split]
        n = len(rows)
        np.savez_compressed(
            out / "digits" / f"{split}.npz",
            images=np.stack(images[split]) if n else np.zeros((0, DIGIT_H, DIGIT_W), np.uint8),
            labels=np.array([r[0] for r in rows], dtype=np.uint8),
            sequence=np.array([r[1] for r in rows], dtype=np.int64),
            slot=np.array([r[2] for r in rows], dtype=np.int16),
            station=np.array([r[3] for r in rows], dtype=np.int32),
            gauge_type=np.array([r[4] for r in rows], dtype="U16"),
            color=np.array([r[5] for r in rows], dtype="U24"),
            noise_level=np.array(["real"] * n, dtype="U8"),
            occluded=np.zeros(n, np.float32),
            glare_local=np.zeros(n, np.float32),
        )
        labels = np.array([r[0] for r in rows], dtype=np.int64)
        summary[f"_{split}_class_counts"] = np.bincount(labels, minlength=N_DIGIT_CLASSES).tolist() if n else []
    return summary


def build_dials(public: Path, out: Path, names: list[str]) -> dict:
    rows: dict[str, list[dict]] = {s: [] for s in SPLITS}
    summary: dict = {}
    for split in SPLITS:
        (out / "dial" / split / "images").mkdir(parents=True, exist_ok=True)
    for name in names:
        source = LOADERS[name]
        counts = {s: 0 for s in SPLITS}
        for i, (crop, label) in enumerate(source.load(public / name)):
            if "keypoints" not in label:
                continue  # a dial dataset with readings only is scored by eval_public
            split = split_of(name, str(label["group"]), source.eval_only)
            sample_id = f"{name}-{i:06d}"
            cv2.imwrite(str(out / "dial" / split / "images" / f"{sample_id}.jpg"), crop, [cv2.IMWRITE_JPEG_QUALITY, 95])
            rows[split].append(
                {
                    "id": sample_id,
                    "station": name,
                    "gauge_id": str(label["group"]),
                    "frame_idx": i,
                    "noise_level": name,
                    "value": float(label["value"]),
                    "keypoints": np.asarray(label["keypoints"], np.float32).reshape(-1).tolist(),
                    "visible": list(map(bool, label["visible"])),
                    "crop": [0.0, 0.0, float(crop.shape[1]), float(crop.shape[0])],
                    "quad": [
                        0.0,
                        0.0,
                        float(crop.shape[1]),
                        0.0,
                        float(crop.shape[1]),
                        float(crop.shape[0]),
                        0.0,
                        float(crop.shape[0]),
                    ],
                    "rect_size": int(crop.shape[0]),
                    "calib": json.dumps(label["calib"]),
                    "occluded": 0.0,
                    "glare_local": 0.0,
                    "blur_len": 0.0,
                }
            )
            counts[split] += 1
        summary[name] = counts
        print(f"dials {name}: {counts}", flush=True)
    for split in SPLITS:
        table = pa.Table.from_pylist(rows[split]) if rows[split] else pa.table({"id": []})
        pq.write_table(table, out / "dial" / split / "index.parquet")
    return summary


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="build-real", description=__doc__.split("\n\n")[0])
    parser.add_argument("--public", type=Path, required=True)
    parser.add_argument("--out", type=Path, required=True)
    parser.add_argument("--datasets", nargs="*", help="names in LOADERS (default: every one present)")
    parser.add_argument(
        "--synthetic-blanks", type=Path, help="synthetic dataset (dataset.builder output) to take blank slots from"
    )
    args = parser.parse_args(argv)

    names = args.datasets or [n for n in LOADERS if (args.public / n).is_dir()]
    digit_names = [n for n in names if isinstance(LOADERS[n], DigitSource)]
    dial_names = [n for n in names if isinstance(LOADERS[n], DialSource)]
    args.out.mkdir(parents=True, exist_ok=True)
    # Only the parts asked for are rewritten; the other part of an earlier run stays.
    path = args.out / "summary.json"
    summary = json.loads(path.read_text()) if path.exists() else {}
    if digit_names:
        summary["digits"] = build_digits(args.public, args.out, digit_names, args.synthetic_blanks)
    if dial_names:
        summary["dials"] = build_dials(args.public, args.out, dial_names)
    summary["fractions"] = FRACTIONS
    path.write_text(json.dumps(summary, indent=2) + "\n")
    print(json.dumps(summary, indent=2))
    return 0


if __name__ == "__main__":
    sys.exit(main())
