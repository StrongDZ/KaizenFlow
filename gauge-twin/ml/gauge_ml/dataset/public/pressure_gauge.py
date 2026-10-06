"""Kaggle "Pressure Gauge Reader Data" (juliusgrassme/pressure-gauge-reader-data,
CC BY-SA 4.0): videos of real pressure gauges at sewage pump stations of
Aalborg, from Gellaboina et al., "Reading circular analogue gauges using
digital image processing" (VISAPP 2019).

    data/public/pressure-gauge/man<1-7>cropclipscale.mp4   512x512, 29.97 fps, camera fixed

The dataset has no per-frame reading. Ground truth is built the way a
commissioning engineer would set up a station, plus a measurement that does
not involve the model:

* CALIB below is hand-made from one frame per video: the needle pivot, the
  radial band of the scale ticks, the values of the major ticks and a rough
  angle for the first and last of them.
* refine_majors() snaps every major tick to the darkest radial mark near its
  rough angle in a polar unwrap of the frame, so the scale is located to a
  fraction of a degree rather than by eye.
* measure_needle() finds the needle as the angle with the longest dark radial
  run between the hub and the ticks; the reading is the needle angle
  interpolated between the refined major ticks.

Frames where the needle measurement is ambiguous are skipped, and overlays of
the measurement are written for a human to check (see eval_public).
"""

from __future__ import annotations

from collections.abc import Iterator
from dataclasses import dataclass, replace
from pathlib import Path

import cv2
import numpy as np

# One sample every 0.5 s, the sample_fps of the edge.
SAMPLE_FPS = 2.0
# Polar resolution: angle bins per degree.
BINS_PER_DEG = 4


@dataclass(frozen=True)
class GaugeCalib:
    center: tuple[float, float]  # needle pivot, frame pixels
    tick_band: tuple[float, float]  # radii between which the major ticks are drawn
    values: tuple[float, ...]  # values of the major ticks, from min to max
    first_deg: float  # rough angle of the first major tick (image coordinates, y down)
    last_deg: float  # rough angle of the last one, larger than first_deg (clockwise)
    # Radii (as a fraction of tick_band[0]) between which the needle is searched:
    # beyond the counterweight and the hub, inside the scale.
    needle_band: tuple[float, float] = (0.45, 0.92)
    # Indices of major ticks hidden behind something (a cable); they are
    # placed from the other ticks instead of measured.
    hidden: tuple[int, ...] = ()


# Hand-made from the first frame of each video (512x512).
CALIB: dict[str, GaugeCalib] = {
    "man1": GaugeCalib((250, 246), (135, 158), (0, 1, 2, 3, 4, 5, 6), 133, 406),
    "man2": GaugeCalib((254, 252), (140, 165), (-1, 0, 1, 2, 3), 137, 408),
    "man3": GaugeCalib((258, 244), (150, 185), (0, 0.5, 1.0, 1.5, 2.0, 2.5), 140, 407),
    "man4": GaugeCalib((254, 268), (145, 180), (-1.0, -0.5, 0, 0.5, 1.0, 1.5), 143, 404),
    "man5": GaugeCalib((250, 275), (130, 165), (-1.0, -0.5, 0, 0.5, 1.0, 1.5), 152, 406, hidden=(5,)),
    "man6": GaugeCalib((258, 255), (150, 175), (-1, -0.5, 0, 0.5, 1, 1.5, 2, 2.5, 3), 137, 408),
    "man7": GaugeCalib((256, 255), (133, 157), (0, 1, 2, 3, 4, 5, 6), 133, 404),
}


def polar(gray: np.ndarray, center: tuple[float, float], max_radius: float) -> np.ndarray:
    """Darkness (255 - gray) unwrapped around center: rows are angle bins
    (0 deg = +x, growing clockwise on screen), columns are radii in pixels."""
    rows = 360 * BINS_PER_DEG
    unwrapped = cv2.warpPolar(
        gray, (int(max_radius), rows), center, max_radius, cv2.WARP_POLAR_LINEAR | cv2.INTER_LINEAR
    )
    return 255.0 - unwrapped.astype(np.float32)


def _profile(dark: np.ndarray, r0: float, r1: float) -> np.ndarray:
    """Darkness per angle bin in a radial band, with the ring background removed."""
    band = dark[:, int(r0) : int(r1)]
    band = band - np.median(band, axis=0, keepdims=True)
    return band.mean(axis=1)


def _bin(deg: float) -> int:
    return int(round((deg % 360.0) * BINS_PER_DEG)) % (360 * BINS_PER_DEG)


