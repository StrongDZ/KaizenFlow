"""Keypoint network for analog dials: a torchvision backbone, a light decoder
producing one heatmap per keypoint, and a visibility score per keypoint.

The input is a single unrectified crop around one gauge, so no detection
stage is needed.
"""

from __future__ import annotations

import torch
import torch.nn.functional as F
import torchvision
from torch import nn

from gauge_ml import DIAL_INPUT, KEYPOINTS

BACKBONES = ("mobilenet_v3_small", "resnet18")
IMAGENET_MEAN = (0.485, 0.456, 0.406)
IMAGENET_STD = (0.229, 0.224, 0.225)


class _Backbone(nn.Module):
    """Returns feature maps at strides 4, 8 and 16."""

    def __init__(self, name: str, pretrained: bool) -> None:
        super().__init__()
        if name == "mobilenet_v3_small":
            weights = torchvision.models.MobileNet_V3_Small_Weights.IMAGENET1K_V1 if pretrained else None
            features = torchvision.models.mobilenet_v3_small(weights=weights).features
            self.stages = nn.ModuleList([features[:2], features[2:4], features[4:9]])
            self.channels = (16, 24, 48)
        elif name == "resnet18":
            weights = torchvision.models.ResNet18_Weights.IMAGENET1K_V1 if pretrained else None
            net = torchvision.models.resnet18(weights=weights)
            stem = nn.Sequential(net.conv1, net.bn1, net.relu, net.maxpool, net.layer1)
            self.stages = nn.ModuleList([stem, net.layer2, net.layer3])
            self.channels = (64, 128, 256)
        else:
            raise ValueError(f"unknown backbone {name!r}; choose one of {BACKBONES}")

    def forward(self, x: torch.Tensor) -> list[torch.Tensor]:
        out = []
        for stage in self.stages:
            x = stage(x)
            out.append(x)
        return out


def _fuse(cin: int, cout: int) -> nn.Sequential:
    return nn.Sequential(nn.Conv2d(cin, cout, 3, padding=1, bias=False), nn.BatchNorm2d(cout), nn.ReLU(inplace=True))


class DialKeypointNet(nn.Module):
    """Input (B, 3, 256, 256) normalised RGB; outputs heatmap logits
    (B, 5, 64, 64) and visibility logits (B, 5)."""

    def __init__(self, backbone: str = "mobilenet_v3_small", pretrained: bool = True, width: int = 64) -> None:
        super().__init__()
        self.backbone_name = backbone
        self.backbone = _Backbone(backbone, pretrained)
        c4, c8, c16 = self.backbone.channels
        self.up8 = _fuse(c16 + c8, width)
        self.up4 = _fuse(width + c4, width)
        self.heatmap = nn.Conv2d(width, len(KEYPOINTS), 1)
        self.visibility = nn.Sequential(nn.AdaptiveAvgPool2d(1), nn.Flatten(), nn.Linear(c16, len(KEYPOINTS)))

    def forward(self, x: torch.Tensor) -> tuple[torch.Tensor, torch.Tensor]:
        f4, f8, f16 = self.backbone(x)
        y = self.up8(torch.cat([F.interpolate(f16, size=f8.shape[-2:], mode="bilinear", align_corners=False), f8], 1))
        y = self.up4(torch.cat([F.interpolate(y, size=f4.shape[-2:], mode="bilinear", align_corners=False), f4], 1))
        return self.heatmap(y), self.visibility(f16)


def soft_argmax(heatmaps: torch.Tensor) -> torch.Tensor:
    """Sub-pixel keypoint positions from heatmap logits.

    Returns (B, K, 2) as (x, y) in [0, 1]: the expectation of the softmax
    distribution over the cell centres.
    """
    b, k, h, w = heatmaps.shape
    prob = torch.softmax(heatmaps.reshape(b, k, h * w), dim=2).reshape(b, k, h, w)
    xs = (torch.arange(w, device=heatmaps.device, dtype=heatmaps.dtype) + 0.5) / w
    ys = (torch.arange(h, device=heatmaps.device, dtype=heatmaps.dtype) + 0.5) / h
    x = (prob.sum(dim=2) * xs).sum(dim=2)
    y = (prob.sum(dim=3) * ys).sum(dim=2)
    return torch.stack([x, y], dim=2)


