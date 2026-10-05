"""Per-frame disturbances: shake and motion blur synchronised to the press
cycle, a moving glare spot, day/night brightness and a passing occluder.

All parameters are generated up front as arrays (one entry per frame) and
stored in the ground truth, so any frame can be redrawn from them.
"""

from __future__ import annotations

from dataclasses import dataclass

import cv2
import numpy as np

from gauge_renderer.scenarios import PressCycle

# Per-frame columns written to the ground truth, in this order.
FRAME_COLUMNS = (
    "shake_dx", "shake_dy", "blur_len", "blur_angle", "brightness",
    "glare_x", "glare_y", "glare_intensity", "occ_x", "occ_y", "occ_w", "occ_h",
)  # fmt: skip


@dataclass(frozen=True)
class NoiseLevel:
    max_tilt_deg: float
    shake_px: tuple[float, float]
    glare_intensity: tuple[float, float]
    night_gain: tuple[float, float]
    occlusions_per_min: float
    crf: tuple[int, int]


LEVELS = {
    "none": NoiseLevel(0.0, (0.0, 0.0), (0.0, 0.0), (1.0, 1.0), 0.0, (18, 18)),
    "low": NoiseLevel(10.0, (0.5, 2.0), (30.0, 80.0), (0.75, 0.9), 0.5, (20, 24)),
    "medium": NoiseLevel(20.0, (2.0, 6.0), (60.0, 150.0), (0.5, 0.75), 1.5, (23, 28)),
    "high": NoiseLevel(30.0, (5.0, 12.0), (120.0, 220.0), (0.35, 0.55), 3.0, (27, 33)),
}
MAX_BLUR_PX = 15.0


@dataclass(frozen=True)
class NoiseProfile:
    """Per-station noise settings that stay constant over a clip."""

    level: str
    yaw_deg: float
    pitch_deg: float
    roll_deg: float
    shake_amplitude: float
    shake_freq_hz: float
    shake_decay_s: float
    shake_dir_deg: float
    exposure_s: float
    glare_radius: int
    glare_peak: float
    glare_period_s: tuple[float, float, float]
    glare_phase: tuple[float, float, float]
    night_gain: float
    day_period_s: float
    day_phase: float
    occluder_color: tuple[int, int, int]
    crf: int

    @classmethod
    def random(cls, level: str, rng: np.random.Generator) -> NoiseProfile:
        lv = LEVELS[level]
        tilt = lv.max_tilt_deg * np.sqrt(rng.random())
        tilt_dir = rng.uniform(0.0, 2.0 * np.pi)
        return cls(
            level=level,
            yaw_deg=float(tilt * np.cos(tilt_dir)),
            pitch_deg=float(tilt * np.sin(tilt_dir) * 0.6),
            roll_deg=float(rng.uniform(-2.0, 2.0)) if lv.max_tilt_deg > 0 else 0.0,
            shake_amplitude=float(rng.uniform(*lv.shake_px)),
            shake_freq_hz=float(rng.uniform(12.0, 25.0)),
            shake_decay_s=float(rng.uniform(0.08, 0.2)),
            shake_dir_deg=float(rng.uniform(60.0, 120.0)),
            exposure_s=float(rng.uniform(1.0 / 200.0, 1.0 / 50.0)),
            glare_radius=int(rng.integers(120, 261)),
            glare_peak=float(rng.uniform(*lv.glare_intensity)),
            glare_period_s=tuple(float(v) for v in rng.uniform(15.0, 60.0, 3)),
            glare_phase=tuple(float(v) for v in rng.uniform(0.0, 2.0 * np.pi, 3)),
            night_gain=float(rng.uniform(*lv.night_gain)),
            day_period_s=float(rng.uniform(240.0, 720.0)),
            day_phase=float(rng.uniform(0.0, 2.0 * np.pi)),
            occluder_color=tuple(int(v) for v in rng.integers(25, 80, 3)),
            crf=int(rng.integers(lv.crf[0], lv.crf[1] + 1)),
        )


