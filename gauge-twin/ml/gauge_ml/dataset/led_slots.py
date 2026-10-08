"""Synthetic slots of LED seven-segment displays as a camera sees them.

The real training data has few LED displays (most "seg7" slots are LCDs), and
LED modules photographed in a factory look unlike a clean rendering: the unlit
segments stay visible, sometimes almost as bright as the lit ones, the lit
ones burn out to white with a coloured glow around them, the neighbouring
digits reach into the slot, and the slot is rarely cut exactly around the
digit. This module draws such slots in colour and turns them to grey with the
weights of the pipeline (preprocess.DIGIT), so the model trains on what it will
get.

    python -m gauge_ml.dataset.led_slots --real data/ml-real --out data/ml-led-mix

writes digits/<split>.npz in the format of the builder: the real train and val
splits with the synthetic slots added, and the real test split unchanged.
"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

import cv2
import numpy as np

from gauge_ml import CLASS_BLANK, DIGIT_H, DIGIT_W
from gauge_ml.preprocess import DIGIT

# Segments lit for each digit: a top, b top right, c bottom right, d bottom,
# e bottom left, f top left, g middle. 6, 7 and 9 exist in two styles.
SEGMENTS: dict[int, tuple[str, ...]] = {
    0: ("abcdef",),
    1: ("bc",),
    2: ("abged",),
    3: ("abgcd",),
    4: ("fgbc",),
    5: ("afgcd",),
    6: ("afgedc", "fgedc"),
    7: ("abc", "abcf"),
    8: ("abcdefg",),
    9: ("abcdfg", "abcfg"),
}

SCALE = 4  # drawn at 4x and reduced, for smooth edges
SLOT_W, SLOT_H = DIGIT_W * SCALE, DIGIT_H * SCALE

# LED colours as (R, G, B) ranges, with how often each is drawn.
COLOURS = [
    (0.60, ((0.90, 1.00), (0.03, 0.30), (0.03, 0.30))),  # red
    (0.10, ((0.95, 1.00), (0.45, 0.75), (0.02, 0.20))),  # amber
    (0.15, ((0.05, 0.40), (0.85, 1.00), (0.10, 0.45))),  # green
    (0.05, ((0.10, 0.35), (0.40, 0.75), (0.90, 1.00))),  # blue
    (0.10, ((0.90, 1.00), (0.90, 1.00), (0.90, 1.00))),  # white
]


def _segment_polygons(x0: float, y0: float, w: float, h: float, t: float, gap: float) -> dict[str, np.ndarray]:
    """The seven bars of a digit in the box (x0, y0, w, h): thickness t, gap between bars."""

    def horizontal(y: float) -> np.ndarray:
        a, b = x0 + t / 2 + gap, x0 + w - t / 2 - gap
        return np.array(
            [
                [a, y],
                [a + t / 2, y - t / 2],
                [b - t / 2, y - t / 2],
                [b, y],
                [b - t / 2, y + t / 2],
                [a + t / 2, y + t / 2],
            ]
        )

    def vertical(x: float, a: float, b: float) -> np.ndarray:
        return np.array(
            [
                [x, a],
                [x + t / 2, a + t / 2],
                [x + t / 2, b - t / 2],
                [x, b],
                [x - t / 2, b - t / 2],
                [x - t / 2, a + t / 2],
            ]
        )

    top, mid, bottom = y0 + t / 2, y0 + h / 2, y0 + h - t / 2
    left, right = x0 + t / 2, x0 + w - t / 2
    return {
        "a": horizontal(top),
        "g": horizontal(mid),
        "d": horizontal(bottom),
        "f": vertical(left, top + gap, mid - gap),
        "b": vertical(right, top + gap, mid - gap),
        "e": vertical(left, mid + gap, bottom - gap),
        "c": vertical(right, mid + gap, bottom - gap),
    }


def render_slot(rng: np.random.Generator, label: int) -> np.ndarray:
    """One (DIGIT_H, DIGIT_W) uint8 grey slot showing `label` (a digit, or CLASS_BLANK for an unlit position)."""
    # Geometry: the digit of the slot with a neighbour on each side.
    digit_h = SLOT_H * rng.uniform(0.60, 0.98)
    digit_w = digit_h * rng.uniform(0.45, 0.62)
    pitch = digit_w * rng.uniform(1.15, 1.60)
    thickness = digit_w * rng.uniform(0.13, 0.24)
    gap = thickness * rng.uniform(0.05, 0.30)
    slant = rng.uniform(0.0, 0.18)
    # The slot is seldom cut exactly around the digit.
    cx = SLOT_W / 2 + SLOT_W * rng.uniform(-0.14, 0.14)
    cy = SLOT_H / 2 + SLOT_H * rng.uniform(-0.08, 0.08)

    pad = int(pitch) + SLOT_W
    width = SLOT_W + 2 * pad
    lit = np.zeros((SLOT_H, width), np.uint8)
    unlit = np.zeros((SLOT_H, width), np.uint8)

    def neighbour() -> int:
        return int(rng.integers(0, 10)) if rng.random() < 0.8 else CLASS_BLANK

    shown = [neighbour(), label, neighbour()]
    for position, value in zip((-1, 0, 1), shown, strict=True):
        x0 = pad + cx + position * pitch - digit_w / 2
        y0 = cy - digit_h / 2
        on = "" if value == CLASS_BLANK else SEGMENTS[value][int(rng.integers(0, len(SEGMENTS[value])))]
        for name, polygon in _segment_polygons(x0, y0, digit_w, digit_h, thickness, gap).items():
            # Italic digits: the top leans to the right.
            polygon = polygon + np.stack([slant * (y0 + digit_h - polygon[:, 1]), np.zeros(len(polygon))], axis=1)
            points = [np.round(polygon * 8).astype(np.int32)]
            cv2.fillPoly(lit if name in on else unlit, points, 255, lineType=cv2.LINE_AA, shift=3)
        # Decimal point at the lower right of the digit; never lit next to a blank.
        point = (int(x0 + digit_w + thickness * 0.9), int(y0 + digit_h - thickness / 2))
        target = lit if value != CLASS_BLANK and rng.random() < 0.15 else unlit
        cv2.circle(target, point, max(1, int(thickness * 0.55)), 255, -1, cv2.LINE_AA)
    lit_f = lit.astype(np.float32) / 255
    unlit_f = unlit.astype(np.float32) / 255

    # Colours, RGB in [0, 1].
    pick = rng.choice(len(COLOURS), p=[c[0] for c in COLOURS])
    colour = np.array([rng.uniform(lo, hi) for lo, hi in COLOURS[pick][1]], np.float32)
    background = rng.uniform(0.0, 0.20) * (1 + rng.uniform(-0.2, 0.2, 3)).astype(np.float32)
    kind = rng.random()
    if kind < 0.35:  # unlit segments invisible
        ghost = colour * rng.uniform(0.0, 0.03)
    elif kind < 0.80:  # dim, in the colour of the LED
        ghost = colour * rng.uniform(0.05, 0.28)
    else:  # pale plastic that reflects the room light
        ghost = np.float32(rng.uniform(0.22, 0.50)) * (0.75 + 0.25 * colour)
    brightness = rng.uniform(0.50, 1.0)
    image = background[None, None, :] + unlit_f[..., None] * ghost[None, None, :]
    image = image + lit_f[..., None] * (colour * brightness)[None, None, :]
    # A bright LED burns out to white in its middle and glows around its edge.
    if rng.random() < 0.6:
        core = cv2.GaussianBlur(lit_f, (0, 0), thickness * 0.25) ** 2
        image += core[..., None] * rng.uniform(0.2, 1.0)
        glow = cv2.GaussianBlur(lit_f, (0, 0), rng.uniform(2.0, 14.0))
        image += glow[..., None] * colour[None, None, :] * rng.uniform(0.1, 0.9)
    image *= rng.uniform(0.7, 1.3)

    image = image[:, pad : pad + SLOT_W]
    blur = rng.uniform(0.0, 2.6)
    if blur > 0.3:
        image = cv2.GaussianBlur(image, (0, 0), blur)
    image = cv2.resize(np.clip(image, 0, 1), (DIGIT_W, DIGIT_H), interpolation=cv2.INTER_AREA)
    image = image + rng.normal(0, rng.uniform(0.0, 0.03), image.shape).astype(np.float32)
    # Grey as the pipeline makes it: the weights of preprocess.DIGIT are for B, G, R.
    weights_bgr = np.array(DIGIT["gray_weights_bgr"], np.float32)
    grey = np.clip(image, 0, 1) @ weights_bgr[::-1]
    return np.round(grey * 255).astype(np.uint8)


def render(count: int, seed: int, blank_share: float = 0.1) -> dict[str, np.ndarray]:
    """`count` slots as a split dictionary of the builder format."""
    rng = np.random.default_rng(seed)
    labels = np.where(rng.random(count) < blank_share, CLASS_BLANK, rng.integers(0, 10, count)).astype(np.uint8)
    images = (
        np.stack([render_slot(rng, int(label)) for label in labels])
        if count
        else np.zeros((0, DIGIT_H, DIGIT_W), np.uint8)
    )
    return {
        "images": images,
        "labels": labels,
        # Every slot is its own display: there is no whole reading to match.
        "sequence": np.arange(count, dtype=np.int64),
        "slot": np.zeros(count, np.int16),
        "station": np.full(count, -1, np.int32),
        "gauge_type": np.full(count, "seg7", "<U16"),
        "color": np.full(count, "synthetic-led", "<U24"),
        "noise_level": np.full(count, "synthetic", "<U8"),
        "occluded": np.zeros(count, np.float32),
        "glare_local": np.zeros(count, np.float32),
    }


def mix(real: dict[str, np.ndarray], synthetic: dict[str, np.ndarray]) -> dict[str, np.ndarray]:
    """The real split followed by the synthetic slots; display ids stay distinct."""
    offset = int(real["sequence"].max()) + 1 if len(real["sequence"]) else 0
    out = {}
    for key, values in real.items():
        extra = synthetic[key] + offset if key == "sequence" else synthetic[key]
        out[key] = np.concatenate([values, extra.astype(values.dtype)])
    return out


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="led-slots", description=__doc__.split("\n\n")[0])
    parser.add_argument("--real", type=Path, required=True, help="dataset of build_real (digits/<split>.npz)")
    parser.add_argument("--out", type=Path, required=True)
    parser.add_argument("--train", type=int, default=60000, help="synthetic slots added to the train split")
    parser.add_argument("--val", type=int, default=6000, help="synthetic slots added to the val split")
    parser.add_argument("--seed", type=int, default=0)
    args = parser.parse_args(argv)

    (args.out / "digits").mkdir(parents=True, exist_ok=True)
    for index, (split, count) in enumerate((("train", args.train), ("val", args.val), ("test", 0))):
        with np.load(args.real / "digits" / f"{split}.npz") as archive:
            real = {key: archive[key] for key in archive.files}
        merged = mix(real, render(count, args.seed + index))
        np.savez_compressed(args.out / "digits" / f"{split}.npz", **merged)
        print(f"{split}: {len(real['labels'])} real + {count} synthetic slots")
    return 0


if __name__ == "__main__":
    sys.exit(main())
