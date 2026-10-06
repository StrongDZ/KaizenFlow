"""A station: 3-5 gauges on a cabinet panel seen by one camera."""

from __future__ import annotations

import cv2
import numpy as np

from gauge_renderer import background, geometry, noise
from gauge_renderer.gauges import DialGauge, Gauge, RollingCounterGauge, Seg7Gauge
from gauge_renderer.geometry import DEFAULT_RECT_SIZE
from gauge_renderer.noise import FrameNoise, NoiseProfile
from gauge_renderer.scenarios import PressCycle

FRAME_WIDTH, FRAME_HEIGHT = 1920, 1080
# The five instruments of the spec, mapped onto the four display types.
QUANTITIES = ("pressure", "temperature", "electrical", "timer", "hour_meter")
LABEL_HEIGHT = 46
PLACEMENT_GAP = 28
FRAME_MARGIN = 30

# Sub-streams of the station RNG; keeping them separate means a change in one
# aspect (say, noise) never shifts the random draws of another.
STREAM_PROFILE, STREAM_GAUGES, STREAM_LAYOUT, STREAM_PANEL, STREAM_VALUES, STREAM_NOISE = range(6)


def station_rng(seed: int, index: int, stream: int, *extra: int) -> np.random.Generator:
    return np.random.default_rng([seed, index, stream, *extra])


def machine_id(index: int) -> str:
    return f"machine_{index + 1:03d}"


def _make_gauge(quantity: str, rng: np.random.Generator) -> Gauge:
    if quantity == "pressure":
        return DialGauge("MAIN_PRESSURE", "pressure", rng)
    if quantity == "temperature":
        return DialGauge("OIL_TEMP", "temperature", rng)
    if quantity == "electrical":
        if rng.random() < 0.6:
            return Seg7Gauge("VOLTMETER", "voltage", rng)
        return Seg7Gauge("AMMETER", "current", rng)
    if quantity == "timer":
        return Seg7Gauge("CYCLE_TIMER", "timer", rng)
    return RollingCounterGauge("TOTAL_HOUR_METER", rng)


