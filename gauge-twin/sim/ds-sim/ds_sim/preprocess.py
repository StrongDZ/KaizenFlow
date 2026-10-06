"""Applies the preprocessing described by a model's preprocess.json.

Nothing about resize, colour order or normalisation is hard-coded here: the
file written by ml/gauge_ml/export.py is the only source.
"""

from __future__ import annotations

import json
from pathlib import Path

import cv2
import numpy as np

INTERPOLATION = {"area": cv2.INTER_AREA, "linear": cv2.INTER_LINEAR, "nearest": cv2.INTER_NEAREST}
# OpenCV's BGR -> gray conversion uses these weights; a spec asking for others
# would silently be ignored, so it is rejected instead.
OPENCV_GRAY_WEIGHTS_BGR = [0.114, 0.587, 0.299]


def load_spec(path: Path) -> dict:
    spec = json.loads(path.read_text())
    interpolation = spec["resize"]["interpolation"]
    if interpolation not in INTERPOLATION:
        raise ValueError(f"{path}: unsupported interpolation {interpolation!r}")
    if spec["color"] not in ("RGB", "GRAY"):
        raise ValueError(f"{path}: unsupported color {spec['color']!r}")
    if (
        spec["color"] == "GRAY"
        and spec.get("gray_weights_bgr", OPENCV_GRAY_WEIGHTS_BGR) != OPENCV_GRAY_WEIGHTS_BGR
    ):
        raise ValueError(f"{path}: unsupported gray weights {spec['gray_weights_bgr']}")
    expected = {"RGB": ("roi_crop", "stretch"), "GRAY": ("quad_warp_slots", "perspective_warp")}[
        spec["color"]
    ]
    if (spec["source"], spec["resize"]["mode"]) != expected:
        raise ValueError(
            f"{path}: unsupported source/resize {spec['source']}/{spec['resize']['mode']}"
        )
    return spec


def roi_crop(frame: np.ndarray, roi: list[int], spec: dict) -> np.ndarray:
    """Crops roi [x, y, w, h] from a BGR frame and stretches it to the model input (BGR uint8)."""
    x, y, w, h = roi
    size = (spec["input"]["width"], spec["input"]["height"])
    interpolation = INTERPOLATION[spec["resize"]["interpolation"]]
    return cv2.resize(frame[y : y + h, x : x + w], size, interpolation=interpolation)


def quad_slots(frame: np.ndarray, quad: np.ndarray, digits: int, spec: dict) -> np.ndarray:
    """Warps the quad (TL, TR, BR, BL) and cuts it into `digits` grayscale slots (digits, H, W)."""
    width, height = spec["input"]["width"], spec["input"]["height"]
    dst = np.array(
        [[0, 0], [digits * width, 0], [digits * width, height], [0, height]], dtype=np.float32
    )
    matrix = cv2.getPerspectiveTransform(np.asarray(quad, dtype=np.float32), dst)
    interpolation = INTERPOLATION[spec["resize"]["interpolation"]]
    strip = cv2.warpPerspective(frame, matrix, (digits * width, height), flags=interpolation)
    gray = cv2.cvtColor(strip, cv2.COLOR_BGR2GRAY)
    return np.stack([gray[:, i * width : (i + 1) * width] for i in range(digits)])


def to_tensor(images: np.ndarray, spec: dict) -> np.ndarray:
    """uint8 images to the float32 NCHW batch of the model.

    RGB models take (N, H, W, 3) BGR images, GRAY models (N, H, W).
    """
    x = images.astype(np.float32) * np.float32(spec["scale"])
    x = x[..., ::-1].transpose(0, 3, 1, 2) if spec["color"] == "RGB" else x[:, None, :, :]
    mean = np.array(spec["mean"], dtype=np.float32).reshape(1, -1, 1, 1)
    std = np.array(spec["std"], dtype=np.float32).reshape(1, -1, 1, 1)
    return np.ascontiguousarray((x - mean) / std)