@dataclass(frozen=True)
class FrameNoise:
    """Noise parameters of a single frame (one row of the ground truth)."""

    shake_dx: float = 0.0
    shake_dy: float = 0.0
    blur_len: float = 0.0
    blur_angle: float = 0.0
    brightness: float = 1.0
    glare_x: float = 0.0
    glare_y: float = 0.0
    glare_intensity: float = 0.0
    occ_x: float = float("nan")
    occ_y: float = float("nan")
    occ_w: float = float("nan")
    occ_h: float = float("nan")


def generate(
    profile: NoiseProfile,
    rng: np.random.Generator,
    t: np.ndarray,
    cycle: PressCycle,
    width: int,
    height: int,
) -> dict[str, np.ndarray]:
    """Generates every FRAME_COLUMNS array for the time axis t."""
    n = len(t)
    lv = LEVELS[profile.level]

    # Shake: a decaying oscillation kicked off by every press impact.
    since = cycle.since_impact(t)
    envelope = profile.shake_amplitude * np.exp(-since / profile.shake_decay_s)
    omega = 2.0 * np.pi * profile.shake_freq_hz
    displacement = envelope * np.sin(omega * since)
    velocity = envelope * (
        omega * np.cos(omega * since) - np.sin(omega * since) / profile.shake_decay_s
    )
    direction = np.radians(profile.shake_dir_deg)
    jitter = rng.normal(0.0, 0.08 * profile.shake_amplitude, (n, 2))
    shake_dx = displacement * np.cos(direction) + jitter[:, 0]
    shake_dy = displacement * np.sin(direction) + jitter[:, 1]
    blur_len = np.minimum(np.abs(velocity) * profile.exposure_s, MAX_BLUR_PX)
    blur_len = np.where(blur_len < 1.0, 0.0, blur_len)

    # Day/night: a slow oscillation between full light and the night level.
    day = 0.5 + 0.5 * np.sin(2.0 * np.pi * t / profile.day_period_s + profile.day_phase)
    brightness = profile.night_gain + (1.0 - profile.night_gain) * day

    # Glare: a spot wandering over the frame that fades in and out.
    px, py, pi_ = profile.glare_period_s
    fx, fy, fi = profile.glare_phase
    glare_x = width * (0.5 + 0.45 * np.sin(2.0 * np.pi * t / px + fx))
    glare_y = height * (0.5 + 0.45 * np.sin(2.0 * np.pi * t / py + fy))
    glare_intensity = profile.glare_peak * np.maximum(0.0, np.sin(2.0 * np.pi * t / pi_ + fi)) ** 2
    glare_intensity = np.where(glare_intensity < 1.0, 0.0, glare_intensity)

    # Occluder: someone walking past the cabinet now and then.
    occ = np.full((n, 4), np.nan)
    if lv.occlusions_per_min > 0 and n > 0:
        mean_gap = 60.0 / lv.occlusions_per_min
        cursor = float(t[0]) + rng.exponential(mean_gap)
        while cursor < t[-1]:
            duration = rng.uniform(1.5, 4.0)
            w, h = rng.uniform(180.0, 420.0), rng.uniform(500.0, 1100.0)
            cy = height - h / 2.0 + rng.uniform(0.0, 200.0)
            leftwards = rng.random() < 0.5
            mask = (t >= cursor) & (t < cursor + duration)
            progress = (t[mask] - cursor) / duration
            if leftwards:
                progress = 1.0 - progress
            occ[mask, 0] = -w / 2.0 + progress * (width + w)
            occ[mask, 1], occ[mask, 2], occ[mask, 3] = cy, w, h
            cursor += duration + rng.exponential(mean_gap)

    return {
        "shake_dx": shake_dx,
        "shake_dy": shake_dy,
        "blur_len": blur_len,
        "blur_angle": np.full(n, profile.shake_dir_deg),
        "brightness": brightness,
        "glare_x": glare_x,
        "glare_y": glare_y,
        "glare_intensity": glare_intensity,
        "occ_x": occ[:, 0],
        "occ_y": occ[:, 1],
        "occ_w": occ[:, 2],
        "occ_h": occ[:, 3],
    }


def glare_falloff(dist2: np.ndarray, radius: int) -> np.ndarray:
    """Glare strength (peak 1.0) at a squared distance from the spot centre.

    A Gaussian core multiplied by a window that reaches zero at the radius, so
    the spot has no visible edge.
    """
    ratio = np.clip(dist2 / float(radius) ** 2, 0.0, 1.0)
    return np.exp(-dist2 / (2.0 * (radius / 2.2) ** 2)) * (1.0 - ratio) ** 2


