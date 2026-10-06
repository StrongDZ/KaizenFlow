"""Kaggle "LCD digits" (markuspfeifer/lcd-digits, CC0): real LCD digit crops of a
digital multimeter, one folder per class.

    data/public/lcd-digits/data/<0-9>/<n>.jpg   150x300, dark strokes on a light face
"""

from __future__ import annotations

from collections.abc import Iterator
from pathlib import Path

import cv2
import numpy as np

POLARITY = "dark"
GROUP_SIZE = 50


def load(root: Path) -> Iterator[tuple[np.ndarray, int, dict]]:
    """Yields (grayscale crop, class, meta) in a stable order. Each crop is
    its own display. The crops are numbered frames of one multimeter, so
    neighbours in a folder are near-copies: blocks of GROUP_SIZE form a group."""
    sequence = 0
    for label in range(10):
        folder = root / "data" / str(label)
        for path in sorted(folder.glob("*.jpg"), key=lambda p: int(p.stem) if p.stem.isdigit() else p.stem):
            image = cv2.imread(str(path), cv2.IMREAD_GRAYSCALE)
            if image is not None:
                number = int(path.stem) if path.stem.isdigit() else 0
                yield (
                    image,
                    label,
                    {
                        "image": f"{label}/{path.name}",
                        "sequence": sequence,
                        "group": f"{label}/{number // GROUP_SIZE}",
                        "gauge_type": "seg7",
                    },
                )
                sequence += 1
