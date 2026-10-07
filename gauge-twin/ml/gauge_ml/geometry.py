"""Geometry shared by the dataset builder and the evaluation.

The dial formulas mirror the decoder edge-agent will use: a homography maps
the gauge quad onto the rectified square, where calib is defined.
"""

from __future__ import annotations

import cv2
import numpy as np

# Needle overtravel beyond the scale ends, as a fraction of the range.
OVERTRAVEL = 0.02


def transform_points(matrix: np.ndarray, points: np.ndarray) -> np.ndarray:
    """Applies a 3x3 homography to an (N, 2) array of points."""
    pts = np.asarray(points, dtype=np.float64).reshape(-1, 1, 2)
    return cv2.perspectiveTransform(pts, np.asarray(matrix, dtype=np.float64)).reshape(-1, 2)


def quad_to_rect(quad: np.ndarray, width: float, height: float) -> np.ndarray:
    """Homography mapping a frame quad (TL, TR, BR, BL) onto a width x height rectangle."""
    dst = np.array([[0, 0], [width, 0], [width, height], [0, height]], dtype=np.float32)
    return cv2.getPerspectiveTransform(np.asarray(quad, dtype=np.float32), dst).astype(np.float64)


def _angle(center, point) -> float:
    return float(np.degrees(np.arctan2(point[1] - center[1], point[0] - center[0])))


def _span(calib: dict) -> tuple[float, float, float]:
    """Start angle, signed direction and angular span of the scale, in degrees."""
    a_min = _angle(calib["center"], calib["min_pt"])
    a_max = _angle(calib["center"], calib["max_pt"])
    if calib["sweep"] == "cw":
        return a_min, 1.0, (a_max - a_min) % 360.0 or 360.0
    return a_min, -1.0, (a_min - a_max) % 360.0 or 360.0


def dial_value_from_angle(angle_deg: float, calib: dict) -> float:
    """Needle angle (image coordinates, y down) to value, in the rectified square.

    As in edge/decode (DialCalib.Value): a needle in the dead zone reads
    beyond the nearer end of the scale, below min_val or above max_val.
    """
    a_min, direction, span = _span(calib)
    travelled = (direction * (angle_deg - a_min)) % 360.0
    # First half of the dead zone: past max. Second half: below min.
    if travelled - span >= (360.0 - span) / 2.0:
        travelled -= 360.0
    return calib["min_val"] + (calib["max_val"] - calib["min_val"]) * travelled / span


def dial_value_from_points(center, tip, calib: dict) -> float:
    """Reads a dial from the needle pivot and tip, both in the rectified square."""
    return dial_value_from_angle(_angle(center, tip), calib)


def dial_keypoints_rect(calib: dict, value: float, needle_length: float, rect_size: int) -> np.ndarray:
    """Ground-truth keypoints (center, start, end, mid, tip) in the rectified square.

    needle_length is the tip distance from the pivot as a fraction of the face
    radius; the face fills the rectified square.
    """
    center = np.array(calib["center"], dtype=np.float64)
    a_min, direction, span = _span(calib)
    tick_radius = float(np.hypot(*(np.array(calib["min_pt"]) - center)))

    def at(angle_deg: float, radius: float) -> np.ndarray:
        a = np.radians(angle_deg)
        return center + radius * np.array([np.cos(a), np.sin(a)])

    frac = (value - calib["min_val"]) / (calib["max_val"] - calib["min_val"])
    frac = min(max(frac, -OVERTRAVEL), 1.0 + OVERTRAVEL)
    return np.stack(
        [
            center,
            np.array(calib["min_pt"], dtype=np.float64),
            np.array(calib["max_pt"], dtype=np.float64),
            at(a_min + direction * 0.5 * span, tick_radius),
            at(a_min + direction * frac * span, needle_length * rect_size / 2.0),
        ]
    )
