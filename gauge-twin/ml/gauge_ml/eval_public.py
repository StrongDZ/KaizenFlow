"""Evaluates the exported models on real images of public datasets.

    python -m gauge_ml.eval_public --public data/public --models data/ml-runs/onnx --out data/ml-runs/public/onnx.json

The ONNX files and their preprocess.json are used exactly as ds-sim uses them,
and dial readings are decoded the way edge-agent decodes them, so the numbers
are those of the deployed models. Digit crops that a dataset does not frame
like the synthetic slots are scored twice: re-framed (slots.frame_digit) and
resized as given; the gap is the cost of a bad framing, which commissioning
has to avoid.
"""

from __future__ import annotations

import argparse
import json
import sys
from collections import defaultdict
from pathlib import Path

import numpy as np
import onnxruntime as ort

from gauge_ml import CLASS_BLANK, CLASS_TRANSITION, DIGIT_H, DIGIT_W, KP_CENTER, KP_TIP, N_DIGIT_CLASSES, preprocess
from gauge_ml.dataset.public import LOADERS, DialSource, DigitSource
from gauge_ml.dataset.public.slots import frame_digit, resize_whole
from gauge_ml.eval_digit import exact_match
from gauge_ml.geometry import dial_value_from_points

TARGET_PERCENT_FS = 1.5
MIN_CONFIDENCE = 0.5  # DefaultOptions().MinConfidence of edge/decode
CONFIDENCE_THRESHOLDS = (0.5, 0.7, 0.9)


class OnnxModel:
    def __init__(self, models: Path, name: str) -> None:
        self.spec = json.loads((models / f"{name}.preprocess.json").read_text())
        self.session = ort.InferenceSession(str(models / f"{name}.onnx"), providers=["CPUExecutionProvider"])
        self.input = self.session.get_inputs()[0].name

    def run(self, images: np.ndarray, batch_size: int = 64) -> list[np.ndarray]:
        """Model outputs for uint8 images, concatenated over batches."""
        outs: list[list[np.ndarray]] = []
        for i in range(0, len(images), batch_size):
            outs.append(
                self.session.run(None, {self.input: preprocess.to_tensor(images[i : i + batch_size], self.spec)})
            )
        return [np.concatenate([o[k] for o in outs]) for k in range(len(outs[0]))] if outs else []


# ------------------------------------------------------------------ digits --


def digit_metrics(labels: np.ndarray, probs: np.ndarray, sequence: np.ndarray) -> dict:
    """Accuracy on crops that each hold one known digit 0-9."""
    predicted = probs.argmax(axis=1)
    correct = predicted == labels
    confusion = np.zeros((N_DIGIT_CLASSES, N_DIGIT_CLASSES), dtype=np.int64)
    np.add.at(confusion, (labels, predicted), 1)
    confidence = probs.max(axis=1)
    by_confidence = {}
    for threshold in CONFIDENCE_THRESHOLDS:
        kept = confidence >= threshold
        by_confidence[str(threshold)] = {
            "share_kept": float(kept.mean()),
            "accuracy_kept": float(correct[kept].mean()) if kept.any() else None,
        }
    overall, _, displays, _ = exact_match(labels, predicted, sequence)
    return {
        "slots": int(len(labels)),
        "slot_accuracy": float(correct.mean()),
        "displays": displays,
        "exact_match": overall,
        "predicted_blank": float((predicted == CLASS_BLANK).mean()),
        "predicted_transition": float((predicted == CLASS_TRANSITION).mean()),
        "accuracy_per_class": {
            str(c): float(confusion[c, c] / confusion[c].sum()) for c in range(10) if confusion[c].sum()
        },
        "by_confidence": by_confidence,
        "confusion": confusion.tolist(),
    }


