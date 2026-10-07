"""Time displays on machines (hour meters, panel timers, digital clocks): openly
licensed photos from Openverse and Wikimedia Commons, labelled by
gauge_ml.timedisp.autolabel (two VLMs must agree; no human labels).

    data/public/time-displays/raw/<id>.jpg
    data/public/time-displays/manifest.csv    source, URL, licence and author per photo
    data/public/time-displays/labels.jsonl    quad, digit boxes, reading per photo

Each slot is cut around the digit box found in the straightened band, framed
like the synthetic slots (a "1" right-aligned in a full-width cell), so these
crops need no further framing. Photos whose licence does not allow training
carry eval_only and go to the test split.
"""

from __future__ import annotations

import json
from collections.abc import Iterator
from pathlib import Path

import cv2
import numpy as np

from gauge_ml import CLASS_TRANSITION
from gauge_ml.dataset.public.trodo import slot_from_box


def load(root: Path) -> Iterator[tuple[np.ndarray, int, dict]]:
    """Yields (slot, class, meta) for every digit of every accepted photo; a
    rolling drum is CLASS_TRANSITION."""
    # Imported here: timedisp.locate uses slots, whose package imports this module.
    from gauge_ml.timedisp.locate import rectify

    path = root / "labels.jsonl"
    if not path.exists():
        return
    entries = [json.loads(line) for line in path.read_text().splitlines() if line.strip()]
    accepted = sorted((e for e in entries if e["status"] == "accepted"), key=lambda e: e["id"])
    for sequence, e in enumerate(accepted):
        gray = cv2.imread(str(root / "raw" / f"{e['id']}.jpg"), cv2.IMREAD_GRAYSCALE)
        if gray is None:
            continue
        band = rectify(gray, np.array(e["quad"], np.float32), e["band_h"])
        cell_w = float(np.median([x1 - x0 for x0, _, x1, _ in e["cells"]]))
        for slot, ((x0, y0, x1, y1), digit, rolling) in enumerate(
            zip(e["cells"], e["text"], e["rolling"], strict=True)
        ):
            if x1 - x0 < 0.6 * cell_w:
                x0 = x1 - cell_w  # a "1" sits at the right of its cell, as on the rendered displays
            yield (
                slot_from_box(band, (x0, y0, x1, y1)),
                CLASS_TRANSITION if rolling == "1" else int(digit),
                {
                    "image": e["id"],
                    "sequence": sequence,
                    "group": e["group"],
                    "slot": slot,
                    "kind": e["kind"],
                    "gauge_type": e["gauge_type"],
                    "eval_only": bool(e["eval_only"]),
                },
            )
