"""Real analog gauges with hand-placed keypoints, exported from Roboflow in
YOLO detection format: one small box per keypoint, classes named "center",
"min", "max", "tip" (and optionally "gauge" for the face).

    data/public/<name>/**/data.yaml
    data/public/<name>/**/<split>/images/*.jpg, <split>/labels/*.txt

Used for: gauge-analog (Roboflow khang-nguyen-4jqxa, MIT, mirrored on Kaggle
as nguyenhuynhhh/analog-label-kim) and analog-merged (nguyenhuynhhh, CC BY 4.0).

There are no readings, but none are needed to score a dial reader: with the
labelled min and max marks as calib (min_val 0, max_val 1), the value of the
labelled needle is its share of the scale, and the error of a predicted
needle is directly a share of full scale. The "mid" keypoint of the model is
not labelled and is marked invisible (the loss ignores it).
"""

from __future__ import annotations

from collections.abc import Iterator
from pathlib import Path

import cv2
import numpy as np

from gauge_ml import DIAL_INPUT, KP_CENTER, KP_END, KP_MID, KP_START, KP_TIP
from gauge_ml.dataset.public.yolo_digits import _names, original_photo
from gauge_ml.geometry import dial_value_from_points

# Margin around the gauge when it has no "gauge" box: the face is assumed to
# reach this many times the longest centre-to-keypoint distance.
FACE_FROM_KEYPOINTS = 1.25
# Margin added around the face, as in dataset.dial (commissioning never draws
# the same box twice).
MARGIN = (0.02, 0.20)


def _image_for(labels_path: Path) -> Path | None:
    for ext in (".jpg", ".png", ".jpeg"):
        candidate = labels_path.parent.parent / "images" / (labels_path.stem + ext)
        if candidate.exists():
            return candidate
    return None


def sweep_of(center: np.ndarray, start: np.ndarray, end: np.ndarray, tip: np.ndarray) -> str:
    """Scale direction on screen: the scale runs from start to end the long
    way round the dead zone at the bottom; "cw" when that goes clockwise."""
    a_start = np.degrees(np.arctan2(*(start - center)[::-1]))
    a_end = np.degrees(np.arctan2(*(end - center)[::-1]))
    # Clockwise span from start to end (y down: increasing angle is clockwise).
    cw_span = (a_end - a_start) % 360.0
    return "cw" if cw_span >= 180.0 else "ccw"


def load(root: Path, seed: int = 0) -> Iterator[tuple[np.ndarray, dict]]:
    """Yields (256x256 BGR crop, labels) with keypoints in crop pixels."""
    rng = np.random.default_rng(seed)
    for yaml_path in sorted(root.rglob("data.yaml")):
        names = _names(yaml_path)
        index = {n.lower(): i for i, n in enumerate(names)}
        if not {"center", "min", "max", "tip"} <= set(index):
            continue
        for labels_path in sorted(yaml_path.parent.rglob("labels/*.txt")):
            image_path = _image_for(labels_path)
            if image_path is None:
                continue
            boxes: dict[int, list[tuple[float, float, float, float]]] = {}
            for line in labels_path.read_text().splitlines():
                parts = line.split()
                if len(parts) < 5:
                    continue
                boxes.setdefault(int(parts[0]), []).append(tuple(float(v) for v in parts[1:5]))
            # Exactly one of each keypoint; images with several gauges are skipped.
            if any(len(boxes.get(index[k], [])) != 1 for k in ("center", "min", "max", "tip")):
                continue
            image = cv2.imread(str(image_path))
            if image is None:
                continue
            h, w = image.shape[:2]

            # Keypoint = centre of its box, in image pixels.
            center, start, end, tip = (
                np.array(boxes[index[name]][0][:2]) * np.array([w, h]) for name in ("center", "min", "max", "tip")
            )
            if "gauge" in index and len(boxes.get(index["gauge"], [])) == 1:
                gx, gy, gw, gh = boxes[index["gauge"]][0]
                face = (gx * w - gw * w / 2, gy * h - gh * h / 2, gw * w, gh * h)
            else:
                reach = FACE_FROM_KEYPOINTS * max(np.linalg.norm(p - center) for p in (start, end, tip))
                face = (center[0] - reach, center[1] - reach, 2 * reach, 2 * reach)
            fx, fy, fw, fh = face
            left, right = rng.uniform(*MARGIN, 2) * fw
            top, bottom = rng.uniform(*MARGIN, 2) * fh
            x0, y0 = max(0, int(round(fx - left))), max(0, int(round(fy - top)))
            x1, y1 = min(w, int(round(fx + fw + right))), min(h, int(round(fy + fh + bottom)))
            if x1 - x0 < 16 or y1 - y0 < 16:
                continue
            crop = cv2.resize(image[y0:y1, x0:x1], (DIAL_INPUT, DIAL_INPUT), interpolation=cv2.INTER_AREA)
            scale = np.array([DIAL_INPUT / (x1 - x0), DIAL_INPUT / (y1 - y0)])
            offset = np.array([x0, y0])
            keypoints = np.zeros((5, 2), np.float32)
            visible = np.zeros(5, bool)
            for k, p in ((KP_CENTER, center), (KP_START, start), (KP_END, end), (KP_TIP, tip)):
                keypoints[k] = (p - offset) * scale
                visible[k] = True
            keypoints[KP_MID] = keypoints[KP_CENTER]  # unlabelled, stays invisible
            c, s, e, t = (keypoints[k].astype(np.float64) for k in (KP_CENTER, KP_START, KP_END, KP_TIP))
            calib = {
                "center": c.tolist(),
                "min_pt": s.tolist(),
                "max_pt": e.tolist(),
                "min_val": 0.0,
                "max_val": 1.0,
                "sweep": sweep_of(c, s, e, t),
                "scale": "linear",
            }
            yield (
                crop,
                {
                    "image": str(image_path.relative_to(root)),
                    "group": f"{yaml_path.parent.name}/{original_photo(labels_path.stem)}",
                    "keypoints": keypoints,
                    "visible": visible,
                    "calib": calib,
                    "value": dial_value_from_points(c, t, calib),
                },
            )