class Station:
    """Static description of a station, fully determined by (seed, index, noise level).

    Building a Station is deterministic and independent of clip length and
    frame rate, which is what lets any frame be redrawn from the ground truth.
    """

    def __init__(
        self,
        seed: int,
        index: int,
        noise_level: str = "medium",
        width: int = FRAME_WIDTH,
        height: int = FRAME_HEIGHT,
    ) -> None:
        self.seed, self.index, self.noise_level = seed, index, noise_level
        self.width, self.height = width, height
        self.machine_id = machine_id(index)

        prof_rng = station_rng(seed, index, STREAM_PROFILE)
        self.profile = NoiseProfile.random(noise_level, prof_rng)
        self.cycle = PressCycle(
            float(prof_rng.uniform(1.5, 4.0)), float(prof_rng.uniform(0.0, 1.5))
        )
        self.homography = geometry.tilt_homography(
            width, height, self.profile.yaw_deg, self.profile.pitch_deg, self.profile.roll_deg
        )

        pick_rng = station_rng(seed, index, STREAM_GAUGES)
        count = int(pick_rng.integers(3, 6))
        chosen = sorted(int(i) for i in pick_rng.choice(len(QUANTITIES), count, replace=False))
        self.gauges: list[Gauge] = [
            _make_gauge(QUANTITIES[q], station_rng(seed, index, STREAM_GAUGES, q)) for q in chosen
        ]
        self.positions = self._layout()

        panel_rng = station_rng(seed, index, STREAM_PANEL)
        self.background = background.make_panel(panel_rng, width, height)
        self._decorate(panel_rng)

        self.quads = [
            geometry.transform_points(
                self.homography, g.quad_local + np.array(pos, dtype=np.float64)
            )
            for g, pos in zip(self.gauges, self.positions, strict=True)
        ]
        self.rois = [geometry.bounding_roi(q, width, height) for q in self.quads]
        self._masks = [
            None if g.mask is None else (g.mask > 127).astype(np.uint8) for g in self.gauges
        ]
        self._glare = noise.glare_template(self.profile.glare_radius)

    # -------------------------------------------------------------- layout --
    def _visible(self, x: float, y: float, w: float, h: float) -> bool:
        """True if a panel rectangle lands fully inside the frame after the warp."""
        corners = geometry.rect_corners(
            x - PLACEMENT_GAP, y - PLACEMENT_GAP, w + 2 * PLACEMENT_GAP, h + 2 * PLACEMENT_GAP
        )
        warped = geometry.transform_points(self.homography, corners)
        return bool(
            (warped[:, 0] >= FRAME_MARGIN).all()
            and (warped[:, 0] <= self.width - FRAME_MARGIN).all()
            and (warped[:, 1] >= FRAME_MARGIN).all()
            and (warped[:, 1] <= self.height - FRAME_MARGIN).all()
        )

    def _layout(self) -> list[tuple[int, int]]:
        """Places the gauge patches on the panel without overlap (rejection sampling)."""
        for attempt in range(200):
            rng = station_rng(self.seed, self.index, STREAM_LAYOUT, attempt)
            placed: list[tuple[int, int, int, int]] = []
            for gauge in self.gauges:
                w, h = gauge.size[0], gauge.size[1] + LABEL_HEIGHT
                for _ in range(300):
                    x = int(rng.integers(0, self.width - w))
                    y = int(rng.integers(0, self.height - h))
                    clear = all(
                        x + w + PLACEMENT_GAP <= px
                        or px + pw + PLACEMENT_GAP <= x
                        or y + h + PLACEMENT_GAP <= py
                        or py + ph + PLACEMENT_GAP <= y
                        for px, py, pw, ph in placed
                    )
                    if clear and self._visible(x, y, w, h):
                        placed.append((x, y, w, h))
                        break
                else:
                    break
            if len(placed) == len(self.gauges):
                return [(x, y) for x, y, _, _ in placed]
        raise RuntimeError(f"could not lay out station {self.index} (seed {self.seed})")

    def _decorate(self, rng: np.random.Generator) -> None:
        occupied = []
        for gauge, (x, y) in zip(self.gauges, self.positions, strict=True):
            w, h = gauge.size
            dark = bool(rng.random() < 0.5)
            background.draw_label(self.background, gauge.gauge_id, x + w // 2, y + h + 10, dark)
            occupied.append((x, y, w, h + LABEL_HEIGHT))
        lamp_colors = [(60, 60, 220), (70, 200, 80), (40, 190, 240), (200, 200, 200)]
        for _ in range(int(rng.integers(2, 8))):
            radius = int(rng.integers(14, 30))
            cx = int(rng.integers(radius + 10, self.width - radius - 10))
            cy = int(rng.integers(radius + 10, self.height - radius - 10))
            box = (cx - radius - 10, cy - radius - 10, 2 * radius + 20, 2 * radius + 20)
            if all(
                box[0] + box[2] <= px
                or px + pw <= box[0]
                or box[1] + box[3] <= py
                or py + ph <= box[1]
                for px, py, pw, ph in occupied
            ):
                background.draw_lamp(
                    self.background,
                    (cx, cy),
                    radius,
                    lamp_colors[int(rng.integers(len(lamp_colors)))],
                )
                occupied.append(box)

    # ----------------------------------------------------------- rendering --
    def render_frame(
        self, states: dict[str, tuple[float | None, str]], fn: FrameNoise
    ) -> np.ndarray:
        """Draws one frame.

        states maps gauge_id to (value, text) as stored in the ground truth;
        a value of None draws the gauge without its needle or digits.
        """
        if fn.brightness == 1.0:
            canvas = self.background.copy()
        else:
            canvas = cv2.convertScaleAbs(self.background, alpha=fn.brightness)
        for gauge, (x, y), mask in zip(self.gauges, self.positions, self._masks, strict=True):
            value, text = states[gauge.gauge_id]
            patch = gauge.render(value, text)
            # Emissive displays keep most of their brightness in the dark.
            gain = 1.0 - (1.0 - fn.brightness) * 0.25 if gauge.emissive else fn.brightness
            if gain != 1.0:
                patch = cv2.convertScaleAbs(patch, alpha=gain)
            w, h = gauge.size
            region = canvas[y : y + h, x : x + w]
            if mask is None:
                region[:] = patch
            else:
                cv2.copyTo(patch, mask, region)

        shake = np.array([[1.0, 0.0, fn.shake_dx], [0.0, 1.0, fn.shake_dy], [0.0, 0.0, 1.0]])
        frame = cv2.warpPerspective(
            canvas, shake @ self.homography, (self.width, self.height),
            flags=cv2.INTER_LINEAR, borderMode=cv2.BORDER_REPLICATE,
        )  # fmt: skip
        noise.draw_occluder(frame, fn, self.profile.occluder_color)
        frame = noise.motion_blur(frame, fn.blur_len, fn.blur_angle)
        noise.add_glare(frame, self._glare, fn.glare_x, fn.glare_y, fn.glare_intensity)
        return frame

    # -------------------------------------------------------------- config --
    def config_dict(self, fps: float) -> dict:
        """Station config in the JSON shape of config.proto (StationConfig)."""
        gauges = []
        for gauge, quad, roi in zip(self.gauges, self.quads, self.rois, strict=True):
            entry = {
                "gauge_id": gauge.gauge_id,
                "type": gauge.type,
                "unit": gauge.unit,
                "roi": roi,
                "quad": [{"x": round(float(x), 2), "y": round(float(y), 2)} for x, y in quad],
                "rect_size": DEFAULT_RECT_SIZE,
                "calib": gauge.calib(DEFAULT_RECT_SIZE),
            }
            rules = gauge.rules()
            if rules:
                entry["rules"] = rules
            gauges.append(entry)
        return {
            "config_version": 1,
            "machine_id": self.machine_id,
            "plant": "SIM",
            "line": f"L{self.index // 10 + 1:02d}",
            "camera": {
                "url": f"rtsp://mediamtx:8554/{self.machine_id}",
                "sample_fps": int(min(2, max(1, round(fps)))),
            },
            "window_sec": 1,
            "gauges": gauges,
        }

    def describe(self) -> dict:
        """Appearance and noise settings, stored in render_meta.json."""
        profile = {
            k: (list(v) if isinstance(v, tuple) else v) for k, v in vars(self.profile).items()
        }
        return {
            "press_cycle": {"period_s": self.cycle.period_s, "phase_s": self.cycle.phase_s},
            "noise_profile": profile,
            "homography": [[float(v) for v in row] for row in self.homography],
            "gauges": [
                {"gauge_id": g.gauge_id, "type": g.type, "panel_xy": list(pos), **g.describe()}
                for g, pos in zip(self.gauges, self.positions, strict=True)
            ],
        }