def eval_digits(source: DigitSource, root: Path, model: OnnxModel, limit: int | None) -> dict:
    crops, labels, metas = [], [], []
    for crop, label, meta in source.load(root):
        crops.append(crop)
        labels.append(label)
        metas.append(meta)
        if limit and len(crops) >= limit:
            break
    labels_arr = np.array(labels, dtype=np.int64)
    sequence = np.array([m["sequence"] for m in metas], dtype=np.int64)
    gauge_type = np.array([m["gauge_type"] for m in metas])
    if source.framed:
        framings = {"as_given": lambda c: c if c.shape == (DIGIT_H, DIGIT_W) else resize_whole(c)}
    else:
        framings = {"framed": lambda c: frame_digit(c, source.polarity), "whole": resize_whole}
    result: dict = {"licence": source.licence}
    for framing, fn in framings.items():
        slots = np.stack([fn(c) for c in crops])
        probs = model.run(slots)[0]
        entry = digit_metrics(labels_arr, probs, sequence)
        entry["by_gauge_type"] = {
            t: digit_metrics(labels_arr[gauge_type == t], probs[gauge_type == t], sequence[gauge_type == t])
            for t in np.unique(gauge_type)
        }
        result[framing] = entry
    return result


# ------------------------------------------------------------------- dials --


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


def commissioning_calib(labels: dict) -> dict:
    """The calib commissioning would store for this gauge, in the frame (the
    roi is the whole frame and the gauge is seen face-on, so the rectified
    square is the frame itself): pivot, the first and last major ticks."""
    calib = labels["calib"]
    radius = calib.tick_band[0]
    cx, cy = calib.center

    def at(deg: float) -> list[float]:
        return [cx + radius * np.cos(np.radians(deg)), cy + radius * np.sin(np.radians(deg))]

    return {
        "center": [cx, cy],
        "min_pt": at(labels["majors_deg"][0]),
        "max_pt": at(labels["majors_deg"][-1]),
        "min_val": float(calib.values[0]),
        "max_val": float(calib.values[-1]),
        "sweep": "cw",
    }


