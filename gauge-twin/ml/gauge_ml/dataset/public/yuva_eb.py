"""YUVA EB (Mendeley Data fnn44p4mj8 v1): 168 photos of seven-segment
digital energy meters at consumer premises in Tamil Nadu, by day and night,
blurred and tilted, with one COCO box per numeral (categories "Text 0".."Text 9").

    data/public/yuva-eb/coco.json
    data/public/yuva-eb/RAW IMAGES/<condition>/<n>.JPG

The COCO file names are Labelbox URLs ending in "-<n>.jpg"; <n> is the local
file name. Each box becomes a slot framed like the synthetic ones.
"""

from __future__ import annotations

import json
from collections.abc import Iterator
from pathlib import Path

import cv2
import numpy as np

from gauge_ml.dataset.public.trodo import slot_from_box


def load(root: Path) -> Iterator[tuple[np.ndarray, int, dict]]:
    coco = json.loads((root / "coco.json").read_text())
    local = {p.name.lower(): p for p in (root / "RAW IMAGES").glob("*/*") if p.suffix.lower() in (".jpg", ".jpeg")}
    digit_of = {c["id"]: int(c["name"].split()[-1]) for c in coco["categories"] if c["name"].split()[-1].isdigit()}
    boxes: dict[str, list] = {}
    for ann in coco["annotations"]:
        if ann["category_id"] in digit_of:
            boxes.setdefault(ann["image_id"], []).append((ann["bbox"], digit_of[ann["category_id"]]))
    for sequence, image in enumerate(sorted(coco["images"], key=lambda im: im["file_name"])):
        name = image["file_name"].split("%2F")[-1].rsplit("-", 1)[-1].lower()
        path = local.get(name)
        if path is None or image["id"] not in boxes:
            continue
        gray = cv2.imread(str(path), cv2.IMREAD_GRAYSCALE)
        if gray is None:
            continue
        digits = sorted(boxes[image["id"]], key=lambda b: b[0][0])
        for slot, ((x, y, w, h), label) in enumerate(digits):
            yield (
                slot_from_box(gray, (x, y, x + w, y + h)),
                label,
                {
                    "image": f"{path.parent.name}/{path.name}",
                    "sequence": sequence,
                    "group": path.name,
                    "slot": slot,
                    "gauge_type": "seg7",
                    "condition": path.parent.name,
                },
            )
