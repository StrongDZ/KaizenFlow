"""Loaders converting public datasets into what the evaluation needs.

Each dataset lives in data/public/<name>/ as downloaded (sources and licences
in the README, section "Model") and is registered in LOADERS under that name.
"""

from __future__ import annotations

from collections.abc import Iterator
from dataclasses import dataclass
from pathlib import Path
from typing import Protocol

import numpy as np

from gauge_ml.dataset.public import (
    gauge_keypoints,
    lcd_digits,
    meter_digits,
    pressure_gauge,
    seg7_modules,
    time_displays,
    trodo,
    yolo_digits,
    yuva_eb,
)


class DialLoader(Protocol):
    """Yields real dial images with whatever ground truth the dataset has."""

    def __call__(self, root: Path) -> Iterator[tuple[np.ndarray, dict]]:
        """Yields (BGR image, labels); labels hold at least "value"."""
        ...


class DigitLoader(Protocol):
    """Yields single-digit crops with their class."""

    def __call__(self, root: Path) -> Iterator[tuple[np.ndarray, int, dict]]:
        """Yields (grayscale digit crop, class in 0..11, meta); meta holds
        "sequence" (one id per display) and "gauge_type", and may hold
        "eval_only" to send that sample to the test split."""
        ...


@dataclass(frozen=True)
class DigitSource:
    load: DigitLoader
    # True when the crops are already slots framed like the synthetic ones;
    # otherwise the evaluation frames them (slots.frame_digit) with this polarity.
    framed: bool
    # "dark" strokes on a light face (LCD) or "light" strokes (LED, odometer drums).
    polarity: str
    licence: str
    # Only for the test split: unknown licence, or a domain kept apart.
    eval_only: bool = False


@dataclass(frozen=True)
class DialSource:
    load: DialLoader
    licence: str
    eval_only: bool = False


LOADERS: dict[str, DigitSource | DialSource] = {
    "lcd-digits": DigitSource(lcd_digits.load, framed=False, polarity=lcd_digits.POLARITY, licence="CC0-1.0"),
    "trodo": DigitSource(trodo.load, framed=True, polarity="", licence="CC-BY-4.0"),
    "meter-digits-tenth": DigitSource(meter_digits.load, framed=True, polarity="", licence="CC0-1.0"),
    "seg7-cramatsu": DigitSource(yolo_digits.load, framed=True, polarity="", licence="MIT"),
    "yuva-eb": DigitSource(yuva_eb.load, framed=True, polarity="", licence="CC0-1.0"),
    "seg7-industrial": DigitSource(seg7_modules.load, framed=True, polarity="", licence="unknown", eval_only=True),
    # Licence per photo (manifest.csv); photos not licensed for training are marked eval_only by the loader.
    "time-displays": DigitSource(time_displays.load, framed=True, polarity="", licence="per-image"),
    "pressure-gauge": DialSource(pressure_gauge.load, licence="CC-BY-SA-4.0", eval_only=True),
    "gauge-analog-kim": DialSource(gauge_keypoints.load, licence="MIT"),
}
