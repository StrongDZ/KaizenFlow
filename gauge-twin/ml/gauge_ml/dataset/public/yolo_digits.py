"""Seven-segment datasets exported from Roboflow in YOLO format, one box per
digit (classes named "0".."9"; other classes are ignored).

    data/public/<name>/**/data.yaml
    data/public/<name>/**/<split>/images/*.jpg, <split>/labels/*.txt

Roboflow exports several augmented copies of one photo ("<stem>_jpg.rf.<hash>");
the group of a sample is the original photo, so copies never end up on both
sides of a train/test split.

blanks=True also yields the place one digit pitch left of the leftmost
digit as a blank slot. Off by default: on the exports checked it was mostly
the bezel or an unannotated leading zero, not an unlit digit.
"""

from __future__ import annotations

import re
from collections.abc import Iterator
from pathlib import Path

import cv2
import numpy as np

from gauge_ml import CLASS_BLANK
from gauge_ml.dataset.public.trodo import slot_from_box


def _names(yaml_path: Path) -> list[str]:
    """Class names of a Roboflow data.yaml (inline list or block list)."""
    text = yaml_path.read_text()
    inline = re.search(r"^names:\s*\[(.*?)\]", text, re.M | re.S)
    if inline:
        return [n.strip().strip("'\"") for n in inline.group(1).split(",")]
    block = re.search(r"^names:\s*\n((?:\s*-\s*.*\n?)+)", text, re.M)
    return [line.strip()[1:].strip().strip("'\"") for line in block.group(1).splitlines()] if block else []


def original_photo(stem: str) -> str:
    return stem.split(".rf.")[0]


def _blank_box(boxes: list[tuple[float, float, float, float]], width: int) -> tuple[float, ...] | None:
    """A digit-sized box one pitch left of the leftmost digit, or None."""
    if len(boxes) < 2:
        return None
    boxes = sorted(boxes)
    pitch = np.median([b[0] - a[0] for a, b in zip(boxes, boxes[1:], strict=False)])
    x0, y0, x1, y1 = boxes[0]
    if pitch <= (x1 - x0) * 0.8:
        return None
    candidate = (x0 - pitch, y0, x1 - pitch, y1)
    return candidate if candidate[0] >= 0 and candidate[2] <= width else None


def load(root: Path, gauge_type: str = "seg7", blanks: bool = False) -> Iterator[tuple[np.ndarray, int, dict]]:
    sequence = 0
    for yaml_path in sorted(root.rglob("data.yaml")):
        names = _names(yaml_path)
        digit_of = {i: int(n) for i, n in enumerate(names) if n.isdigit() and len(n) == 1}
        for labels_path in sorted(yaml_path.parent.rglob("labels/*.txt")):
            image_path = next(
                (
                    labels_path.parent.parent / "images" / (labels_path.stem + ext)
                    for ext in (".jpg", ".png", ".jpeg")
                    if (labels_path.parent.parent / "images" / (labels_path.stem + ext)).exists()
                ),
                None,
            )
            if image_path is None:
                continue
            gray = cv2.imread(str(image_path), cv2.IMREAD_GRAYSCALE)
            if gray is None:
                continue
            h, w = gray.shape
            digits = []
            for line in labels_path.read_text().splitlines():
                parts = line.split()
                if len(parts) != 5 or int(parts[0]) not in digit_of:
                    continue
                cx, cy, bw, bh = (float(v) for v in parts[1:])
                box = ((cx - bw / 2) * w, (cy - bh / 2) * h, (cx + bw / 2) * w, (cy + bh / 2) * h)
                digits.append((box, digit_of[int(parts[0])]))
            if not digits:
                continue
            digits.sort(key=lambda d: d[0][0])
            group = f"{yaml_path.parent.name}/{original_photo(labels_path.stem)}"
            meta = {
                "image": str(image_path.relative_to(root)),
                "sequence": sequence,
                "group": group,
                "gauge_type": gauge_type,
            }
            for slot, (box, label) in enumerate(digits):
                yield slot_from_box(gray, box), label, dict(meta, slot=slot)
            if blanks:
                blank = _blank_box([d[0] for d in digits], w)
                if blank is not None:
                    yield slot_from_box(gray, blank), CLASS_BLANK, dict(meta, slot=-1)
            sequence += 1
