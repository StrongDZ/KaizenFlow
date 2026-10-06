"""Digit samples: the gauge quad rectified and cut into equal slots."""

from __future__ import annotations

import numpy as np

from gauge_ml import CLASS_BLANK, CLASS_TRANSITION, preprocess
from gauge_ml.dataset.station import Frame, GaugeInfo

BLANK_CHAR = "_"


def slot_labels(text: str, transition: str) -> list[int]:
    """Class per slot from the ground-truth text and transition mask."""
    labels = []
    for i, char in enumerate(text):
        if i < len(transition) and transition[i] == "1":
            labels.append(CLASS_TRANSITION)
        elif char == BLANK_CHAR:
            labels.append(CLASS_BLANK)
        else:
            labels.append(int(char))
    return labels


def cut_slots(image: np.ndarray, quad: np.ndarray, digits: int) -> np.ndarray:
    """Rectifies the quad and returns its slots as (digits, DIGIT_H, DIGIT_W) uint8 grayscale.

    The nominal quad from the config is used, exactly as edge-agent will: the
    camera shake of the frame is not compensated, the classifier has to cope.
    """
    return preprocess.digit_slots(image, quad, digits)


def make_slots(frame: Frame, gauge: GaugeInfo) -> tuple[np.ndarray, list[int]]:
    row = frame.rows[gauge.gauge_id]
    digits = int(gauge.calib["digits"])
    labels = slot_labels(row["text"], row["transition"])
    if len(labels) != digits:
        raise ValueError(f"{gauge.gauge_id}: {len(labels)} characters for {digits} digits")
    return cut_slots(frame.image, gauge.quad, digits), labels
