"""Input preprocessing of both models, defined once.

The dataset builder applies these functions, export.py writes the same
parameters to preprocess.json next to each ONNX file, and every inference
pipeline (ds-sim, the generated nvdspreprocess config) must read that file
instead of hard-coding its own values. A mismatch here is the classic reason
for a model that works in Python and fails on TensorRT.
"""

from __future__ import annotations

import cv2
import numpy as np

from gauge_ml import DIAL_INPUT, DIGIT_H, DIGIT_W

INTERPOLATION = {"area": cv2.INTER_AREA, "linear": cv2.INTER_LINEAR, "nearest": cv2.INTER_NEAREST}

DIAL = {
    "model": "dial_pose",
    "source": "roi_crop",  # the gauge roi cropped from the frame, not rectified
    "input": {"name": "crops", "layout": "NCHW", "dtype": "float32", "width": DIAL_INPUT, "height": DIAL_INPUT},
    "color": "RGB",
    # The crop is stretched to the input size; the aspect ratio is not kept.
    "resize": {"mode": "stretch", "interpolation": "area"},
    "scale": 1.0 / 255.0,
    # ImageNet mean/std are applied inside the ONNX graph, not by the pipeline.
    "mean": [0.0, 0.0, 0.0],
    "std": [1.0, 1.0, 1.0],
}

DIGIT = {
    "model": "digit_cls",
    # The gauge quad is warped onto a strip of (digits * width) x height
    # pixels, which is then cut into `digits` equal slots, left to right.
    "source": "quad_warp_slots",
    "input": {"name": "slots", "layout": "NCHW", "dtype": "float32", "width": DIGIT_W, "height": DIGIT_H},
    "color": "GRAY",
    # Luma weights for B, G, R (ITU-R BT.601, what OpenCV uses).
    "gray_weights_bgr": [0.114, 0.587, 0.299],
    "resize": {"mode": "perspective_warp", "interpolation": "linear"},
    "scale": 1.0 / 255.0,
    "mean": [0.0],
    "std": [1.0],
}

SPECS = {"dial": DIAL, "digit": DIGIT}


def dial_crop(frame: np.ndarray, box: tuple[int, int, int, int], spec: dict = DIAL) -> np.ndarray:
    """Crops box (x, y, w, h) from a BGR frame and resizes it to the model input; still BGR uint8."""
    x, y, w, h = box
    size = (spec["input"]["width"], spec["input"]["height"])
    return cv2.resize(frame[y : y + h, x : x + w], size, interpolation=INTERPOLATION[spec["resize"]["interpolation"]])


def digit_slots(frame: np.ndarray, quad: np.ndarray, digits: int, spec: dict = DIGIT) -> np.ndarray:
    """Warps the quad (TL, TR, BR, BL) and returns its slots as (digits, H, W) uint8 grayscale."""
    width, height = spec["input"]["width"], spec["input"]["height"]
    dst = np.array([[0, 0], [digits * width, 0], [digits * width, height], [0, height]], dtype=np.float32)
    matrix = cv2.getPerspectiveTransform(np.asarray(quad, dtype=np.float32), dst)
    strip = cv2.warpPerspective(
        frame, matrix, (digits * width, height), flags=INTERPOLATION[spec["resize"]["interpolation"]]
    )
    gray = cv2.cvtColor(strip, cv2.COLOR_BGR2GRAY)
    return np.stack([gray[:, i * width : (i + 1) * width] for i in range(digits)])


def to_tensor(images: np.ndarray, spec: dict) -> np.ndarray:
    """uint8 images to the float32 NCHW batch the ONNX model expects.

    Dial: (N, H, W, 3) BGR. Digit: (N, H, W) grayscale.
    """
    x = images.astype(np.float32) * np.float32(spec["scale"])
    if spec["color"] == "RGB":
        x = x[..., ::-1].transpose(0, 3, 1, 2)
    else:
        x = x[:, None, :, :]
    mean = np.array(spec["mean"], dtype=np.float32).reshape(1, -1, 1, 1)
    std = np.array(spec["std"], dtype=np.float32).reshape(1, -1, 1, 1)
    return np.ascontiguousarray((x - mean) / std)