# Heatmap spread (standard deviation of the keypoint distribution, in heatmap
# cells) at which a keypoint is fully trusted and at which its confidence is
# 0.5, the MinConfidence below which edge-agent drops a frame. A sharp heatmap
# has the spread of the training target (sigma 1.5 cells per axis, 2.12 in the
# plane); doubt shows as a wide or two-peaked heatmap. 3.0 was chosen on the
# real validation split: it keeps 94.5% of the readings, 99.8% of them within
# 1.5% of full scale, and none of the errors above 10% (test: 92.9% kept,
# 99.1% within target, 0 of 10 large errors kept).
SPREAD_SURE = 2.12
SPREAD_HALF = 3.0


def heatmap_spread(heatmaps: torch.Tensor) -> torch.Tensor:
    """Standard deviation (B, K), in heatmap cells, of each keypoint's softmax distribution."""
    b, k, h, w = heatmaps.shape
    prob = torch.softmax(heatmaps.reshape(b, k, h * w), dim=2).reshape(b, k, h, w)
    xs = torch.arange(w, device=heatmaps.device, dtype=heatmaps.dtype) + 0.5
    ys = torch.arange(h, device=heatmaps.device, dtype=heatmaps.dtype) + 0.5
    px, py = prob.sum(dim=2), prob.sum(dim=3)  # marginals over x (B, K, W) and y (B, K, H)
    mx, my = (px * xs).sum(dim=2, keepdim=True), (py * ys).sum(dim=2, keepdim=True)
    variance = (px * (xs - mx) ** 2).sum(dim=2) + (py * (ys - my) ** 2).sum(dim=2)
    return torch.sqrt(variance.clamp(min=0.0))


def keypoint_confidence(heatmaps: torch.Tensor, visibility: torch.Tensor) -> torch.Tensor:
    """Confidence (B, K) in [0, 1]: the visibility score times how sharp the
    heatmap is (1 up to SPREAD_SURE, 0.5 at SPREAD_HALF, falling linearly).

    The visibility head alone says nothing on real data, where every labelled
    keypoint is visible: it answers 1.0 for right and wrong readings alike.
    """
    sharp = 1.0 - 0.5 * (heatmap_spread(heatmaps) - SPREAD_SURE) / (SPREAD_HALF - SPREAD_SURE)
    return torch.sigmoid(visibility) * sharp.clamp(0.0, 1.0)


def normalise(images: torch.Tensor) -> torch.Tensor:
    """RGB images in [0, 1] to the ImageNet statistics the backbones expect."""
    mean = torch.tensor(IMAGENET_MEAN, device=images.device, dtype=images.dtype).view(1, 3, 1, 1)
    std = torch.tensor(IMAGENET_STD, device=images.device, dtype=images.dtype).view(1, 3, 1, 1)
    return (images - mean) / std


class DialExport(nn.Module):
    """Deployment graph: (B, 3, 256, 256) float32 RGB in [0, 1] ->
    keypoints (B, 5, 2) in input pixels (x, y) and confidence (B, 5) in [0, 1].

    Normalisation and keypoint decoding are part of the graph, so the
    DeepStream parser only reads 15 numbers per gauge.
    """

    input_shape = (3, DIAL_INPUT, DIAL_INPUT)

    def __init__(self, model: DialKeypointNet) -> None:
        super().__init__()
        self.model = model

    def forward(self, x: torch.Tensor) -> tuple[torch.Tensor, torch.Tensor]:
        heatmaps, visibility = self.model(normalise(x))
        return soft_argmax(heatmaps) * float(DIAL_INPUT), keypoint_confidence(heatmaps, visibility)
