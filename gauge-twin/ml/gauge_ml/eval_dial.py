"""Evaluates the dial model: reading error in % of full scale.

    python -m gauge_ml.eval_dial --data data/ml --weights data/ml-runs/dial/best.pt

The reading is decoded the way edge-agent will: predicted keypoints go through
the quad homography into the rectified square and the pivot-to-tip angle is
interpolated between calib min_pt and max_pt.
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

import numpy as np
import torch
from torch.utils.data import DataLoader

from gauge_ml import DIAL_INPUT, KP_TIP
from gauge_ml.dataset.dial import read_value
from gauge_ml.dial_data import DialDataset, load_index
from gauge_ml.models.dial_keypoint import DialKeypointNet, keypoint_confidence, normalise, soft_argmax

TARGET_PERCENT_FS = 1.5


@torch.no_grad()
def predict(
    model: torch.nn.Module, rows: list[dict], device: str, batch_size: int = 32
) -> tuple[np.ndarray, np.ndarray]:
    """Predicted keypoints (N, 5, 2) in crop pixels and their confidence (N, 5), as the exported model gives it."""
    model.eval()
    points, scores = [], []
    for images, _, _ in DataLoader(DialDataset(rows, train=False), batch_size=batch_size):
        heatmaps, visibility = model(normalise(images.to(device)))
        points.append((soft_argmax(heatmaps) * DIAL_INPUT).cpu().numpy())
        scores.append(keypoint_confidence(heatmaps, visibility).cpu().numpy())
    if not points:
        return np.zeros((0, 5, 2)), np.zeros((0, 5))
    return np.concatenate(points), np.concatenate(scores)


def _summary(errors: np.ndarray) -> dict:
    if len(errors) == 0:
        return {"samples": 0}
    return {
        "samples": int(len(errors)),
        "mean": float(errors.mean()),
        "median": float(np.median(errors)),
        "p95": float(np.percentile(errors, 95)),
        "max": float(errors.max()),
        "share_within_target": float((errors <= TARGET_PERCENT_FS).mean()),
    }


def reading_errors(rows: list[dict], keypoints: np.ndarray, use_calib_center: bool = False) -> np.ndarray:
    """Absolute reading error of every sample, in % of full scale."""
    errors = np.empty(len(rows))
    for i, row in enumerate(rows):
        calib = row["calib"]
        value = read_value(keypoints[i], tuple(row["crop"]), row["quad"], row["rect_size"], calib, use_calib_center)
        errors[i] = abs(value - row["value"]) / (calib["max_val"] - calib["min_val"]) * 100.0
    return errors


def dial_metrics(rows: list[dict], keypoints: np.ndarray) -> dict:
    if not rows:
        return {"samples": 0}
    errors = reading_errors(rows, keypoints)
    truth = np.stack([row["keypoints"] for row in rows])
    pixel_error = np.linalg.norm(keypoints - truth, axis=2)
    tip_visible = np.array([bool(row["visible"][KP_TIP]) for row in rows])
    levels = np.array([row["noise_level"] for row in rows])
    return {
        "percent_fs": _summary(errors),
        # Same readings with the pivot taken from calib instead of the model.
        "percent_fs_calib_center": _summary(reading_errors(rows, keypoints, use_calib_center=True)),
        "percent_fs_tip_visible": _summary(errors[tip_visible]),
        "percent_fs_by_noise_level": {str(level): _summary(errors[levels == level]) for level in np.unique(levels)},
        "keypoint_error_px": {"mean": float(pixel_error.mean()), "per_keypoint": pixel_error.mean(axis=0).tolist()},
        "target_percent_fs": TARGET_PERCENT_FS,
    }


def load_model(weights: Path, device: str) -> DialKeypointNet:
    checkpoint = torch.load(weights, map_location=device, weights_only=True)
    model = DialKeypointNet(checkpoint["backbone"], pretrained=False).to(device)
    model.load_state_dict(checkpoint["model"])
    return model


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="eval_dial", description=__doc__.split("\n\n")[0])
    parser.add_argument("--data", type=Path, required=True)
    parser.add_argument("--weights", type=Path, required=True)
    parser.add_argument("--split", default="test")
    parser.add_argument("--device", default="cpu")
    parser.add_argument("--out", type=Path, help="write the metrics as JSON to this file")
    args = parser.parse_args(argv)

    rows = load_index(args.data, args.split)
    keypoints, _ = predict(load_model(args.weights, args.device), rows, args.device)
    metrics = dial_metrics(rows, keypoints)
    if args.out:
        args.out.write_text(json.dumps(metrics, indent=2) + "\n")
    print(json.dumps(metrics, indent=2))
    return 0


if __name__ == "__main__":
    sys.exit(main())
