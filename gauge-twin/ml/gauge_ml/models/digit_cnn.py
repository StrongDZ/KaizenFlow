"""Small CNN classifying one digit slot (32x48 grayscale) into 12 classes."""

from __future__ import annotations

import torch
from torch import nn

from gauge_ml import DIGIT_H, DIGIT_W, N_DIGIT_CLASSES


def _block(cin: int, cout: int) -> nn.Sequential:
    return nn.Sequential(
        nn.Conv2d(cin, cout, 3, padding=1, bias=False),
        nn.BatchNorm2d(cout),
        nn.ReLU(inplace=True),
        nn.Conv2d(cout, cout, 3, padding=1, bias=False),
        nn.BatchNorm2d(cout),
        nn.ReLU(inplace=True),
        nn.MaxPool2d(2),
    )


class DigitCNN(nn.Module):
    """Input (B, 1, 48, 32) in [0, 1]; output (B, 12) logits."""

    def __init__(self, width: int = 32, dropout: float = 0.2) -> None:
        super().__init__()
        self.features = nn.Sequential(_block(1, width), _block(width, 2 * width), _block(2 * width, 4 * width))
        self.head = nn.Sequential(
            nn.AdaptiveAvgPool2d(1), nn.Flatten(), nn.Dropout(dropout), nn.Linear(4 * width, N_DIGIT_CLASSES)
        )

    def forward(self, x: torch.Tensor) -> torch.Tensor:
        return self.head(self.features(x))


class DigitExport(nn.Module):
    """Deployment graph: (B, 1, 48, 32) float32 in [0, 1] -> (B, 12) class probabilities.

    temperature divides the logits before the softmax. Training with label
    smoothing leaves the classifier under-confident (it is right 98.7% of the
    time and says 94%), and edge-agent multiplies the probabilities of every
    slot of a display into its confidence; calibrate_digit fits the
    temperature on the validation split so that a probability means what it
    says. The predicted class does not change.
    """

    input_shape = (1, DIGIT_H, DIGIT_W)

    def __init__(self, model: DigitCNN, temperature: float = 1.0) -> None:
        super().__init__()
        self.model = model
        self.temperature = float(temperature)

    def forward(self, x: torch.Tensor) -> torch.Tensor:
        return torch.softmax(self.model(x) / self.temperature, dim=1)


def count_parameters(model: nn.Module) -> int:
    return sum(p.numel() for p in model.parameters())
