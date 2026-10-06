"""Analog dial gauge (pressure, temperature)."""

from __future__ import annotations

import cv2
import numpy as np

from gauge_renderer import scenarios
from gauge_renderer.gauges.base import Display, Gauge
from gauge_renderer.scenarios import PressCycle

# (min, max, unit) per quantity. Units stay ASCII so any font can draw them.
SCALES = {
    "pressure": [
        (0, 10, "bar"), (0, 16, "bar"), (0, 25, "bar"), (0, 100, "bar"),
        (0, 150, "bar"), (0, 250, "bar"), (0, 1.6, "MPa"), (0, 40, "MPa"),
    ],
    "temperature": [(0, 120, "degC"), (0, 150, "degC"), (0, 200, "degC")],
}  # fmt: skip

FONTS = [
    cv2.FONT_HERSHEY_SIMPLEX,
    cv2.FONT_HERSHEY_DUPLEX,
    cv2.FONT_HERSHEY_COMPLEX,
    cv2.FONT_HERSHEY_TRIPLEX,
]
NEEDLE_STYLES = ["line", "tapered", "arrow"]

# Fractions of the face radius.
TICK_RADIUS = 0.84
NEEDLE_LENGTH = 0.80
SUPERSAMPLE = 2
SHIFT = 4  # sub-pixel bits for the needle


def _polar(center: tuple[float, float], radius: float, angle_deg: float) -> tuple[float, float]:
    a = np.radians(angle_deg)
    return center[0] + radius * np.cos(a), center[1] + radius * np.sin(a)


def _fixed(points: list[tuple[float, float]]) -> np.ndarray:
    return np.rint(np.array(points) * (1 << SHIFT)).astype(np.int32)


