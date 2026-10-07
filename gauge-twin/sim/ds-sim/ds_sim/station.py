"""Station configs as written by edge-agent into the shared config directory."""

from __future__ import annotations

import json
from dataclasses import dataclass
from pathlib import Path

import numpy as np

DIAL_TYPE = "analog_dial"
DIGIT_TYPES = ("seg7", "timer_mmss", "rolling_counter")


@dataclass(frozen=True)
class Gauge:
    gauge_id: str
    type: str
    roi: list[int]
    quad: np.ndarray  # (4, 2) TL, TR, BR, BL in frame pixels
    digits: int


@dataclass(frozen=True)
class StationConfig:
    machine_id: str
    config_version: int
    camera_url: str
    sample_fps: float
    gauges: list[Gauge]


def _points(quad: list) -> np.ndarray:
    """Accepts both [{"x":..,"y":..}] (proto JSON) and [[x, y]] forms.

    Proto3 JSON, which edge-agent writes, leaves out a coordinate that is 0:
    a quad corner on the left or top edge of the frame arrives as {"y": 512}
    or {}.
    """
    return np.array(
        [[p.get("x", 0.0), p.get("y", 0.0)] if isinstance(p, dict) else p for p in quad],
        dtype=np.float64,
    )


def load(path: Path) -> StationConfig:
    return parse(json.loads(path.read_text()))


def parse(raw: dict) -> StationConfig:
    """Builds a StationConfig from its JSON form (a file or a config-api body)."""
    gauges = []
    for g in raw.get("gauges", []):
        if g["type"] != DIAL_TYPE and g["type"] not in DIGIT_TYPES:
            raise ValueError(f"gauge {g['gauge_id']}: unknown type {g['type']!r}")
        roi = [int(v) for v in g["roi"]]
        if g.get("quad"):
            quad = _points(g["quad"])
        else:
            x, y, w, h = roi
            quad = np.array([[x, y], [x + w, y], [x + w, y + h], [x, y + h]], dtype=np.float64)
        if quad.shape != (4, 2):
            raise ValueError(f"gauge {g['gauge_id']}: quad must have 4 points")
        gauges.append(
            Gauge(g["gauge_id"], g["type"], roi, quad, int(g.get("calib", {}).get("digits", 0)))
        )
    camera = raw.get("camera", {})
    return StationConfig(
        machine_id=raw["machine_id"],
        config_version=int(raw.get("config_version", 0)),
        camera_url=camera.get("url", ""),
        sample_fps=float(camera.get("sample_fps", 2)),
        gauges=gauges,
    )
