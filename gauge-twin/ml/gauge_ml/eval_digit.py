"""Evaluates the digit classifier: per-slot accuracy and whole-display exact match.

python -m gauge_ml.eval_digit --data data/ml --weights data/ml-runs/digit/best.pt
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

import numpy as np
import torch

from gauge_ml import CLASS_TRANSITION, N_DIGIT_CLASSES
from gauge_ml.models.digit_cnn import DigitCNN


@torch.no_grad()
def predict(model: torch.nn.Module, images: np.ndarray, device: str, batch_size: int = 1024) -> np.ndarray:
    """Predicted class per slot image (N, 48, 32) uint8."""
    model.eval()
    out = []
    for start in range(0, len(images), batch_size):
        x = torch.from_numpy(images[start : start + batch_size]).float().div(255).unsqueeze(1).to(device)
        out.append(model(x).argmax(dim=1).cpu().numpy())
    return np.concatenate(out) if out else np.zeros(0, dtype=np.int64)


def exact_match(labels: np.ndarray, predicted: np.ndarray, sequence: np.ndarray) -> tuple[float, float, int, int]:
    """Share of displays read entirely right.

    Returns (over every display, over displays with no slot in transition,
    number of displays, number of displays without transition).
    """
    if len(labels) == 0:
        return 0.0, 0.0, 0, 0
    order = np.argsort(sequence, kind="stable")
    seq, correct, in_transition = sequence[order], (labels == predicted)[order], (labels == CLASS_TRANSITION)[order]
    starts = np.flatnonzero(np.r_[True, seq[1:] != seq[:-1]])
    all_right = np.minimum.reduceat(correct, starts).astype(bool)
    steady = ~np.maximum.reduceat(in_transition, starts).astype(bool)
    readable = float(all_right[steady].mean()) if steady.any() else 0.0
    return float(all_right.mean()), readable, len(starts), int(steady.sum())


def digit_metrics(split: dict[str, np.ndarray], predicted: np.ndarray) -> dict:
    labels = split["labels"].astype(np.int64)
    if len(labels) == 0:
        return {"slots": 0}
    correct = labels == predicted
    confusion = np.zeros((N_DIGIT_CLASSES, N_DIGIT_CLASSES), dtype=np.int64)
    np.add.at(confusion, (labels, predicted), 1)
    per_class = {
        str(c): float(confusion[c, c] / confusion[c].sum()) for c in range(N_DIGIT_CLASSES) if confusion[c].sum() > 0
    }
    overall, readable, displays, steady = exact_match(labels, predicted, split["sequence"])

    def by(key: str) -> dict[str, float]:
        return {str(v): float(correct[split[key] == v].mean()) for v in np.unique(split[key])}

    return {
        "slots": int(len(labels)),
        "slot_accuracy": float(correct.mean()),
        "exact_match": overall,
        "exact_match_no_transition": readable,
        "displays": displays,
        "displays_no_transition": steady,
        "accuracy_per_class": per_class,
        "accuracy_by_gauge_type": by("gauge_type"),
        "accuracy_by_color": by("color"),
        "accuracy_by_noise_level": by("noise_level"),
        "confusion": confusion.tolist(),
    }


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="eval_digit", description=__doc__.split("\n\n")[0])
    parser.add_argument("--data", type=Path, required=True)
    parser.add_argument("--weights", type=Path, required=True)
    parser.add_argument("--split", default="test")
    parser.add_argument("--device", default="cpu")
    parser.add_argument("--out", type=Path, help="write the metrics as JSON to this file")
    args = parser.parse_args(argv)

    checkpoint = torch.load(args.weights, map_location=args.device, weights_only=True)
    model = DigitCNN().to(args.device)
    model.load_state_dict(checkpoint["model"])
    with np.load(args.data / "digits" / f"{args.split}.npz") as archive:
        split = {key: archive[key] for key in archive.files}
    metrics = digit_metrics(split, predict(model, split["images"], args.device))
    if args.out:
        args.out.write_text(json.dumps(metrics, indent=2) + "\n")
    print(json.dumps({k: v for k, v in metrics.items() if k != "confusion"}, indent=2))
    return 0


if __name__ == "__main__":
    sys.exit(main())
