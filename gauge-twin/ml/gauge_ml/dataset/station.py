"""Reads one rendered station: config, ground truth and video frames."""

from __future__ import annotations

import json
from collections.abc import Iterator
from dataclasses import dataclass
from pathlib import Path

import cv2
import numpy as np
import pyarrow.parquet as pq

DEFAULT_RECT_SIZE = 256


@dataclass(frozen=True)
class GaugeInfo:
    gauge_id: str
    type: str
    roi: list[int]
    quad: np.ndarray  # (4, 2) TL, TR, BR, BL in frame pixels
    rect_size: int
    calib: dict
    appearance: dict  # entry of render_meta.json for this gauge


@dataclass(frozen=True)
class Frame:
    index: int
    image: np.ndarray  # BGR
    rows: dict[str, dict]  # ground-truth row per gauge_id


class Station:
    """A station directory written by sim/gauge-renderer."""

    def __init__(self, directory: Path) -> None:
        self.directory = directory
        config = json.loads((directory / "station_config.json").read_text())
        self.meta = json.loads((directory / "render_meta.json").read_text())
        self.machine_id: str = config["machine_id"]
        self.noise_level: str = self.meta["noise_level"]
        self.fps: float = float(self.meta["fps"])
        appearance = {g["gauge_id"]: g for g in self.meta["gauges"]}
        self.gauges: list[GaugeInfo] = []
        for g in config["gauges"]:
            if g.get("quad"):
                quad = np.array([[p.get("x", 0.0), p.get("y", 0.0)] for p in g["quad"]], dtype=np.float64)
            else:
                # No quad means a frontal view: the roi itself is the gauge area.
                x, y, w, h = g["roi"]
                quad = np.array([[x, y], [x + w, y], [x + w, y + h], [x, y + h]], dtype=np.float64)
            self.gauges.append(
                GaugeInfo(
                    gauge_id=g["gauge_id"],
                    type=g["type"],
                    roi=[int(v) for v in g["roi"]],
                    quad=quad,
                    rect_size=int(g.get("rect_size", DEFAULT_RECT_SIZE)),
                    calib=g.get("calib", {}),
                    appearance=appearance.get(g["gauge_id"], {}),
                )
            )
        table = pq.read_table(directory / "groundtruth.parquet").to_pylist()
        self._rows: dict[int, dict[str, dict]] = {}
        for row in table:
            self._rows.setdefault(row["frame_idx"], {})[row["gauge_id"]] = row

    def frames(self, sample_fps: float) -> Iterator[Frame]:
        """Decodes the video and yields roughly sample_fps frames per second."""
        step = max(1, int(round(self.fps / sample_fps)))
        capture = cv2.VideoCapture(str(self.directory / "video.mp4"))
        try:
            index = 0
            while True:
                ok, image = capture.read()
                if not ok:
                    break
                if index % step == 0 and index in self._rows:
                    yield Frame(index, image, self._rows[index])
                index += 1
        finally:
            capture.release()