class DialGauge(Gauge):
    type = "analog_dial"

    def __init__(self, gauge_id: str, quantity: str, rng: np.random.Generator) -> None:
        scale = SCALES[quantity][int(rng.integers(len(SCALES[quantity])))]
        super().__init__(gauge_id, scale[2])
        self.quantity = quantity
        self.min_val, self.max_val = float(scale[0]), float(scale[1])

        self.radius = int(rng.integers(110, 171))
        self.bezel = int(round(self.radius * rng.uniform(0.08, 0.16)))
        self.sweep_deg = float(rng.uniform(180.0, 320.0))
        self.sweep = "ccw" if rng.random() < 0.15 else "cw"
        # Only tick counts whose labels are short, round numbers.
        span = self.max_val - self.min_val
        nice = [n for n in range(5, 12) if len(f"{span / (n - 1):g}") <= 4]
        self.n_major = int(nice[int(rng.integers(len(nice)))])
        self.n_minor = int(rng.choice([1, 3, 4]))
        self.font = FONTS[int(rng.integers(len(FONTS)))]
        self.needle_style = NEEDLE_STYLES[int(rng.integers(len(NEEDLE_STYLES)))]
        self.dark_face = bool(rng.random() < 0.25)
        self.red_zone = bool(rng.random() < 0.5)
        if self.dark_face:
            self.face_color = tuple(int(c) for c in rng.integers(20, 45, 3))
            self.ink_color = (235, 235, 235)
            self.needle_color = [(60, 60, 235), (240, 240, 240), (40, 150, 250)][
                int(rng.integers(3))
            ]
        else:
            tint = int(rng.integers(0, 22))
            self.face_color = (238 - tint, 244 - tint // 2, 246)
            self.ink_color = (25, 25, 25)
            self.needle_color = [(40, 40, 220), (20, 20, 20), (30, 110, 240)][int(rng.integers(3))]
        grey = int(rng.integers(25, 150))
        self.bezel_color = (grey, grey, min(255, grey + int(rng.integers(0, 12))))

        side = 2 * (self.radius + self.bezel)
        self.size = (side, side)
        self.center = (side / 2.0, side / 2.0)
        r, c = self.radius, self.center
        # Square circumscribing the face circle (the bezel lies outside it).
        self.quad_local = np.array(
            [[c[0] - r, c[1] - r], [c[0] + r, c[1] - r], [c[0] + r, c[1] + r], [c[0] - r, c[1] + r]]
        )

        gap = 360.0 - self.sweep_deg
        # Angles are measured in image coordinates (y down), so a growing
        # angle turns clockwise on screen. The dead zone is centred at the bottom.
        if self.sweep == "cw":
            self.start_deg, self.direction = 90.0 + gap / 2.0, 1.0
        else:
            self.start_deg, self.direction = 90.0 - gap / 2.0, -1.0

        self._static, self.mask = self._draw_static()
        self._max_rate = 0.0
        # Operating limit; scenario anomalies go above it but stay on the scale.
        self.limit = self.min_val + 0.85 * (self.max_val - self.min_val)

    def angle_of(self, value: float) -> float:
        """Needle angle in degrees for a value, including a little overtravel."""
        frac = (value - self.min_val) / (self.max_val - self.min_val)
        frac = min(max(frac, -0.02), 1.02)
        return self.start_deg + self.direction * frac * self.sweep_deg

    def _draw_static(self) -> tuple[np.ndarray, np.ndarray]:
        ss = SUPERSAMPLE
        side = self.size[0] * ss
        c = (self.center[0] * ss, self.center[1] * ss)
        ci = (int(round(c[0])), int(round(c[1])))
        r = self.radius * ss
        img = np.zeros((side, side, 3), np.uint8)
        mask = np.zeros((side, side), np.uint8)
        outer = r + self.bezel * ss
        cv2.circle(mask, ci, outer, 255, -1, cv2.LINE_AA)
        cv2.circle(img, ci, outer, self.bezel_color, -1, cv2.LINE_AA)
        highlight = tuple(min(255, v + 45) for v in self.bezel_color)
        cv2.circle(img, ci, outer - ss, highlight, 2 * ss, cv2.LINE_AA)
        cv2.circle(img, ci, r, self.face_color, -1, cv2.LINE_AA)

        if self.red_zone:
            a0 = self.angle_of(self.min_val + 0.85 * (self.max_val - self.min_val))
            a1 = self.angle_of(self.max_val)
            arc_r = int(round(r * (TICK_RADIUS + 0.045)))
            cv2.ellipse(
                img, ci, (arc_r, arc_r), 0, min(a0, a1), max(a0, a1), (50, 50, 215),
                max(2, int(round(r * 0.05))), cv2.LINE_AA,
            )  # fmt: skip

        n_steps = (self.n_major - 1) * (self.n_minor + 1)
        for i in range(n_steps + 1):
            major = i % (self.n_minor + 1) == 0
            angle = self.start_deg + self.direction * self.sweep_deg * i / n_steps
            inner = r * (0.70 if major else 0.77)
            p0, p1 = _polar(c, r * TICK_RADIUS, angle), _polar(c, inner, angle)
            thickness = max(1, int(round(r * (0.022 if major else 0.010))))
            cv2.line(
                img, (int(round(p0[0])), int(round(p0[1]))), (int(round(p1[0])), int(round(p1[1]))),
                self.ink_color, thickness, cv2.LINE_AA,
            )  # fmt: skip

        font_scale = r / 330.0
        thickness = max(1, int(round(r / 110.0)))
        for i in range(self.n_major):
            value = self.min_val + (self.max_val - self.min_val) * i / (self.n_major - 1)
            angle = self.start_deg + self.direction * self.sweep_deg * i / (self.n_major - 1)
            self._put_centered(img, f"{value:g}", _polar(c, r * 0.54, angle), font_scale, thickness)
        self._put_centered(img, self.unit, (c[0], c[1] + r * 0.30), font_scale * 1.1, thickness)

        size = self.size
        return (
            cv2.resize(img, size, interpolation=cv2.INTER_AREA),
            cv2.resize(mask, size, interpolation=cv2.INTER_AREA),
        )

    def _put_centered(
        self, img: np.ndarray, text: str, pos: tuple[float, float], scale: float, thickness: int
    ) -> None:
        (w, h), _ = cv2.getTextSize(text, self.font, scale, thickness)
        org = (int(round(pos[0] - w / 2.0)), int(round(pos[1] + h / 2.0)))
        cv2.putText(img, text, org, self.font, scale, self.ink_color, thickness, cv2.LINE_AA)

    def render(self, value: float | None, text: str = "") -> np.ndarray:
        if value is None:
            return self._static
        img = self._static.copy()
        c, r = self.center, self.radius
        angle = self.angle_of(value)
        tip = _polar(c, r * NEEDLE_LENGTH, angle)
        tail = _polar(c, -r * 0.18, angle)
        left = _polar(c, r * 0.045, angle + 90.0)
        right = _polar(c, r * 0.045, angle - 90.0)
        color = self.needle_color
        if self.needle_style == "line":
            pts = _fixed([tail, tip])
            cv2.line(img, pts[0], pts[1], color, max(2, int(round(r * 0.03))), cv2.LINE_AA, SHIFT)
        elif self.needle_style == "tapered":
            cv2.fillConvexPoly(img, _fixed([left, tip, right, tail]), color, cv2.LINE_AA, SHIFT)
        else:
            pts = _fixed([tail, tip])
            cv2.line(img, pts[0], pts[1], color, max(1, int(round(r * 0.016))), cv2.LINE_AA, SHIFT)
            base = _polar(c, r * (NEEDLE_LENGTH - 0.14), angle)
            head = [_polar(base, r * 0.04, angle + 90.0), tip, _polar(base, r * 0.04, angle - 90.0)]
            cv2.fillConvexPoly(img, _fixed(head), color, cv2.LINE_AA, SHIFT)
            weight = _fixed([tail])[0]
            cv2.circle(
                img, weight, int(round(r * 0.05 * (1 << SHIFT))), color, -1, cv2.LINE_AA, SHIFT
            )
        hub = _fixed([c])[0]
        cv2.circle(
            img, hub, int(round(r * 0.075 * (1 << SHIFT))), (30, 30, 30), -1, cv2.LINE_AA, SHIFT
        )
        cv2.circle(
            img, hub, int(round(r * 0.030 * (1 << SHIFT))), (150, 150, 150), -1, cv2.LINE_AA, SHIFT
        )
        return img

    def simulate(
        self, t: np.ndarray, fps: float, rng: np.random.Generator, cycle: PressCycle
    ) -> Display:
        span = self.max_val - self.min_val
        if self.quantity == "pressure":
            low = self.min_val + span * rng.uniform(0.15, 0.30)
            peak = self.min_val + span * rng.uniform(0.55, 0.75)
            raw = scenarios.press_cycle(t, rng, cycle, low, peak)
        else:
            start = self.min_val + span * rng.uniform(0.12, 0.22)
            saturation = self.min_val + span * rng.uniform(0.45, 0.70)
            tau = max(20.0, float(t[-1] - t[0]) * rng.uniform(0.15, 0.40))
            raw = scenarios.saturating_rise(t, rng, start, saturation, tau)
        raw, anomalies = scenarios.apply_anomalies(
            t, raw, rng, (scenarios.ANOMALY_OVER_RANGE, scenarios.ANOMALY_FROZEN),
            over_value=self.min_val + 0.94 * span,
        )  # fmt: skip
        values = np.clip(raw, self.min_val, self.max_val)
        if len(values) > 1:
            self._max_rate = float(np.max(np.abs(np.diff(values))) * fps)
        n = len(t)
        return Display(values, [""] * n, [""] * n, anomalies)

    def calib(self, rect_size: int) -> dict:
        half = rect_size / 2.0
        center = (half, half)
        min_pt = _polar(center, half * TICK_RADIUS, self.angle_of(self.min_val))
        max_pt = _polar(center, half * TICK_RADIUS, self.angle_of(self.max_val))
        return {
            "center": [round(v, 2) for v in center],
            "min_pt": [round(v, 2) for v in min_pt],
            "max_pt": [round(v, 2) for v in max_pt],
            "min_val": self.min_val,
            "max_val": self.max_val,
            "sweep": self.sweep,
            "scale": "linear",
        }

    def rules(self) -> dict:
        span = self.max_val - self.min_val
        rate = self._max_rate * 1.5 if self._max_rate > 0 else span
        return {
            "min": self.min_val,
            "max": float(f"{self.limit:.3g}"),
            "max_rate_per_s": float(f"{rate:.2g}"),
            "deadband": float(f"{span * 0.003:.1g}"),
        }

    def describe(self) -> dict:
        return {
            "quantity": self.quantity,
            "radius": self.radius,
            "bezel": self.bezel,
            "sweep_deg": round(self.sweep_deg, 3),
            "sweep": self.sweep,
            "n_major": self.n_major,
            "n_minor": self.n_minor,
            "font": int(self.font),
            "needle_style": self.needle_style,
            "needle_length": NEEDLE_LENGTH,
            "dark_face": self.dark_face,
            "red_zone": self.red_zone,
        }
