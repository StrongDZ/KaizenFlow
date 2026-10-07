"""Geometry helpers shared by the renderer and its tests."""

from __future__ import annotations

import cv2
import numpy as np

DEFAULT_RECT_SIZE = 256


def transform_points(matrix: np.ndarray, points: np.ndarray) -> np.ndarray:
    """Applies a 3x3 homography to an (N, 2) array of points."""
    pts = np.asarray(points, dtype=np.float64).reshape(-1, 1, 2)
    return cv2.perspectiveTransform(pts, np.asarray(matrix, dtype=np.float64)).reshape(-1, 2)


def rect_corners(x: float, y: float, w: float, h: float) -> np.ndarray:
    """Corners of an axis-aligned rectangle ordered TL, TR, BR, BL."""
    return np.array([[x, y], [x + w, y], [x + w, y + h], [x, y + h]], dtype=np.float64)


def quad_to_rect_homography(quad: np.ndarray, rect_size: int = DEFAULT_RECT_SIZE) -> np.ndarray:
    """Homography mapping a frame quad (TL, TR, BR, BL) onto the rectified square."""
    dst = rect_corners(0, 0, rect_size, rect_size)
    return cv2.getPerspectiveTransform(
        np.asarray(quad, dtype=np.float32), dst.astype(np.float32)
    ).astype(np.float64)


def bounding_roi(quad: np.ndarray, width: int, height: int, pad: int = 4) -> list[int]:
    """Axis-aligned [x, y, w, h] box around a quad, clipped to the frame."""
    x0 = max(0, int(np.floor(quad[:, 0].min())) - pad)
    y0 = max(0, int(np.floor(quad[:, 1].min())) - pad)
    x1 = min(width, int(np.ceil(quad[:, 0].max())) + pad)
    y1 = min(height, int(np.ceil(quad[:, 1].max())) + pad)
    return [x0, y0, x1 - x0, y1 - y0]


def tilt_homography(
    width: int, height: int, yaw_deg: float, pitch_deg: float, roll_deg: float
) -> np.ndarray:
    """Homography of a flat panel seen by a camera tilted by the given angles.

    The panel fills the frame when all angles are zero. The result is zoomed in
    just enough for the tilted panel to still cover the whole frame.
    """
    yaw, pitch, roll = np.radians([yaw_deg, pitch_deg, roll_deg])
    ry = np.array([[np.cos(yaw), 0, np.sin(yaw)], [0, 1, 0], [-np.sin(yaw), 0, np.cos(yaw)]])
    rx = np.array(
        [[1, 0, 0], [0, np.cos(pitch), -np.sin(pitch)], [0, np.sin(pitch), np.cos(pitch)]]
    )
    rz = np.array([[np.cos(roll), -np.sin(roll), 0], [np.sin(roll), np.cos(roll), 0], [0, 0, 1]])
    rotation = rz @ rx @ ry

    focal = 1.2 * width
    centre = np.array([width / 2.0, height / 2.0])
    corners = rect_corners(0, 0, width, height)
    centred = np.column_stack([corners - centre, np.zeros(4)])
    rotated = centred @ rotation.T
    projected = focal * rotated[:, :2] / (rotated[:, 2:3] + focal) + centre
    base = cv2.getPerspectiveTransform(corners.astype(np.float32), projected.astype(np.float32))
    base = base.astype(np.float64)

    zoom = 1.0
    for _ in range(200):
        scale = np.array(
            [[zoom, 0, centre[0] * (1 - zoom)], [0, zoom, centre[1] * (1 - zoom)], [0, 0, 1]]
        )
        matrix = scale @ base
        back = transform_points(np.linalg.inv(matrix), corners)
        inside = (
            (back[:, 0] >= 0) & (back[:, 0] <= width) & (back[:, 1] >= 0) & (back[:, 1] <= height)
        )
        if inside.all():
            return matrix
        zoom += 0.01
    return matrix


def dial_value_from_angle(
    angle_deg: float,
    center: tuple[float, float],
    min_pt: tuple[float, float],
    max_pt: tuple[float, float],
    min_val: float,
    max_val: float,
    sweep: str,
) -> float:
    """Reference decoder: needle angle (image coordinates, y down) to value.

    The scale runs from min_pt to max_pt around center, clockwise on screen for
    sweep "cw" and counter-clockwise for "ccw".
    """
    a_min = np.degrees(np.arctan2(min_pt[1] - center[1], min_pt[0] - center[0]))
    a_max = np.degrees(np.arctan2(max_pt[1] - center[1], max_pt[0] - center[0]))
    if sweep == "cw":
        span = (a_max - a_min) % 360.0 or 360.0
        travelled = (angle_deg - a_min) % 360.0
    else:
        span = (a_min - a_max) % 360.0 or 360.0
        travelled = (a_min - angle_deg) % 360.0
    # Angles in the dead zone snap to the nearest end of the scale.
    if travelled > span:
        travelled = span if travelled - span < (360.0 - span) / 2.0 else 0.0
    return min_val + (max_val - min_val) * travelled / span