def eval_dials(source: DialSource, root: Path, model: OnnxModel, limit: int | None) -> dict:
    crops, shapes, labels = [], [], []
    for frame, label in source.load(root):
        # Keep only the model input: whole frames of a large set do not fit in memory.
        crops.append(preprocess.dial_crop(frame, (0, 0, frame.shape[1], frame.shape[0]), model.spec))
        shapes.append(frame.shape[:2])
        labels.append(label)
        if limit and len(crops) >= limit:
            break
    if not crops:
        return {"licence": source.licence, "samples": 0}
    crops = np.stack(crops)
    keypoints, confidence = model.run(crops)
    rows = defaultdict(lambda: defaultdict(list))
    for i, label in enumerate(labels):
        h, w = shapes[i]
        size = model.spec["input"]
        points = keypoints[i] * np.array([w / size["width"], h / size["height"]])
        if "majors_deg" in label:
            # Video with a measured needle: the calib commissioning would store.
            calib = commissioning_calib(label)
            full_scale = label["full_scale"]
            needle_deg = label["needle_deg"]
        else:
            # Labelled keypoints: calib from the labelled marks, value = share of scale.
            calib = label["calib"]
            full_scale = calib["max_val"] - calib["min_val"]
            tip_truth = np.asarray(label["keypoints"][KP_TIP], dtype=np.float64)
            needle_deg = float(np.degrees(np.arctan2(*(tip_truth - np.asarray(calib["center"]))[::-1])))
        center, tip = points[KP_CENTER], points[KP_TIP]
        model_value = dial_value_from_points(center, tip, calib)
        model_value_calib_center = dial_value_from_points(calib["center"], tip, calib)
        # The decoder interpolates linearly between min_pt and max_pt; the
        # ground truth of the videos uses every major tick. This is the cost of that alone.
        truth_tip = np.array(calib["center"]) + 100 * np.array(
            [np.cos(np.radians(needle_deg)), np.sin(np.radians(needle_deg))]
        )
        linear_value = dial_value_from_points(calib["center"], truth_tip, calib)
        pred_angle = np.degrees(np.arctan2(tip[1] - center[1], tip[0] - center[0]))
        angle_error = abs((pred_angle - needle_deg + 180.0) % 360.0 - 180.0)
        for key in (label.get("video", "images"), "all"):
            r = rows[key]
            r["error"].append(abs(model_value - label["value"]) / full_scale * 100)
            r["error_calib_center"].append(abs(model_value_calib_center - label["value"]) / full_scale * 100)
            r["decoder_linear_error"].append(abs(linear_value - label["value"]) / full_scale * 100)
            r["angle_error_deg"].append(angle_error)
            r["center_error_px"].append(float(np.hypot(*(center - np.array(calib["center"])))))
            r["tip_confidence"].append(float(confidence[i][KP_TIP]))
            # edge-agent drops a frame when the pivot or the tip is below MinConfidence.
            r["kept"].append(bool(min(confidence[i][KP_CENTER], confidence[i][KP_TIP]) >= MIN_CONFIDENCE))
            r["value"].append(label["value"])
    result: dict = {"licence": source.licence}
    for key, r in rows.items():
        errors = np.array(r["error"])
        conf = np.array(r["tip_confidence"])
        kept = np.array(r["kept"])
        result[key] = {
            "percent_fs": _summary(errors),
            "percent_fs_calib_center": _summary(np.array(r["error_calib_center"])),
            "decoder_linear_percent_fs": _summary(np.array(r["decoder_linear_error"])),
            "needle_angle_error_deg": _summary(np.array(r["angle_error_deg"])),
            "center_error_px": {"mean": float(np.mean(r["center_error_px"]))},
            "tip_confidence": {
                "mean": float(conf.mean()),
                "min": float(conf.min()),
                "mean_when_error_over_target": float(conf[errors > TARGET_PERCENT_FS].mean())
                if (errors > TARGET_PERCENT_FS).any()
                else None,
            },
            # What reaches the window after the confidence gate of edge-agent.
            "confidence_gate": {
                "min_confidence": MIN_CONFIDENCE,
                "share_kept": float(kept.mean()),
                "percent_fs_kept": _summary(errors[kept]),
                "errors_over_10_percent": int((errors > 10).sum()),
                "errors_over_10_percent_kept": int((errors[kept] > 10).sum()),
            },
            "truth_range": [float(np.min(r["value"])), float(np.max(r["value"]))],
        }
    return result


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="eval_public", description=__doc__.split("\n\n")[0])
    parser.add_argument("--public", type=Path, required=True, help="directory holding <dataset>/ folders")
    parser.add_argument("--models", type=Path, required=True, help="directory with the ONNX files")
    parser.add_argument("--datasets", nargs="*", help="names in LOADERS (default: every one present)")
    parser.add_argument("--limit", type=int, help="at most this many samples per dataset (smoke runs)")
    parser.add_argument("--out", type=Path, help="write the metrics as JSON to this file")
    args = parser.parse_args(argv)

    names = args.datasets or [n for n in LOADERS if (args.public / n).is_dir()]
    digit_model = dial_model = None
    metrics: dict = {"models": str(args.models), "datasets": {}}
    for name in names:
        source = LOADERS[name]
        if isinstance(source, DigitSource):
            digit_model = digit_model or OnnxModel(args.models, "digit_cls")
            metrics["datasets"][name] = eval_digits(source, args.public / name, digit_model, args.limit)
        else:
            dial_model = dial_model or OnnxModel(args.models, "dial_pose")
            metrics["datasets"][name] = eval_dials(source, args.public / name, dial_model, args.limit)
    if args.out:
        args.out.parent.mkdir(parents=True, exist_ok=True)
        args.out.write_text(json.dumps(metrics, indent=2) + "\n")

    def brief(value):
        if isinstance(value, dict):
            return {k: brief(v) for k, v in value.items() if k != "confusion"}
        return value

    print(json.dumps(brief(metrics), indent=2))
    return 0


if __name__ == "__main__":
    sys.exit(main())
