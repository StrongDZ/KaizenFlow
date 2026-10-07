"""Calibrates the confidence of a trained digit classifier (temperature scaling).

    python -m gauge_ml.calibrate_digit --data data/ml-real --weights data/ml-runs/digit/best.pt

Fits one temperature on the validation split (minimum negative
log-likelihood, Guo et al. 2017) and stores it in the checkpoint; export.py
bakes it into the ONNX graph. The classes predicted stay the same, only the
probabilities change, so that edge-agent's quality score and the server's
quality threshold work on honest numbers.
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

import numpy as np
import torch
import torch.nn.functional as F

from gauge_ml.models.digit_cnn import DigitCNN


@torch.no_grad()
def logits_of(model: torch.nn.Module, images: np.ndarray, device: str, batch_size: int = 2048) -> torch.Tensor:
    model.eval()
    out = [
        model(torch.from_numpy(images[i : i + batch_size]).float().div(255).unsqueeze(1).to(device))
        for i in range(0, len(images), batch_size)
    ]
    return torch.cat(out) if out else torch.zeros(0, 12, device=device)


def fit_temperature(logits: torch.Tensor, labels: torch.Tensor) -> float:
    """Temperature minimising the cross-entropy of softmax(logits / T)."""
    log_t = torch.zeros(1, device=logits.device, requires_grad=True)
    optimizer = torch.optim.LBFGS([log_t], lr=0.1, max_iter=200)

    def closure() -> torch.Tensor:
        optimizer.zero_grad()
        loss = F.cross_entropy(logits / log_t.exp(), labels)
        loss.backward()
        return loss

    optimizer.step(closure)
    return float(log_t.exp())


def expected_calibration_error(confidence: np.ndarray, correct: np.ndarray, bins: int = 10) -> float:
    """Mean gap between confidence and accuracy over equal-width confidence bins."""
    error = 0.0
    for low in np.linspace(0.0, 1.0, bins, endpoint=False):
        inside = (confidence > low) & (confidence <= low + 1.0 / bins)
        if inside.any():
            error += inside.mean() * abs(correct[inside].mean() - confidence[inside].mean())
    return float(error)


def report(logits: torch.Tensor, labels: np.ndarray, temperature: float) -> dict:
    probs = torch.softmax(logits / temperature, dim=1).cpu().numpy()
    confidence, correct = probs.max(axis=1), probs.argmax(axis=1) == labels
    return {
        "accuracy": float(correct.mean()),
        "mean_confidence": float(confidence.mean()),
        "ece": expected_calibration_error(confidence, correct),
    }


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="calibrate_digit", description=__doc__.split("\n\n")[0])
    parser.add_argument("--data", type=Path, required=True, help="dataset with digits/val.npz")
    parser.add_argument("--weights", type=Path, required=True, help="checkpoint to calibrate, updated in place")
    parser.add_argument("--device", default="cpu")
    args = parser.parse_args(argv)

    checkpoint = torch.load(args.weights, map_location=args.device, weights_only=True)
    model = DigitCNN().to(args.device)
    model.load_state_dict(checkpoint["model"])
    with np.load(args.data / "digits" / "val.npz") as archive:
        images, labels = archive["images"], archive["labels"].astype(np.int64)
    if len(labels) == 0:
        raise SystemExit(f"no validation samples in {args.data}/digits/val.npz")
    logits = logits_of(model, images, args.device)
    temperature = fit_temperature(logits, torch.from_numpy(labels).to(args.device))
    result = {
        "temperature": temperature,
        "before": report(logits, labels, 1.0),
        "after": report(logits, labels, temperature),
    }
    checkpoint["temperature"] = temperature
    torch.save(checkpoint, args.weights)
    print(json.dumps(result, indent=2))
    return 0


if __name__ == "__main__":
    sys.exit(main())
