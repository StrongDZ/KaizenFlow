"""Kaggle "Seven-Segment Industrial Digits Dataset (Factory-Collected)"
(thearshiya/7-segment-industrial-digits-dataset; licence not stated, so used
for evaluation and research only): 640x640 photos of 4-digit LED modules on
machines, the reading in the file name.

    data/public/seg7-industrial/<train|val|test>/<id>_<reading>.jpg

There are no boxes. The lit segments (bright, warm-coloured pixels) give the
box of the digits shown, which is cut into as many equal slots as the
reading has digits, the way edge-agent cuts a commissioned quad; the unlit
leading positions of the module, one pitch each to the left, are blank slots. Photos where
the lit box is wrong give wrong slots; check with the montage of eval_public.
"""

from __future__ import annotations

from collections.abc import Iterator
from pathlib import Path

import cv2
import numpy as np

from gauge_ml import CLASS_BLANK
from gauge_ml.dataset.public.trodo import slot_from_box

DIGITS = 4


def lit_box(image: np.ndarray) -> tuple[float, float, float, float] | None:
    """Box (x0, y0, x1, y1) around the lit segments: bright, saturated
    red/orange/yellow pixels; blobs far from the biggest group are dropped."""
    hsv = cv2.cvtColor(image, cv2.COLOR_BGR2HSV)
    hue, sat, val = hsv[..., 0], hsv[..., 1], hsv[..., 2]
    warm = (hue <= 35) | (hue >= 160)
    mask = (warm & (sat >= 70) & (val >= 150)).astype(np.uint8) * 255
    mask = cv2.morphologyEx(mask, cv2.MORPH_OPEN, np.ones((3, 3), np.uint8))
    count, _, stats, _ = cv2.connectedComponentsWithStats(mask, connectivity=8)
    blobs = [stats[i] for i in range(1, count) if stats[i][4] >= 30]
    if not blobs:
        return None
    main = max(blobs, key=lambda b: b[4])
    height = main[3]
    keep = [b for b in blobs if abs((b[1] + b[3] / 2) - (main[1] + main[3] / 2)) < height and b[3] > 0.3 * height]
    x0 = min(b[0] for b in keep)
    y0 = min(b[1] for b in keep)
    x1 = max(b[0] + b[2] for b in keep)
    y1 = max(b[1] + b[3] for b in keep)
    return float(x0), float(y0), float(x1), float(y1)


def labels_of(reading: str) -> list[int] | None:
    """Classes of the lit digits (unlit leading positions are not cut)."""
    if not reading.isdigit() or len(reading) > DIGITS:
        return None
    return [int(c) for c in reading]


def load(root: Path) -> Iterator[tuple[np.ndarray, int, dict]]:
    """Yields (slot, class, meta) for every lit digit of every photo whose
    lit segments were found."""
    sequence = 0
    for split in ("train", "val", "test"):
        for path in sorted((root / split).glob("*.jpg")):
            labels = labels_of(path.stem.split("_", 1)[-1])
            image = cv2.imread(str(path))
            if labels is None or image is None:
                continue
            box = lit_box(image)
            if box is None:
                continue
            gray = cv2.cvtColor(image, cv2.COLOR_BGR2GRAY)
            x0, y0, x1, y1 = box
            pitch = (x1 - x0) / len(labels)
            # Unlit leading positions of the 4-digit module sit left of the lit box.
            unlit = DIGITS - len(labels)
            x0 -= unlit * pitch
            labels = [CLASS_BLANK] * unlit + labels
            for slot, label in enumerate(labels):
                if x0 + slot * pitch < 0:
                    continue
                crop = slot_from_box(gray, (x0 + slot * pitch, y0, x0 + (slot + 1) * pitch, y1))
                yield (
                    crop,
                    label,
                    {
                        "image": f"{split}/{path.name}",
                        "sequence": sequence,
                        "group": path.stem,
                        "slot": slot,
                        "gauge_type": "seg7",
                        "box": list(box),
                    },
                )
            sequence += 1
