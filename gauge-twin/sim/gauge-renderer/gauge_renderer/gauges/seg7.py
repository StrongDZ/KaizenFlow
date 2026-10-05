"""Seven-segment displays: LED/LCD panel meters and the MM:SS cycle timer."""

from __future__ import annotations

import cv2
import numpy as np

from gauge_renderer import scenarios
from gauge_renderer.gauges.base import Display, Gauge
from gauge_renderer.scenarios import PressCycle

SEGMENTS = {
    "0": "abcdef", "1": "bc", "2": "abdeg", "3": "abcdg", "4": "bcfg", "5": "acdfg",
    "6": "acdefg", "7": "abc", "8": "abcdefg", "9": "abcdfg", "_": "",
}  # fmt: skip
BLANK = "_"

# calib.color -> (background, lit segment, unlit segment) in BGR.
COLORS = {
    "red_led": ((14, 12, 16), (55, 50, 255), (22, 18, 48)),
    "green_led": ((14, 16, 12), (90, 255, 80), (24, 46, 22)),
    "lcd": ((150, 168, 160), (38, 44, 40), (142, 160, 152)),
}
SUPERSAMPLE = 3
NOMINAL_VOLTAGES = [100, 200, 220, 380, 400, 440]


class Seg7Gauge(Gauge):
    """Digits on equal-pitch cells; the quad is exactly the digit area."""

    def __init__(
        self, gauge_id: str, quantity: str, rng: np.random.Generator, color: str | None = None
    ) -> None:
        self.quantity = quantity
        self.colon_after = 0
        if quantity == "timer":
            unit, self.digits, self.decimal_pos, self.colon_after = "s", 4, 4, 2
            self.type = "timer_mmss"
        elif quantity == "voltage":
            unit, self.digits, self.decimal_pos = "V", 4, 3
            self.type = "seg7"
        else:
            unit, self.digits, self.decimal_pos = "A", 3, 2
            self.type = "seg7"
        super().__init__(gauge_id, unit)
        self.decimals = self.digits - self.decimal_pos

        names = list(COLORS)
        self.color = color or names[int(rng.integers(len(names)))]
        self.emissive = self.color != "lcd"
        self.cell_h = int(rng.integers(64, 105))
        self.cell_w = int(round(self.cell_h * rng.uniform(0.52, 0.62)))
        self.pad = int(round(self.cell_h * rng.uniform(0.14, 0.28)))
        self.slant = float(rng.uniform(0.0, 0.16))  # tan of the slant angle
        self.thickness = float(rng.uniform(0.15, 0.22))  # fraction of digit width
        self.seg_gap = float(rng.uniform(0.02, 0.06))  # fraction of digit width
        self.refresh_s = float(rng.uniform(0.25, 0.5))
        bg, lit, unlit = COLORS[self.color]
        jitter = rng.integers(-6, 7, 3)
        self.bg = tuple(int(np.clip(v + j, 0, 255)) for v, j in zip(bg, jitter, strict=True))
        self.lit, self.unlit = lit, unlit
        if self.color == "lcd":
            self.unlit = tuple(max(0, v - 7) for v in self.bg)
        frame = int(rng.integers(25, 60)) if self.emissive else int(rng.integers(150, 205))
        self.frame_color = (frame, frame, frame)

        area_w = self.cell_w * self.digits
        self.size = (area_w + 2 * self.pad, self.cell_h + 2 * self.pad)
        p = float(self.pad)
        self.quad_local = np.array(
            [[p, p], [p + area_w, p], [p + area_w, p + self.cell_h], [p, p + self.cell_h]]
        )
        self._cache: dict[str | None, np.ndarray] = {}
        self._limits: dict = {}

    # ------------------------------------------------------------ drawing --
    def _segment_polys(self, cell_x: float) -> dict[str, np.ndarray]:
        """Hexagonal segment outlines of one cell, in digit-area coordinates."""
        cw, ch = float(self.cell_w), float(self.cell_h)
        x0, x1 = cell_x + 0.19 * cw, cell_x + 0.81 * cw
        y0, y1 = 0.10 * ch, 0.90 * ch
        ym = (y0 + y1) / 2.0
        dw = x1 - x0
        th = dw * self.thickness
        h, g = th / 2.0, dw * self.seg_gap

        def horizontal(y: float) -> list[tuple[float, float]]:
            a, b = x0 + h + g, x1 - h - g
            return [(a, y), (a + h, y - h), (b - h, y - h), (b, y), (b - h, y + h), (a + h, y + h)]

        def vertical(x: float, top: float, bottom: float) -> list[tuple[float, float]]:
            a, b = top + g, bottom - g
            return [(x, a), (x + h, a + h), (x + h, b - h), (x, b), (x - h, b - h), (x - h, a + h)]

        polys = {
            "a": horizontal(y0 + h),
            "g": horizontal(ym),
            "d": horizontal(y1 - h),
            "f": vertical(x0 + h, y0 + h, ym),
            "b": vertical(x1 - h, y0 + h, ym),
            "e": vertical(x0 + h, ym, y1 - h),
            "c": vertical(x1 - h, ym, y1 - h),
        }
        # Shear around the cell's vertical centre so the slanted digit stays in its cell.
        return {
            k: np.array([(x + (ch / 2.0 - y) * self.slant, y) for x, y in pts])
            for k, pts in polys.items()
        }

    def _dot_radius(self) -> float:
        return 0.62 * self.cell_w * self.thickness * 0.62

    def _draw(self, text: str | None) -> np.ndarray:
        ss = SUPERSAMPLE
        area_w, ch = self.cell_w * self.digits, self.cell_h
        base = np.empty((ch * ss, area_w * ss, 3), np.uint8)
        base[:] = self.bg
        glow_src = np.zeros_like(base)

        def fill(poly: np.ndarray, color: tuple, canvas: np.ndarray) -> None:
            cv2.fillPoly(canvas, [np.rint(poly * ss).astype(np.int32)], color, cv2.LINE_AA)

        def dot(x: float, y: float, on: bool) -> None:
            centre = (int(round(x * ss)), int(round(y * ss)))
            radius = max(1, int(round(self._dot_radius() * ss)))
            cv2.circle(base, centre, radius, self.lit if on else self.unlit, -1, cv2.LINE_AA)
            if on:
                cv2.circle(glow_src, centre, radius, self.lit, -1, cv2.LINE_AA)

        chars = text if text is not None else BLANK * self.digits
        for i, char in enumerate(chars):
            polys = self._segment_polys(i * self.cell_w)
            for name, poly in polys.items():
                on = text is not None and name in SEGMENTS[char]
                fill(poly, self.lit if on else self.unlit, base)
                if on:
                    fill(poly, self.lit, glow_src)
        if self.decimals > 0:
            x = self.decimal_pos * self.cell_w - 0.09 * self.cell_w - 0.4 * ch * self.slant
            dot(x, 0.90 * ch - self._dot_radius(), text is not None)
        if self.colon_after:
            x = self.colon_after * self.cell_w
            for frac in (0.34, 0.66):
                dot(x + (0.5 - frac) * ch * self.slant, frac * ch, text is not None)

        area = cv2.resize(base, (area_w, ch), interpolation=cv2.INTER_AREA)
        if self.emissive and text is not None:
            glow = cv2.resize(glow_src, (area_w, ch), interpolation=cv2.INTER_AREA)
            glow = cv2.GaussianBlur(glow, (0, 0), self.cell_w * 0.09)
            area = cv2.addWeighted(area, 1.0, glow, 0.55, 0.0)

        patch = np.empty((self.size[1], self.size[0], 3), np.uint8)
        patch[:] = self.bg
        patch[self.pad : self.pad + ch, self.pad : self.pad + area_w] = area
        border = max(2, self.pad // 3)
        cv2.rectangle(patch, (0, 0), (self.size[0] - 1, self.size[1] - 1), self.frame_color, border)
        return patch

    def render(self, value: float | None, text: str = "") -> np.ndarray:
        key = None if value is None else text
        if key not in self._cache:
            if len(self._cache) > 512:
                self._cache.clear()
            self._cache[key] = self._draw(key)
        return self._cache[key]

    # --------------------------------------------------------- simulation --
    def format(self, value: float) -> str:
        """Slot characters for a value; leading zeros are blank on panel meters."""
        if self.quantity == "timer":
            total = int(value)
            return f"{min(total // 60, 99):02d}{total % 60:02d}"
        limit = 10**self.decimal_pos - 10**-self.decimals
        scaled = int(round(min(max(value, 0.0), limit) * 10**self.decimals))
        text = f"{scaled:0{self.decimals + 1}d}"
        return text.rjust(self.digits, BLANK)

    def simulate(
        self, t: np.ndarray, fps: float, rng: np.random.Generator, cycle: PressCycle
    ) -> Display:
        n = len(t)
        if self.quantity == "timer":
            raw = scenarios.count_and_reset(t, rng, 20.0, 90.0)
            raw, anomalies = scenarios.apply_anomalies(t, raw, rng, (scenarios.ANOMALY_FROZEN,))
            values = np.floor(raw)
        else:
            if self.quantity == "voltage":
                nominal = float(NOMINAL_VOLTAGES[int(rng.integers(len(NOMINAL_VOLTAGES)))])
                raw = scenarios.level_with_sags(
                    t, rng, nominal, nominal * 0.003, rng.uniform(0.05, 0.20)
                )
                limit, over = round(nominal * 1.1), nominal * 1.18
            else:
                idle, load = rng.uniform(2.0, 8.0), rng.uniform(15.0, 60.0)
                raw = scenarios.load_following(t, rng, cycle, idle, load)
                limit, over = round(load * 1.25), load * 1.45
            self._limits = {"min": 0.0, "max": float(limit)}
            raw, anomalies = scenarios.apply_anomalies(
                t,
                raw,
                rng,
                (scenarios.ANOMALY_OVER_RANGE, scenarios.ANOMALY_FROZEN),
                over_value=over,
            )
            # A panel meter refreshes a few times per second and holds in between.
            step = max(1, int(round(self.refresh_s * fps)))
            held = raw[(np.arange(n) // step) * step]
            top = 10**self.decimal_pos - 10**-self.decimals
            values = np.round(np.clip(held, 0.0, top), self.decimals)
        texts = [self.format(v) for v in values]
        return Display(values, texts, ["0" * self.digits] * n, anomalies)

    def calib(self, rect_size: int) -> dict:
        if self.quantity == "timer":
            return {"digits": self.digits, "colon_after": self.colon_after, "color": self.color}
        return {"digits": self.digits, "decimal_pos": self.decimal_pos, "color": self.color}

    def rules(self) -> dict:
        return dict(self._limits)

    def describe(self) -> dict:
        return {
            "quantity": self.quantity,
            "color": self.color,
            "cell_w": self.cell_w,
            "cell_h": self.cell_h,
            "pad": self.pad,
            "slant": round(self.slant, 4),
            "thickness": round(self.thickness, 4),
            "seg_gap": round(self.seg_gap, 4),
            "refresh_s": round(self.refresh_s, 4),
        }
