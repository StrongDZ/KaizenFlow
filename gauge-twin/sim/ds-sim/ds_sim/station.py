"""Station configs as written by edge-agent into the shared config directory."""

from __future__ import annotations

import json
from dataclasses import dataclass, field
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
    camera_url: str = ""  # the stream that sees this gauge


@dataclass(frozen=True)
class StationConfig:
    machine_id: str
    config_version: int
    camera_url: str  # the default camera
    sample_fps: float
    gauges: list[Gauge]
    # url -> sample_fps of the cameras the gauges are on. A camera can also be
    # in the config of another machine: a stream is recognised by its url.
    cameras: dict[str, float] = field(default_factory=dict)


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
    """Reads a config the pipeline will run: every gauge must be on a camera."""
    config = parse(json.loads(path.read_text()))
    for gauge in config.gauges:
        if not gauge.camera_url:
            raise ValueError(f"gauge {gauge.gauge_id}: the config has no default camera")
    return config


def _camera_of(raw: dict, gauge: dict) -> dict:
    """The camera a gauge names, or the default one. Same rule as decode.CameraOf in Go."""
    camera_id = gauge.get("camera_id", "")
    default = raw.get("camera") or {}
    if camera_id == "" or (default and default.get("camera_id", "") == camera_id):
        camera = default
    else:
        camera = next(
            (c for c in raw.get("cameras", []) if c.get("camera_id", "") == camera_id), None
        )
    if camera is None:
        raise ValueError(f"gauge {gauge['gauge_id']}: unknown camera {camera_id!r}")
    if camera_id != "" and not camera.get("url"):
        raise ValueError(f"gauge {gauge['gauge_id']}: camera {camera_id!r} has no url")
    return camera


def parse(raw: dict) -> StationConfig:
    """Builds a StationConfig from its JSON form (a file or a config-api body)."""
    gauges = []
    cameras: dict[str, float] = {}
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
        # A draft sent to the commissioning preview may have no default
        # camera yet: its gauges then have no stream (load() refuses that).
        camera = _camera_of(raw, g)
        if camera.get("url"):
            cameras[camera["url"]] = float(camera.get("sample_fps", 2))
        gauges.append(
            Gauge(
                g["gauge_id"],
                g["type"],
                roi,
                quad,
                int(g.get("calib", {}).get("digits", 0)),
                camera.get("url", ""),
            )
        )
    camera = raw.get("camera") or {}
    return StationConfig(
        machine_id=raw["machine_id"],
        config_version=int(raw.get("config_version", 0)),
        camera_url=camera.get("url", ""),
        sample_fps=float(camera.get("sample_fps", 2)),
        gauges=gauges,
        cameras=cameras,
    )


def cameras_in_use(configs: list[StationConfig]) -> dict[str, float]:
    """url -> sample_fps of every stream to open: a camera shared by several
    machines is opened once, at the highest rate any of them asks for."""
    out: dict[str, float] = {}
    for config in configs:
        for url, fps in config.cameras.items():
            out[url] = max(fps, out.get(url, 0.0))
    return out
