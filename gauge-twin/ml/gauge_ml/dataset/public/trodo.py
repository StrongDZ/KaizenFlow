"""TRODO (Mendeley Data 6y8m379mkt v2, CC BY 4.0): 2,389 photos of vehicle
odometers from a delivery fleet, 858 mechanical ("analog": rolling drums) and
1,531 digital (LCD). Every digit has a bounding box (Pascal VOC); "X" and ","
mark other characters.

    data/public/trodo/trodo-v01/images/<name>.jpg
    data/public/trodo/trodo-v01/pascal voc 1.1/Annotations/<name>.xml
    data/public/trodo/trodo-v01/ground truth/groundtruth.json   type and mileage per image

The digit boxes stand for a perfect commissioning: each slot is cut around
its box with the framing of the synthetic slots (digit height = 85% of the
slot, slot aspect 32:48), so these crops need no further framing.
"""

from __future__ import annotations

import json
import xml.etree.ElementTree as ET
from collections.abc import Iterator
from pathlib import Path

import cv2
import numpy as np

from gauge_ml import DIGIT_H, DIGIT_W
from gauge_ml.dataset.public.slots import DIGIT_FILL

GAUGE_TYPE = {"analog": "rolling_counter", "digital": "seg7"}


def slot_from_box(gray: np.ndarray, box: tuple[float, float, float, float]) -> np.ndarray:
    """(DIGIT_H, DIGIT_W) slot centred on a digit box (x0, y0, x1, y1)."""
    x0, y0, x1, y1 = box
    cx, cy = (x0 + x1) / 2, (y0 + y1) / 2
    slot_h = (y1 - y0) / DIGIT_FILL
    slot_w = slot_h * DIGIT_W / DIGIT_H
    src = np.array(
        [[cx - slot_w / 2, cy - slot_h / 2], [cx + slot_w / 2, cy - slot_h / 2], [cx + slot_w / 2, cy + slot_h / 2]],
        dtype=np.float32,
    )
    dst = np.array([[0, 0], [DIGIT_W, 0], [DIGIT_W, DIGIT_H]], dtype=np.float32)
    return cv2.warpAffine(
        gray,
        cv2.getAffineTransform(src, dst),
        (DIGIT_W, DIGIT_H),
        flags=cv2.INTER_AREA,
        borderMode=cv2.BORDER_REPLICATE,
    )


def load(root: Path) -> Iterator[tuple[np.ndarray, int, dict]]:
    """Yields (slot, class, meta) for every digit box; meta: image, sequence
    (one per image, digits ordered left to right), slot index, odometer type."""
    base = root / "trodo-v01"
    truth = json.loads((base / "ground truth" / "groundtruth.json").read_text())["odometers"]
    for sequence, entry in enumerate(sorted(truth, key=lambda e: e["image"])):
        xml = base / "pascal voc 1.1" / "Annotations" / (Path(entry["image"]).stem + ".xml")
        if not xml.exists():
            continue
        digits = []
        for obj in ET.parse(xml).findall("object"):
            name = obj.findtext("name")
            if name is None or not name.isdigit():
                continue
            b = obj.find("bndbox")
            box = tuple(float(b.findtext(k)) for k in ("xmin", "ymin", "xmax", "ymax"))
            digits.append((box, int(name)))
        if not digits:
            continue
        gray = cv2.imread(str(base / "images" / entry["image"]), cv2.IMREAD_GRAYSCALE)
        if gray is None:
            continue
        digits.sort(key=lambda d: d[0][0])
        for slot, (box, label) in enumerate(digits):
            yield (
                slot_from_box(gray, box),
                label,
                {
                    "image": entry["image"],
                    "sequence": sequence,
                    "group": entry["image"],
                    "slot": slot,
                    "odometer_type": entry["odometer_type"],
                    "gauge_type": GAUGE_TYPE[entry["odometer_type"]],
                },
            )