def refine_majors(gray: np.ndarray, calib: GaugeCalib, search_deg: float = 6.0) -> np.ndarray:
    """Angles (degrees, increasing clockwise from first_deg) of the major ticks."""
    dark = polar(gray, calib.center, calib.tick_band[1] + 5)
    profile = _profile(dark, *calib.tick_band)
    profile = np.convolve(np.r_[profile[-4:], profile, profile[:4]], np.ones(5) / 5, mode="same")[4:-4]
    n = len(calib.values)
    rough = np.linspace(calib.first_deg, calib.last_deg, n)
    refined = []
    for deg in rough:
        offsets = np.arange(-search_deg * BINS_PER_DEG, search_deg * BINS_PER_DEG + 1).astype(int)
        bins = (_bin(deg) + offsets) % len(profile)
        best = offsets[int(np.argmax(profile[bins]))]
        refined.append(deg + best / BINS_PER_DEG)
    return np.array(refined)


@dataclass(frozen=True)
class NeedleMeasure:
    angle_deg: float  # in [first_deg, first_deg + 360)
    score: float  # share of the searched radii that are dark along the needle
    runner_up: float  # best score at least 20 deg away from the needle


def measure_needle(gray: np.ndarray, calib: GaugeCalib) -> NeedleMeasure:
    """Needle direction: the angle along which the most radii, between the
    counterweight and the scale, are dark (a needle is a continuous dark ray;
    printed numbers cover only part of it)."""
    r0, r1 = (f * calib.tick_band[0] for f in calib.needle_band)
    dark = polar(gray, calib.center, r1 + 2)[:, int(r0) : int(r1)]
    # Dark relative to the face brightness at the same radius.
    threshold = np.percentile(dark, 60, axis=0, keepdims=True) + 40.0
    score = (dark > threshold).mean(axis=1)
    score = np.convolve(np.r_[score[-2:], score, score[:2]], np.ones(3) / 3, mode="same")[2:-2]
    best = int(np.argmax(score))
    # Sub-bin peak by a parabola through the three bins around the maximum.
    left, right = score[best - 1], score[(best + 1) % len(score)]
    denom = left - 2 * score[best] + right
    shift = 0.5 * (left - right) / denom if denom != 0 else 0.0
    angle = (best + shift) / BINS_PER_DEG
    far = np.abs(((np.arange(len(score)) - best + len(score) / 2) % len(score)) - len(score) / 2) > 20 * BINS_PER_DEG
    angle = calib.first_deg + (angle - calib.first_deg) % 360.0
    return NeedleMeasure(float(angle), float(score[best]), float(score[far].max()))


def needle_line(gray: np.ndarray, calib: GaugeCalib, angle_deg: float) -> tuple[np.ndarray, np.ndarray] | None:
    """Least-squares line (point, unit direction pointing to the tip) through
    the dark pixels of the needle, in a narrow wedge around angle_deg.

    The direction does not depend on how exactly calib.center was clicked."""
    r0, r1 = (f * calib.tick_band[0] for f in calib.needle_band)
    cx, cy = calib.center
    ys, xs = np.mgrid[0 : gray.shape[0], 0 : gray.shape[1]]
    dx, dy = xs - cx, ys - cy
    radius = np.hypot(dx, dy)
    off = (np.degrees(np.arctan2(dy, dx)) - angle_deg + 180.0) % 360.0 - 180.0
    wedge = (radius >= r0) & (radius <= r1) & (np.abs(off) <= 4.0)
    if not wedge.any():
        return None
    face = np.percentile(gray[wedge], 80)
    dark = wedge & (gray < face - 60)
    if dark.sum() < 20:
        return None
    points = np.column_stack([xs[dark], ys[dark]]).astype(np.float32)
    vx, vy, x0, y0 = cv2.fitLine(points, cv2.DIST_HUBER, 0, 0.01, 0.01).ravel()
    direction = np.array([vx, vy])
    tip = np.array([np.cos(np.radians(angle_deg)), np.sin(np.radians(angle_deg))])
    if direction @ tip < 0:
        direction = -direction
    return np.array([x0, y0]), direction


def intersect_lines(lines: list[tuple[np.ndarray, np.ndarray]]) -> np.ndarray:
    """Least-squares intersection point of 2-D lines (point, unit direction)."""
    a = np.zeros((2, 2))
    b = np.zeros(2)
    for point, direction in lines:
        normal_proj = np.eye(2) - np.outer(direction, direction)
        a += normal_proj
        b += normal_proj @ point
    return np.linalg.solve(a, b)


def refine_center(grays: list[np.ndarray], calib: GaugeCalib, max_shift: float = 12.0) -> tuple[float, float]:
    """The needle pivot as the intersection of the needle lines of several
    frames. Needs needle directions at least 20 deg apart; otherwise, or when
    the result moves more than max_shift pixels, the clicked center stays."""
    lines, angles = [], []
    for gray in grays:
        coarse = measure_needle(gray, calib)
        line = needle_line(gray, calib, coarse.angle_deg)
        if line is not None:
            lines.append(line)
            angles.append(coarse.angle_deg)
    if len(lines) < 3 or np.ptp(np.asarray(angles) % 360.0) < 20.0:
        return calib.center
    center = intersect_lines(lines)
    if np.hypot(*(center - np.array(calib.center))) > max_shift:
        return calib.center
    return float(center[0]), float(center[1])