def glare_template(radius: int) -> np.ndarray:
    """Normalised falloff of the glare spot, float32, side 2r+1."""
    axis = np.arange(-radius, radius + 1, dtype=np.float64)
    dist2 = axis[None, :] ** 2 + axis[:, None] ** 2
    return glare_falloff(dist2, radius).astype(np.float32)


def add_glare(
    frame: np.ndarray, template: np.ndarray, x: float, y: float, intensity: float
) -> None:
    """Adds the glare spot in place, saturating at white."""
    if intensity <= 0.0:
        return
    radius = template.shape[0] // 2
    cx, cy = int(round(x)), int(round(y))
    h, w = frame.shape[:2]
    x0, x1 = max(0, cx - radius), min(w, cx + radius + 1)
    y0, y1 = max(0, cy - radius), min(h, cy + radius + 1)
    if x0 >= x1 or y0 >= y1:
        return
    part = template[
        y0 - (cy - radius) : y1 - (cy - radius), x0 - (cx - radius) : x1 - (cx - radius)
    ]
    spot = np.rint(part * intensity).astype(np.uint8)
    region = frame[y0:y1, x0:x1]
    cv2.add(region, cv2.merge([spot, spot, spot]), dst=region)


def motion_blur(frame: np.ndarray, length: float, angle_deg: float) -> np.ndarray:
    """Directional blur of the given length in pixels."""
    if length < 1.0:
        return frame
    size = int(np.ceil(length)) | 1
    size = max(size, 3)
    shift = 4
    canvas = np.zeros((size, size), np.uint8)
    centre = (size - 1) / 2.0
    dx = np.cos(np.radians(angle_deg)) * length / 2.0
    dy = np.sin(np.radians(angle_deg)) * length / 2.0
    p0 = (int(round((centre - dx) * (1 << shift))), int(round((centre - dy) * (1 << shift))))
    p1 = (int(round((centre + dx) * (1 << shift))), int(round((centre + dy) * (1 << shift))))
    cv2.line(canvas, p0, p1, 255, 1, cv2.LINE_AA, shift)
    kernel = canvas.astype(np.float32)
    kernel /= kernel.sum()
    return cv2.filter2D(frame, -1, kernel, borderType=cv2.BORDER_REPLICATE)


def draw_occluder(frame: np.ndarray, fn: FrameNoise, color: tuple[int, int, int]) -> None:
    if np.isnan(fn.occ_x):
        return
    centre = (int(round(fn.occ_x)), int(round(fn.occ_y)))
    axes = (int(round(fn.occ_w / 2.0)), int(round(fn.occ_h / 2.0)))
    shade = tuple(int(round(c * fn.brightness)) for c in color)
    cv2.ellipse(frame, centre, axes, 0, 0, 360, shade, -1, cv2.LINE_AA)


def occluded_fraction(roi: list[int], occ: dict[str, np.ndarray]) -> np.ndarray:
    """Share of a gauge ROI hidden by the occluder, per frame."""
    x, y, w, h = roi
    grid = (np.arange(7) + 0.5) / 7.0
    px = (x + w * grid)[None, :, None]
    py = (y + h * grid)[None, None, :]
    cx, cy = occ["occ_x"][:, None, None], occ["occ_y"][:, None, None]
    rx, ry = occ["occ_w"][:, None, None] / 2.0, occ["occ_h"][:, None, None] / 2.0
    with np.errstate(invalid="ignore"):
        inside = ((px - cx) / rx) ** 2 + ((py - cy) / ry) ** 2 <= 1.0
    return inside.mean(axis=(1, 2))


def glare_at(point: tuple[float, float], radius: int, noise: dict[str, np.ndarray]) -> np.ndarray:
    """Glare intensity (0-255 added to the image) at a frame position, per frame."""
    dist2 = (noise["glare_x"] - point[0]) ** 2 + (noise["glare_y"] - point[1]) ** 2
    return noise["glare_intensity"] * glare_falloff(dist2, radius)
