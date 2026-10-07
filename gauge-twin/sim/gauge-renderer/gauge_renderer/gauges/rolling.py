"""Mechanical rolling counter (hour meter)."""

from __future__ import annotations

import cv2
import numpy as np
from PIL import Image, ImageDraw, ImageFont

from gauge_renderer import scenarios
from gauge_renderer.gauges.base import Display, Gauge
from gauge_renderer.scenarios import PressCycle

# "pillow" uses Pillow's built-in scalable font; the others are OpenCV fonts.
FONTS = ["pillow", cv2.FONT_HERSHEY_SIMPLEX, cv2.FONT_HERSHEY_DUPLEX, cv2.FONT_HERSHEY_TRIPLEX]
# A wheel counts as "in transition" while it is this far from a rest position.
TRANSITION_MARGIN = 0.08


class RollingCounterGauge(Gauge):
    """Odometer-style wheels on equal-pitch cells; the quad is the digit window."""

    type = "rolling_counter"

    def __init__(self, gauge_id: str, rng: np.random.Generator) -> None:
        super().__init__(gauge_id, "h")
        self.digits = int(rng.integers(5, 8))
        self.decimal_digits = 1
        self.cell_h = int(rng.integers(58, 92))
        self.cell_w = int(round(self.cell_h * rng.uniform(0.60, 0.72)))
        self.pad = int(round(self.cell_h * rng.uniform(0.18, 0.35)))
        self.font = FONTS[int(rng.integers(len(FONTS)))]
        self.white_wheels = bool(rng.random() < 0.3)
        self.decimal_style = ["inverted", "red"][int(rng.integers(2))]
        housing = int(rng.integers(20, 70))
        self.housing_color = (housing, housing, housing)
        # 0.1 h every few seconds of video so that transitions are visible.
        self.rate_per_s = 0.1 / float(rng.uniform(4.0, 12.0))
        integer_digits = self.digits - self.decimal_digits
        self.start_value = float(rng.integers(10, 5 * 10 ** (integer_digits - 1)))
        if rng.random() < 0.5:
            # Start just below a multi-wheel carry.
            self.start_value = np.floor(self.start_value / 10.0) * 10.0 + 9.0
        self.start_value += float(rng.uniform(0.0, 0.9))

        area_w = self.cell_w * self.digits
        self.size = (area_w + 2 * self.pad, self.cell_h + 2 * self.pad)
        p = float(self.pad)
        self.quad_local = np.array(
            [[p, p], [p + area_w, p], [p + area_w, p + self.cell_h], [p, p + self.cell_h]]
        )
        self._strips = [self._make_strip(i >= integer_digits) for i in range(self.digits)]
        # Cylindrical shading: wheels get darker towards the top and bottom edges.
        rows = (np.arange(self.cell_h) + 0.5) / self.cell_h
        self._shade = (0.45 + 0.55 * np.sin(np.pi * rows) ** 0.6).astype(np.float32)[:, None, None]
        self._housing = np.empty((self.size[1], self.size[0], 3), np.uint8)
        self._housing[:] = self.housing_color
        edge = tuple(min(255, v + 50) for v in self.housing_color)
        cv2.rectangle(self._housing, (0, 0), (self.size[0] - 1, self.size[1] - 1), edge, 2)

    def _wheel_colors(self, decimal: bool) -> tuple[tuple, tuple]:
        dark, light = (22, 22, 22), (232, 232, 232)
        bg, fg = (light, dark) if self.white_wheels else (dark, light)
        if decimal and self.decimal_style == "inverted":
            bg, fg = fg, bg
        elif decimal:
            fg = (50, 50, 215) if self.white_wheels else (70, 70, 240)
        return bg, fg

    def _make_strip(self, decimal: bool) -> np.ndarray:
        """Digits 0-9 followed by 0 again, stacked top to bottom."""
        bg, fg = self._wheel_colors(decimal)
        cw, ch = self.cell_w, self.cell_h
        strip = np.empty((11 * ch, cw, 3), np.uint8)
        strip[:] = bg
        for i in range(11):
            digit = str(i % 10)
            cell = strip[i * ch : (i + 1) * ch]
            if self.font == "pillow":
                image = Image.new("RGB", (cw, ch), bg[::-1])
                font = ImageFont.load_default(size=int(ch * 0.78))
                ImageDraw.Draw(image).text(
                    (cw / 2.0, ch / 2.0), digit, fill=fg[::-1], font=font, anchor="mm"
                )
                cell[:] = np.asarray(image)[:, :, ::-1]
            else:
                scale = ch * 0.66 / 22.0
                thickness = max(1, int(round(ch / 22.0)))
                (w, h), _ = cv2.getTextSize(digit, self.font, scale, thickness)
                org = (int(round((cw - w) / 2.0)), int(round((ch + h) / 2.0)))
                cv2.putText(cell, digit, org, self.font, scale, fg, thickness, cv2.LINE_AA)
        return strip

    def wheel_offsets(self, value: float) -> list[int]:
        """Pixel offset into each wheel strip, most significant wheel first.

        The last wheel turns continuously; every other wheel only advances
        while the wheel to its right moves from 9 to 0.
        """
        scaled = value * 10**self.decimal_digits
        positions = []
        lower = scaled % 10.0
        positions.append(lower)
        for i in range(1, self.digits):
            digit = np.floor(scaled / 10.0**i) % 10.0
            lower = digit + max(0.0, lower - 9.0)
            positions.append(lower)
        period = 10 * self.cell_h
        return [int(round(p * self.cell_h)) % period for p in reversed(positions)]

    def read(self, value: float) -> tuple[str, str]:
        """Slot digits (the lower digit while rolling) and the transition mask."""
        text, mask = "", ""
        for offset in self.wheel_offsets(value):
            position = offset / self.cell_h
            fraction = position - np.floor(position)
            text += str(int(np.floor(position)) % 10)
            mask += "1" if TRANSITION_MARGIN < fraction < 1.0 - TRANSITION_MARGIN else "0"
        return text, mask

    def render(self, value: float | None, text: str = "") -> np.ndarray:
        patch = self._housing.copy()
        cw, ch, p = self.cell_w, self.cell_h, self.pad
        window = patch[p : p + ch, p : p + cw * self.digits]
        if value is None:
            window[:] = (0, 0, 0)
            return patch
        for i, offset in enumerate(self.wheel_offsets(value)):
            window[:, i * cw : (i + 1) * cw] = self._strips[i][offset : offset + ch]
        window[:] = np.rint(window.astype(np.float32) * self._shade).astype(np.uint8)
        for i in range(self.digits + 1):
            # Gaps between wheels, drawn on the cell borders so the pitch stays even.
            x = min(max(i * cw, 1), cw * self.digits - 1)
            cv2.line(window, (x, 0), (x, ch - 1), (8, 8, 8), 2)
        return patch

    def simulate(
        self, t: np.ndarray, fps: float, rng: np.random.Generator, cycle: PressCycle
    ) -> Display:
        values = scenarios.monotonic_counter(t, self.start_value, self.rate_per_s)
        read = [self.read(float(v)) for v in values]
        anomalies = np.full(len(t), scenarios.ANOMALY_NONE, dtype=object)
        return Display(values, [r[0] for r in read], [r[1] for r in read], anomalies)

    def calib(self, rect_size: int) -> dict:
        return {"digits": self.digits, "decimal_digits": self.decimal_digits}

    def rules(self) -> dict:
        return {"monotonic": True, "report_interval_s": 300}

    def describe(self) -> dict:
        return {
            "digits": self.digits,
            "cell_w": self.cell_w,
            "cell_h": self.cell_h,
            "pad": self.pad,
            "font": self.font if self.font == "pillow" else int(self.font),
            "white_wheels": self.white_wheels,
            "decimal_style": self.decimal_style,
            "rate_per_s": round(self.rate_per_s, 6),
            "start_value": round(self.start_value, 4),
        }
