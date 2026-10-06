"""Dial samples: an unrectified crop around the gauge plus its 5 keypoints."""

from __future__ import annotations

from dataclasses import dataclass

import numpy as np

from gauge_ml import DIAL_INPUT, KP_TIP, geometry, preprocess
from gauge_ml.dataset.station import Frame, GaugeInfo


@dataclass(frozen=True)
class DialSample:
    image: np.ndarray  # (DIAL_INPUT, DIAL_INPUT, 3) BGR
    keypoints: np.ndarray  # (5, 2) in crop pixels
    visible: np.ndarray  # (5,) bool, False when hidden by the occluder
    crop: tuple[float, float, float, float]  # x0, y0, width, height of the crop in the frame
    value: float


def keypoints_in_frame(gauge: GaugeInfo, value: float, shake: tuple[float, float]) -> np.ndarray:
    """Ground-truth keypoints in frame pixels, including the camera shake of the frame."""
    needle_length = float(gauge.appearance.get("needle_length", 0.8))
    rect = geometry.dial_keypoints_rect(gauge.calib, value, needle_length, gauge.rect_size)
    to_frame = np.linalg.inv(geometry.quad_to_rect(gauge.quad, gauge.rect_size, gauge.rect_size))
    return geometry.transform_points(to_frame, rect) + np.array(shake)


def random_crop_box(roi: list[int], width: int, height: int, rng: np.random.Generator) -> tuple[int, int, int, int]:
    """The roi grown by a random margin on each side (2-20% of its size), clipped to the frame.

    Commissioning will never draw the same box twice, so the model must not
    rely on the gauge being centred or filling the crop.
    """
    x, y, w, h = roi
    left, right = rng.uniform(0.02, 0.20, 2) * w
    top, bottom = rng.uniform(0.02, 0.20, 2) * h
    x0, y0 = max(0, int(round(x - left))), max(0, int(round(y - top)))
    x1, y1 = min(width, int(round(x + w + right))), min(height, int(round(y + h + bottom)))
    return x0, y0, x1 - x0, y1 - y0


def _occluded(points: np.ndarray, row: dict) -> np.ndarray:
    """Which frame points lie under the occluder ellipse of this frame."""
    if row["occ_x"] is None or np.isnan(row["occ_x"]):
        return np.zeros(len(points), dtype=bool)
    dx = (points[:, 0] - row["occ_x"]) / (row["occ_w"] / 2.0)
    dy = (points[:, 1] - row["occ_y"]) / (row["occ_h"] / 2.0)
    return dx * dx + dy * dy <= 1.0


def make_sample(frame: Frame, gauge: GaugeInfo, rng: np.random.Generator) -> DialSample:
    row = frame.rows[gauge.gauge_id]
    points = keypoints_in_frame(gauge, row["value"], (row["shake_dx"], row["shake_dy"]))
    height, width = frame.image.shape[:2]
    x0, y0, w, h = random_crop_box(gauge.roi, width, height, rng)
    crop = preprocess.dial_crop(frame.image, (x0, y0, w, h))
    keypoints = (points - np.array([x0, y0])) * np.array([DIAL_INPUT / w, DIAL_INPUT / h])
    inside = (keypoints >= 0).all(axis=1) & (keypoints < DIAL_INPUT).all(axis=1)
    return DialSample(crop, keypoints, inside & ~_occluded(points, row), (x0, y0, w, h), float(row["value"]))


def read_value(
    keypoints_crop: np.ndarray,
    crop: tuple[float, float, float, float],
    gauge_quad: np.ndarray,
    rect_size: int,
    calib: dict,
    use_calib_center: bool = False,
) -> float:
    """Decodes a dial reading from predicted keypoints, the way edge-agent will.

    Keypoints go from crop pixels to frame pixels, through the quad homography
    into the rectified square, and the pivot-to-tip angle is interpolated
    between calib min_pt and max_pt.
    """
    x0, y0, w, h = crop
    frame_pts = keypoints_crop * np.array([w / DIAL_INPUT, h / DIAL_INPUT]) + np.array([x0, y0])
    rect = geometry.transform_points(geometry.quad_to_rect(gauge_quad, rect_size, rect_size), frame_pts)
    center = calib["center"] if use_calib_center else rect[0]
    return geometry.dial_value_from_points(center, rect[KP_TIP], calib)
