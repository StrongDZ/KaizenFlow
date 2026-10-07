"""Kaggle "Tenth of step of meter digits" (frankhaverland/tenthofstepofmeterdigits,
CC0), collected with AI-on-the-edge-device cameras on real water, gas and
power meters: mechanical drums, LCD and LED digits, cropped tightly.

    data/public/meter-digits-tenth/meterdigits/<d.t>/<name>.jpg   20x32 RGB

A folder name d.t says the drum shows digit d moved on by t tenths towards
d+1. The digit classifier has no tenths: a drum is read as d while the next
digit has barely appeared, as d+1 once it has nearly arrived, and as
"transition" in between (edge-agent then keeps the smaller digit).
"""

from __future__ import annotations

from collections.abc import Iterator
from pathlib import Path

import cv2
import numpy as np

from gauge_ml import CLASS_TRANSITION

# Tenths up to this value still read as the lower digit; from 10 - this on
# as the upper one.
STEADY_TENTHS = 2


def class_of(folder: str) -> int:
    """Class of a d.t folder name."""
    digit, tenth = (int(p) for p in folder.split("."))
    if tenth <= STEADY_TENTHS:
        return digit
    if tenth >= 10 - STEADY_TENTHS:
        return (digit + 1) % 10
    return CLASS_TRANSITION


def load(root: Path) -> Iterator[tuple[np.ndarray, int, dict]]:
    """Yields (grayscale crop, class, meta). The group is the capture (file
    name without the tenth prefix), so near-identical frames stay together."""
    base = root / "meterdigits"
    sequence = 0
    for folder in sorted(p for p in base.iterdir() if p.is_dir()):
        label = class_of(folder.name)
        for path in sorted(folder.glob("*.jpg")):
            image = cv2.imread(str(path), cv2.IMREAD_GRAYSCALE)
            if image is None:
                continue
            capture = path.stem.split("_", 1)[1] if "_" in path.stem else path.stem
            yield (
                image,
                label,
                {
                    "image": f"{folder.name}/{path.name}",
                    "sequence": sequence,
                    "group": capture,
                    "gauge_type": "rolling_counter",
                    "tenths": folder.name,
                },
            )
            sequence += 1
