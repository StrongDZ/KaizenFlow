"""Machine cabinet background the gauges are mounted on."""

from __future__ import annotations

import cv2
import numpy as np

PANEL_COLORS = [(172, 174, 170), (168, 186, 196), (150, 168, 152), (176, 164, 148), (120, 124, 122)]


def make_panel(rng: np.random.Generator, width: int, height: int) -> np.ndarray:
    """Painted sheet-metal panel with a brushed texture, seams and screws."""
    base = np.array(PANEL_COLORS[int(rng.integers(len(PANEL_COLORS)))], np.float32)
    gradient = np.linspace(8.0, -10.0, height, dtype=np.float32)[:, None]
    texture = rng.normal(0.0, 6.0, (height, width)).astype(np.float32)
    texture = cv2.blur(texture, (31, 1)) * 3.0
    img = base[None, None, :] + (gradient + texture)[:, :, None]
    img = np.clip(np.rint(img), 0, 255).astype(np.uint8)

    dark = tuple(int(v * 0.55) for v in base)
    light = tuple(int(min(255, v * 1.12)) for v in base)
    for _ in range(int(rng.integers(1, 4))):
        if rng.random() < 0.5:
            x = int(rng.integers(width // 8, 7 * width // 8))
            cv2.line(img, (x, 0), (x, height - 1), dark, 3)
            cv2.line(img, (x + 3, 0), (x + 3, height - 1), light, 1)
        else:
            y = int(rng.integers(height // 8, 7 * height // 8))
            cv2.line(img, (0, y), (width - 1, y), dark, 3)
            cv2.line(img, (0, y + 3), (width - 1, y + 3), light, 1)
    for _ in range(int(rng.integers(6, 15))):
        centre = (int(rng.integers(20, width - 20)), int(rng.integers(20, height - 20)))
        draw_screw(img, centre, int(rng.integers(7, 12)), float(rng.uniform(0.0, 180.0)))
    return img


def draw_screw(img: np.ndarray, centre: tuple[int, int], radius: int, angle_deg: float) -> None:
    cv2.circle(img, centre, radius, (95, 98, 100), -1, cv2.LINE_AA)
    cv2.circle(img, centre, radius, (55, 55, 58), 1, cv2.LINE_AA)
    dx = int(round(radius * 0.8 * np.cos(np.radians(angle_deg))))
    dy = int(round(radius * 0.8 * np.sin(np.radians(angle_deg))))
    cv2.line(
        img,
        (centre[0] - dx, centre[1] - dy),
        (centre[0] + dx, centre[1] + dy),
        (40, 40, 42),
        2,
        cv2.LINE_AA,
    )


def draw_label(img: np.ndarray, text: str, centre_x: int, top: int, dark: bool) -> None:
    """Engraved name plate below a gauge."""
    font, scale, thickness = cv2.FONT_HERSHEY_SIMPLEX, 0.55, 1
    (w, h), _ = cv2.getTextSize(text, font, scale, thickness)
    x0, x1 = centre_x - w // 2 - 10, centre_x + w // 2 + 10
    plate, ink = ((30, 30, 30), (225, 225, 225)) if dark else ((228, 230, 230), (25, 25, 25))
    cv2.rectangle(img, (x0, top), (x1, top + h + 14), plate, -1)
    cv2.rectangle(img, (x0, top), (x1, top + h + 14), (90, 90, 90), 1)
    cv2.putText(
        img, text, (centre_x - w // 2, top + h + 7), font, scale, ink, thickness, cv2.LINE_AA
    )


def draw_lamp(
    img: np.ndarray, centre: tuple[int, int], radius: int, color: tuple[int, int, int]
) -> None:
    """Indicator lamp or push button, purely decorative."""
    cv2.circle(img, centre, radius + 5, (60, 60, 62), -1, cv2.LINE_AA)
    cv2.circle(img, centre, radius, color, -1, cv2.LINE_AA)
    highlight = (centre[0] - radius // 3, centre[1] - radius // 3)
    cv2.circle(
        img, highlight, max(2, radius // 4), tuple(min(255, c + 70) for c in color), -1, cv2.LINE_AA
    )
