"""Common interface of the gauge face renderers."""

from __future__ import annotations

from abc import ABC, abstractmethod
from dataclasses import dataclass

import numpy as np

from gauge_renderer.scenarios import PressCycle


@dataclass(frozen=True)
class Display:
    """What a gauge shows on every frame of a clip.

    values: ground truth a perfect reader would report (timers in seconds).
    texts: characters of each digit slot ("_" for a blank slot); empty for dials.
    transitions: one "0"/"1" per slot, "1" while a rolling digit is mid-change.
    anomalies: scenario label per frame ("" when normal).
    """

    values: np.ndarray
    texts: list[str]
    transitions: list[str]
    anomalies: np.ndarray


class Gauge(ABC):
    """A gauge face drawn on a small patch in flat panel coordinates."""

    type: str
    # Emissive displays (LED) barely dim when the ambient light goes down.
    emissive: bool = False

    def __init__(self, gauge_id: str, unit: str) -> None:
        self.gauge_id = gauge_id
        self.unit = unit
        # Patch size (width, height) in pixels.
        self.size: tuple[int, int] = (0, 0)
        # Optional uint8 mask (255 = gauge) for non-rectangular patches.
        self.mask: np.ndarray | None = None
        # Corners (TL, TR, BR, BL) in patch coordinates of the area that maps
        # onto the rectified calibration square.
        self.quad_local: np.ndarray = np.zeros((4, 2))

    @abstractmethod
    def simulate(
        self, t: np.ndarray, fps: float, rng: np.random.Generator, cycle: PressCycle
    ) -> Display:
        """Generates the displayed series for the time axis t (seconds)."""

    @abstractmethod
    def render(self, value: float | None, text: str) -> np.ndarray:
        """Returns the BGR patch showing the given state.

        value None draws the static face only (no needle, no lit digits).
        The returned array must not be modified by the caller.
        """

    @abstractmethod
    def calib(self, rect_size: int) -> dict:
        """Calib fields of config.proto, in rectified-square coordinates."""

    @abstractmethod
    def rules(self) -> dict:
        """Rules fields of config.proto."""

    @abstractmethod
    def describe(self) -> dict:
        """Appearance parameters, stored in render_meta.json for reference."""
