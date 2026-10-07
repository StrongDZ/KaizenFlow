"""Exports a trained model to ONNX and registers it in the MLflow registry.

    python -m gauge_ml.export --model digit --weights data/ml-runs/digit/best.pt --out data/ml-runs/onnx
    python -m gauge_ml.export --model dial  --weights data/ml-runs/dial/best.pt  --out data/ml-runs/onnx

The graph has a fixed H x W and a dynamic batch dimension (opset 17). The
TensorRT optimisation profile to build the engine with is written next to the
model and stored as registry tags.
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

import mlflow
import numpy as np
import onnx
import onnxruntime
import torch

from gauge_ml import KEYPOINTS, N_DIGIT_CLASSES, preprocess, tracking
from gauge_ml.models.dial_keypoint import DialExport, DialKeypointNet
from gauge_ml.models.digit_cnn import DigitCNN, DigitExport

OPSET = 17
# Registry names match the model_versions keys of the station config.
SPECS = {
    "digit": {
        "name": "digit_cls",
        "inputs": ["slots"],
        "outputs": ["probabilities"],
        # TensorRT optimisation profile (batch sizes): one frame can hold dozens of slots.
        "trt_profile": {"min": 1, "opt": 32, "max": 128},
        "input_format": "grayscale float32 in [0, 1], NCHW (B, 1, 48, 32)",
        "output_format": f"(B, {N_DIGIT_CLASSES}) probabilities; classes 0-9, 10 = blank, 11 = transition",
    },
    "dial": {
        "name": "dial_pose",
        "inputs": ["crops"],
        "outputs": ["keypoints", "confidence"],
        "trt_profile": {"min": 1, "opt": 8, "max": 32},
        "input_format": "RGB float32 in [0, 1], NCHW (B, 3, 256, 256), unrectified crop of one gauge",
        "output_format": f"keypoints (B, 5, 2) as (x, y) in input pixels, order {', '.join(KEYPOINTS)}; "
        "confidence (B, 5) in [0, 1]",
    },
}


def load_export_module(kind: str, weights: Path) -> torch.nn.Module:
    checkpoint = torch.load(weights, map_location="cpu", weights_only=True)
    if kind == "digit":
        model = DigitCNN()
        model.load_state_dict(checkpoint["model"])
        # Written by calibrate_digit; 1.0 for a checkpoint that was not calibrated.
        return DigitExport(model, checkpoint.get("temperature", 1.0)).eval()
    model = DialKeypointNet(checkpoint["backbone"], pretrained=False)
    model.load_state_dict(checkpoint["model"])
    return DialExport(model).eval()


def export_onnx(module: torch.nn.Module, kind: str, path: Path) -> None:
    spec = SPECS[kind]
    example = torch.zeros(2, *module.input_shape)
    names = spec["inputs"] + spec["outputs"]
    torch.onnx.export(
        module,
        example,
        str(path),
        opset_version=OPSET,
        input_names=spec["inputs"],
        output_names=spec["outputs"],
        dynamic_axes={name: {0: "batch"} for name in names},
    )
    onnx.checker.check_model(onnx.load(str(path)))


def verify(module: torch.nn.Module, kind: str, path: Path, tolerance: float) -> dict[int, float]:
    """Runs the ONNX model at the profile's min and opt batch sizes and
    returns the largest deviation from PyTorch for each."""
    session = onnxruntime.InferenceSession(str(path), providers=["CPUExecutionProvider"])
    profile = SPECS[kind]["trt_profile"]
    rng = np.random.default_rng(0)
    deviations = {}
    for batch in (profile["min"], profile["opt"]):
        x = rng.random((batch, *module.input_shape), dtype=np.float32)
        with torch.no_grad():
            expected = module(torch.from_numpy(x))
        expected = expected if isinstance(expected, tuple) else (expected,)
        actual = session.run(None, {SPECS[kind]["inputs"][0]: x})
        worst = max(float(np.abs(a - e.numpy()).max()) for a, e in zip(actual, expected, strict=True))
        if worst > tolerance:
            raise RuntimeError(f"ONNX output differs from PyTorch by {worst} at batch {batch}")
        deviations[batch] = worst
    return deviations


def run(kind: str, weights: Path, out: Path, register: bool) -> Path:
    spec = SPECS[kind]
    out.mkdir(parents=True, exist_ok=True)
    path = out / f"{spec['name']}.onnx"
    module = load_export_module(kind, weights)
    export_onnx(module, kind, path)
    # Keypoints are in pixels, probabilities in [0, 1]: scale the tolerance.
    deviations = verify(module, kind, path, tolerance=1e-2 if kind == "dial" else 1e-4)

    card = {k: spec[k] for k in ("name", "trt_profile", "input_format", "output_format")}
    card.update({"opset": OPSET, "batch": "dynamic", "max_deviation_from_pytorch": deviations})
    card_path = path.with_suffix(".json")
    card_path.write_text(json.dumps(card, indent=2) + "\n")
    # The preprocessing every inference pipeline must apply, read from this file.
    preprocess_path = out / f"{spec['name']}.preprocess.json"
    preprocess_path.write_text(json.dumps(preprocess.SPECS[kind], indent=2) + "\n")

    if register:
        tracking.setup(spec["name"])
        with mlflow.start_run(run_name="export"):
            mlflow.log_artifact(str(path), "onnx")
            mlflow.log_artifact(str(card_path), "onnx")
            mlflow.log_artifact(str(preprocess_path), "onnx")
            tags = {f"trt_{k}_batch": str(v) for k, v in spec["trt_profile"].items()}
            tags.update({"opset": str(OPSET), "format": "onnx"})
            version = tracking.register(spec["name"], f"onnx/{path.name}", tags)
        print(f"registered {spec['name']} version {version}")
    return path


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="export", description=__doc__.split("\n\n")[0])
    parser.add_argument("--model", choices=sorted(SPECS), required=True)
    parser.add_argument("--weights", type=Path, required=True)
    parser.add_argument("--out", type=Path, required=True, help="directory for the .onnx file")
    parser.add_argument("--no-register", action="store_true", help="skip the MLflow registry")
    args = parser.parse_args(argv)
    path = run(args.model, args.weights, args.out, not args.no_register)
    print(f"exported {path}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
