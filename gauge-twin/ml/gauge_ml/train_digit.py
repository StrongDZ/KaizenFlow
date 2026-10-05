"""Trains the digit classifier.

python -m gauge_ml.train_digit --data data/ml --out data/ml-runs/digit --epochs 30 --device cuda
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

import mlflow
import numpy as np
import torch
import torch.nn.functional as F

from gauge_ml import N_DIGIT_CLASSES, tracking
from gauge_ml.eval_digit import digit_metrics, predict
from gauge_ml.models.digit_cnn import DigitCNN, count_parameters


def load_split(data: Path, split: str) -> dict[str, np.ndarray]:
    with np.load(data / "digits" / f"{split}.npz") as archive:
        return {key: archive[key] for key in archive.files}


def augment(x: torch.Tensor, generator: torch.Generator) -> torch.Tensor:
    """Strong augmentation on a batch (B, 1, H, W) in [0, 1].

    Covers what the slot cutter cannot remove: residual shift, scale and
    rotation from camera shake, contrast changes, blur, glare and sensor noise.
    """
    b, device = x.shape[0], x.device

    def rand(*shape: int) -> torch.Tensor:
        return torch.rand(*shape, generator=generator, device=device)

    # Small affine jitter: shift up to ~10%, scale 0.9-1.1, rotation up to 4 degrees.
    angle = (rand(b) - 0.5) * 2 * 0.07
    scale = 0.9 + 0.2 * rand(b)
    theta = torch.zeros(b, 2, 3, device=device)
    theta[:, 0, 0], theta[:, 0, 1] = torch.cos(angle) * scale, -torch.sin(angle) * scale
    theta[:, 1, 0], theta[:, 1, 1] = torch.sin(angle) * scale, torch.cos(angle) * scale
    theta[:, :, 2] = (rand(b, 2) - 0.5) * 0.2
    grid = F.affine_grid(theta, list(x.shape), align_corners=False)
    x = F.grid_sample(x, grid, mode="bilinear", padding_mode="border", align_corners=False)

    # Blur half of the batch with a random strength.
    kernel = torch.tensor([1.0, 4.0, 6.0, 4.0, 1.0], device=device) / 16.0
    blurred = F.conv2d(F.pad(x, (2, 2, 0, 0), mode="replicate"), kernel.view(1, 1, 1, 5))
    blurred = F.conv2d(F.pad(blurred, (0, 0, 2, 2), mode="replicate"), kernel.view(1, 1, 5, 1))
    mix = (rand(b, 1, 1, 1) * 2 - 1).clamp(min=0)
    x = x * (1 - mix) + blurred * mix

    # Contrast, brightness and gamma.
    contrast = 0.5 + rand(b, 1, 1, 1)
    brightness = (rand(b, 1, 1, 1) - 0.5) * 0.4
    x = ((x - 0.5) * contrast + 0.5 + brightness).clamp(0, 1)
    x = x.pow(0.6 + 0.8 * rand(b, 1, 1, 1))

    # Glare: a smooth bright blob on a third of the batch.
    blob = F.interpolate(rand(b, 1, 3, 2), size=x.shape[-2:], mode="bicubic", align_corners=False).clamp(0, 1)
    strength = (rand(b, 1, 1, 1) * 3 - 2).clamp(min=0) * 0.8
    x = x + blob * strength

    noise = torch.randn(x.shape, generator=generator, device=device) * 0.03 * rand(b, 1, 1, 1)
    return (x + noise).clamp(0, 1)


def class_weights(labels: np.ndarray) -> torch.Tensor:
    """Inverse square-root frequency, so rare classes (blank, transition) still count."""
    counts = np.bincount(labels, minlength=N_DIGIT_CLASSES).astype(np.float64)
    weights = np.where(counts > 0, 1.0 / np.sqrt(np.maximum(counts, 1.0)), 0.0)
    return torch.tensor(weights / weights[weights > 0].mean(), dtype=torch.float32)


def train(
    data: Path, out: Path, epochs: int, batch_size: int, lr: float, device: str, seed: int, init: Path | None = None
) -> dict:
    torch.manual_seed(seed)
    train_set, val_set = load_split(data, "train"), load_split(data, "val")
    if len(train_set["labels"]) == 0:
        raise SystemExit(f"no digit samples in {data}/digits/train.npz")
    x_train = torch.from_numpy(train_set["images"]).float().div(255).unsqueeze(1)
    y_train = torch.from_numpy(train_set["labels"].astype(np.int64))

    model = DigitCNN()
    if init is not None:
        # Fine-tuning: start from an earlier checkpoint.
        checkpoint = torch.load(init, map_location="cpu", weights_only=True)
        if checkpoint.get("arch") != "digit_cnn":
            raise SystemExit(f"{init}: arch {checkpoint.get('arch')} is not digit_cnn")
        model.load_state_dict(checkpoint["model"])
    model = model.to(device)
    optimizer = torch.optim.AdamW(model.parameters(), lr=lr, weight_decay=1e-4)
    steps = max(1, epochs * ((len(y_train) + batch_size - 1) // batch_size))
    scheduler = torch.optim.lr_scheduler.OneCycleLR(optimizer, max_lr=lr, total_steps=steps)
    weights = class_weights(train_set["labels"]).to(device)
    generator = torch.Generator(device=device).manual_seed(seed)
    shuffle = torch.Generator().manual_seed(seed)

    out.mkdir(parents=True, exist_ok=True)
    best = {"slot_accuracy": -1.0}
    for epoch in range(epochs):
        model.train()
        order = torch.randperm(len(y_train), generator=shuffle)
        total_loss = 0.0
        for start in range(0, len(order), batch_size):
            index = order[start : start + batch_size]
            x = augment(x_train[index].to(device), generator)
            loss = F.cross_entropy(model(x), y_train[index].to(device), weight=weights, label_smoothing=0.05)
            optimizer.zero_grad()
            loss.backward()
            optimizer.step()
            scheduler.step()
            total_loss += float(loss) * len(index)
        metrics = digit_metrics(val_set, predict(model, val_set["images"], device)) if len(val_set["labels"]) else {}
        accuracy = metrics.get("slot_accuracy", 0.0)
        mlflow.log_metrics(
            {
                "train_loss": total_loss / len(order),
                "val_slot_accuracy": accuracy,
                "val_exact_match": metrics.get("exact_match", 0.0),
            },
            step=epoch,
        )
        print(f"epoch {epoch + 1}/{epochs} loss {total_loss / len(order):.4f} val slot acc {accuracy:.4f}", flush=True)
        if accuracy >= best["slot_accuracy"]:
            best = {"slot_accuracy": accuracy, "epoch": epoch + 1, **metrics}
            torch.save({"arch": "digit_cnn", "model": model.state_dict(), "metrics": best}, out / "best.pt")
    (out / "metrics.json").write_text(json.dumps(best, indent=2) + "\n")
    return best


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="train_digit", description=__doc__.split("\n\n")[0])
    parser.add_argument("--data", type=Path, required=True, help="dataset directory written by the builder")
    parser.add_argument("--out", type=Path, required=True, help="directory for checkpoints")
    parser.add_argument("--epochs", type=int, default=30)
    parser.add_argument("--batch-size", type=int, default=256)
    parser.add_argument("--lr", type=float, default=3e-3)
    parser.add_argument("--device", default="cpu", help="cpu, cuda or mps")
    parser.add_argument("--seed", type=int, default=0)
    parser.add_argument("--init", type=Path, help="checkpoint to fine-tune from")
    args = parser.parse_args(argv)

    tracking.setup("digit_cls")
    with mlflow.start_run():
        mlflow.log_params({k: str(v) for k, v in vars(args).items()})
        mlflow.log_param("parameters", count_parameters(DigitCNN()))
        best = train(args.data, args.out, args.epochs, args.batch_size, args.lr, args.device, args.seed, args.init)
        mlflow.log_artifact(str(args.out / "best.pt"), "checkpoint")
        mlflow.log_artifact(str(args.out / "metrics.json"), "checkpoint")
    print(json.dumps({k: v for k, v in best.items() if not isinstance(v, dict | list)}, indent=2))
    return 0


if __name__ == "__main__":
    sys.exit(main())