def needle_angle(gray: np.ndarray, calib: GaugeCalib) -> tuple[float, NeedleMeasure]:
    """Needle angle from the fitted line (falls back to the polar peak)."""
    coarse = measure_needle(gray, calib)
    line = needle_line(gray, calib, coarse.angle_deg)
    if line is None:
        return coarse.angle_deg, coarse
    _, direction = line
    angle = float(np.degrees(np.arctan2(direction[1], direction[0])))
    return calib.first_deg + (angle - calib.first_deg) % 360.0, coarse


def value_at(angle_deg: float, majors_deg: np.ndarray, values: tuple[float, ...]) -> float:
    """Reading for a needle angle, piecewise linear between the major ticks.

    Angles in the dead zone below the first tick or beyond the last one are
    extrapolated with the neighbouring interval (the needle rests a little
    below zero on many gauges)."""
    v = np.asarray(values, dtype=np.float64)
    a = np.asarray(majors_deg, dtype=np.float64)
    if angle_deg > a[-1] + (360 - (a[-1] - a[0])) / 2:
        angle_deg -= 360.0
    if angle_deg < a[0]:
        return float(v[0] + (angle_deg - a[0]) * (v[1] - v[0]) / (a[1] - a[0]))
    if angle_deg > a[-1]:
        return float(v[-1] + (angle_deg - a[-1]) * (v[-1] - v[-2]) / (a[-1] - a[-2]))
    return float(np.interp(angle_deg, a, v))


def video_frames(path: Path, sample_fps: float = SAMPLE_FPS) -> Iterator[tuple[int, float, np.ndarray]]:
    """(frame index, time in s, BGR frame) every 1/sample_fps seconds."""
    capture = cv2.VideoCapture(str(path))
    fps = capture.get(cv2.CAP_PROP_FPS) or 30.0
    step = max(1, int(round(fps / sample_fps)))
    index = 0
    while True:
        ok, frame = capture.read()
        if not ok:
            break
        if index % step == 0:
            yield index, index / fps, frame
        index += 1
    capture.release()


# A needle is accepted as ground truth when it is dark along most of the
# searched radii and clearly ahead of any other direction.
MIN_SCORE = 0.6
MIN_MARGIN = 0.15


def load(root: Path) -> Iterator[tuple[np.ndarray, dict]]:
    """Yields (BGR frame, labels) for every sampled frame with a clear needle.

    labels: video, frame, value, full_scale (max - min), majors_deg, needle_deg,
    calib (GaugeCalib) and quad (the whole frame: the videos are already
    cropped to the gauge, so the roi is the frame).
    """
    for name, clicked in CALIB.items():
        path = root / f"{name}cropclipscale.mp4"
        if not path.exists():
            continue
        calib, majors = calibrate(path, clicked)
        for index, _, frame in video_frames(path):
            gray = cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY)
            angle, needle = needle_angle(gray, calib)
            if needle.score < MIN_SCORE or needle.score - needle.runner_up < MIN_MARGIN:
                continue
            yield (
                frame,
                {
                    "video": name,
                    "frame": index,
                    "value": value_at(angle, majors, calib.values),
                    "full_scale": float(calib.values[-1] - calib.values[0]),
                    "majors_deg": majors.tolist(),
                    "needle_deg": angle,
                    "calib": calib,
                },
            )


def calibrate(path: Path, clicked: GaugeCalib, samples: int = 40) -> tuple[GaugeCalib, np.ndarray]:
    """Commissioning of one video: pivot from the needle lines of up to
    `samples` frames spread over the video, then the major ticks around it."""
    frames = [cv2.cvtColor(f, cv2.COLOR_BGR2GRAY) for _, _, f in video_frames(path)]
    picked = frames[:: max(1, len(frames) // samples)]
    calib = replace(clicked, center=refine_center(picked, clicked))
    return calib, majors_over_frames(picked, calib)


def majors_over_frames(grays: list[np.ndarray], calib: GaugeCalib, clearance_deg: float = 10.0) -> np.ndarray:
    """Major tick angles as the median over several frames, ignoring a tick
    in the frames where the needle lies over it (the needle reaches the tick
    band and would pull the tick towards itself). A tick the needle covers in
    every frame, or one marked hidden, is placed by the median step from its
    nearest measured neighbour."""
    found: list[list[float]] = [[] for _ in calib.values]
    for gray in grays:
        needle, _ = needle_angle(gray, calib)
        for i, deg in enumerate(refine_majors(gray, calib)):
            if i not in calib.hidden and abs((deg - needle + 180.0) % 360.0 - 180.0) > clearance_deg:
                found[i].append(deg)
    majors = np.array([np.median(f) if f else np.nan for f in found])
    known = np.flatnonzero(~np.isnan(majors))
    if len(known) < 2:
        return refine_majors(grays[0], calib)
    step = np.median(np.diff(majors[known]) / np.diff(known))
    for i in np.flatnonzero(np.isnan(majors)):
        nearest = known[np.argmin(np.abs(known - i))]
        majors[i] = majors[nearest] + (i - nearest) * step
    return majors
