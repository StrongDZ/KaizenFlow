"""Trains the dial keypoint model.

python -m gauge_ml.train_dial --data data/ml --out data/ml-runs/dial --epochs 60 --device cuda
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

import mlflow
import torch
import torch.nn.functional as F
from torch.utils.data import DataLoader

from gauge_ml import tracking
from gauge_ml.dial_data import DialDataset, load_index
from gauge_ml.eval_dial import dial_metrics, predict
from gauge_ml.models.dial_keypoint import BACKBONES, DialKeypointNet, normalise, soft_argmax

HEATMAP_SIGMA = 1.5  # in heatmap cells


def target_heatmaps(keypoints: torch.Tensor, size: int) -> torch.Tensor:
    """Gaussian target distributions (B, K, size*size), each summing to 1."""
    axis = (torch.arange(size, device=keypoints.device, dtype=keypoints.dtype) + 0.5) / size
    dx = (axis.view(1, 1, 1, size) - keypoints[:, :, 0].view(*keypoints.shape[:2], 1, 1)) * size
    dy = (axis.view(1, 1, size, 1) - keypoints[:, :, 1].view(*keypoints.shape[:2], 1, 1)) * size
    target = torch.exp(-(dx**2 + dy**2) / (2 * HEATMAP_SIGMA**2)).flatten(2)
    return target / target.sum(dim=2, keepdim=True).clamp(min=1e-8)


def keypoint_loss(
    heatmaps: torch.Tensor, visibility: torch.Tensor, keypoints: torch.Tensor, visible: torch.Tensor
) -> torch.Tensor:
    """Cross-entropy to a Gaussian target plus L1 on the soft-argmax position
    (both on visible keypoints only), plus the visibility classification."""
    mask = visible.float()
    count = mask.sum().clamp(min=1.0)
    log_prob = F.log_softmax(heatmaps.flatten(2), dim=2)
    shape = -(target_heatmaps(keypoints, heatmaps.shape[-1]) * log_prob).sum(dim=2)
    position = (soft_argmax(heatmaps) - keypoints).abs().sum(dim=2)
    seen = F.binary_cross_entropy_with_logits(visibility, mask)
    return ((shape * mask).sum() + 20.0 * (position * mask).sum()) / count + seen


def train(
    data: Path,
    out: Path,
    backbone: str,
    pretrained: bool,
    epochs: int,
    batch_size: int,
    lr: float,
    device: str,
    workers: int,
    seed: int,
    init: Path | None = None,
) -> dict:
    torch.manual_seed(seed)
    train_rows, val_rows = load_index(data, "train"), load_index(data, "val")
    if not train_rows:
        raise SystemExit(f"no dial samples in {data}/dial/train")
    dataset = DialDataset(train_rows, train=True, seed=seed)
    loader = DataLoader(
        dataset, batch_size=batch_size, shuffle=True, num_workers=workers, drop_last=len(train_rows) > batch_size
    )

    if init is not None:
        # Fine-tuning: start from an earlier checkpoint instead of ImageNet.
        checkpoint = torch.load(init, map_location="cpu", weights_only=True)
        found = f"{checkpoint.get('arch')}/{checkpoint.get('backbone')}"
        if found != f"dial_keypoint/{backbone}":
            raise SystemExit(f"{init}: checkpoint is {found}, not dial_keypoint/{backbone}")
        model = DialKeypointNet(backbone, pretrained=False)
        model.load_state_dict(checkpoint["model"])
        model = model.to(device)
    else:
        model = DialKeypointNet(backbone, pretrained).to(device)
    optimizer = torch.optim.AdamW(model.parameters(), lr=lr, weight_decay=1e-4)
    scheduler = torch.optim.lr_scheduler.OneCycleLR(optimizer, max_lr=lr, total_steps=max(1, epochs * len(loader)))

    out.mkdir(parents=True, exist_ok=True)
    best: dict = {"mean_percent_fs": float("inf")}
    for epoch in range(epochs):
        dataset.epoch = epoch
        model.train()
        total, seen = 0.0, 0
        for images, keypoints, visible in loader:
            images, keypoints, visible = images.to(device), keypoints.to(device), visible.to(device)
            heatmaps, visibility = model(normalise(images))
            loss = keypoint_loss(heatmaps, visibility, keypoints, visible)
            optimizer.zero_grad()
            loss.backward()
            optimizer.step()
            scheduler.step()
            total, seen = total + float(loss) * len(images), seen + len(images)
        metrics = dial_metrics(val_rows, predict(model, val_rows, device)[0]) if val_rows else {}
        mean_fs = metrics.get("percent_fs", {}).get("mean", float("inf"))
        mlflow.log_metrics(
            {
                "train_loss": total / max(seen, 1),
                "val_mean_percent_fs": min(mean_fs, 1e6),
                "val_keypoint_error_px": metrics.get("keypoint_error_px", {}).get("mean", 0.0),
            },
            step=epoch,
        )
        print(
            f"epoch {epoch + 1}/{epochs} loss {total / max(seen, 1):.4f} val mean error {mean_fs:.2f}% FS", flush=True
        )
        if mean_fs <= best["mean_percent_fs"] or not val_rows:
            best = {"mean_percent_fs": mean_fs, "epoch": epoch + 1, **metrics}
            torch.save({"arch": "dial_keypoint", "backbone": backbone, "model": model.state_dict()}, out / "best.pt")
    (out / "metrics.json").write_text(json.dumps(best, indent=2) + "\n")
    return best


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="train_dial", description=__doc__.split("\n\n")[0])
    parser.add_argument("--data", type=Path, required=True, help="dataset directory written by the builder")
    parser.add_argument("--out", type=Path, required=True, help="directory for checkpoints")
    parser.add_argument("--backbone", choices=BACKBONES, default="mobilenet_v3_small")
    parser.add_argument("--no-pretrained", action="store_true", help="do not load ImageNet weights")
    parser.add_argument("--epochs", type=int, default=60)
    parser.add_argument("--batch-size", type=int, default=32)
    parser.add_argument("--lr", type=float, default=2e-3)
    parser.add_argument("--device", default="cpu", help="cpu, cuda or mps")
    parser.add_argument("--workers", type=int, default=2, help="data loader workers")
    parser.add_argument("--seed", type=int, default=0)
    parser.add_argument("--init", type=Path, help="checkpoint to fine-tune from (same backbone)")
    args = parser.parse_args(argv)

    tracking.setup("dial_pose")
    with mlflow.start_run():
        mlflow.log_params({k: str(v) for k, v in vars(args).items()})
        best = train(
            args.data,
            args.out,
            args.backbone,
            not args.no_pretrained,
            args.epochs,
            args.batch_size,
            args.lr,
            args.device,
            args.workers,
            args.seed,
            args.init,
        )
        mlflow.log_artifact(str(args.out / "best.pt"), "checkpoint")
        mlflow.log_artifact(str(args.out / "metrics.json"), "checkpoint")
    print(json.dumps(best.get("percent_fs", {}), indent=2))
    return 0


if __name__ == "__main__":
    sys.exit(main())
