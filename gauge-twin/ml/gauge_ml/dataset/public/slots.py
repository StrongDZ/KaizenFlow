"""Turns a loosely cropped real digit into a slot framed like the synthetic ones.

Edge-agent cuts slots by warping the commissioned quad into equal parts, so a
digit fills its slot the same way every time. Public datasets crop digits
their own way (wide margins, neighbours visible, digit off-centre). Feeding
those crops straight to the classifier measures the framing mismatch, not the
classifier; frame_digit re-centres the digit first. It uses only the image,
never the label.
"""

from __future__ import annotations

import cv2
import numpy as np

from gauge_ml import DIGIT_H, DIGIT_W

# Share of the slot height a digit fills in the rendered stations.
DIGIT_FILL = 0.85
# Width of a seven-segment cell relative to its height; a narrower blob is a
# "1", which sits at the right of its cell like on the rendered displays.
CELL_ASPECT = 0.55


def _foreground(gray: np.ndarray, polarity: str) -> np.ndarray:
    """Binary mask of the strokes: "dark" strokes on a light face (LCD) or "light" ones (LED, odometer).

    An adaptive threshold copes with the uneven light of real displays
    (shadow of the bezel, glare) where a global Otsu threshold does not.
    """
    height = gray.shape[0]
    block = max(15, int(0.3 * height) | 1)
    blurred = cv2.GaussianBlur(gray, (3, 3), 0)
    flag = cv2.THRESH_BINARY_INV if polarity == "dark" else cv2.THRESH_BINARY
    c = 10 if polarity == "dark" else -10
    mask = cv2.adaptiveThreshold(blurred, 255, cv2.ADAPTIVE_THRESH_MEAN_C, flag, block, c)
    return cv2.morphologyEx(mask, cv2.MORPH_OPEN, np.ones((3, 3), np.uint8))


def digit_box(gray: np.ndarray, polarity: str) -> tuple[int, int, int, int] | None:
    """Bounding box (x, y, w, h) of the digit nearest the horizontal centre, or None.

    Seven-segment strokes are separate blobs, so blobs the size of a segment
    are grouped into columns when they clearly overlap horizontally; a column tall
    enough to be a digit is a candidate. Lines spanning most of the crop
    (bezel, display edge), blobs touching the top or bottom edge and specks
    (decimal point, dust) are dropped. Digits cut by the left or right edge
    are neighbours; among the others the one nearest the centre wins.
    """
    height, width = gray.shape
    mask = _foreground(gray, polarity)
    count, _, stats, _ = cv2.connectedComponentsWithStats(mask, connectivity=8)
    blobs = []
    for i in range(1, count):
        x, y, w, h, _ = stats[i]
        if w > 0.6 * width or h > 0.95 * height or max(w, h) < 0.1 * height:
            continue
        if y <= 1 or y + h >= height - 1:
            continue
        blobs.append([x, y, x + w, y + h])
    if not blobs:
        return None
    blobs.sort()
    columns: list[list[int]] = []
    for x0, y0, x1, y1 in blobs:
        # Slanted neighbours overlap by a few pixels; strokes of one digit
        # overlap by a good part of the narrower one.
        if columns and min(columns[-1][2], x1) - max(columns[-1][0], x0) >= 0.3 * min(
            x1 - x0, columns[-1][2] - columns[-1][0]
        ):
            col = columns[-1]
            col[0], col[1], col[2], col[3] = min(col[0], x0), min(col[1], y0), max(col[2], x1), max(col[3], y1)
        else:
            columns.append([x0, y0, x1, y1])
    digits = [c for c in columns if c[3] - c[1] >= 0.3 * height]
    whole = [c for c in digits if c[0] > 1 and c[2] < width - 1]
    if not (whole or digits):
        return None
    x0, y0, x1, y1 = min(whole or digits, key=lambda c: abs((c[0] + c[2]) / 2 - width / 2))
    return int(x0), int(y0), int(x1 - x0), int(y1 - y0)


def frame_digit(image: np.ndarray, polarity: str) -> np.ndarray:
    """A (DIGIT_H, DIGIT_W) uint8 grayscale slot with the digit framed like the synthetic slots.

    Falls back to resizing the whole crop when no digit is found.
    """
    gray = image if image.ndim == 2 else cv2.cvtColor(image, cv2.COLOR_BGR2GRAY)
    box = digit_box(gray, polarity)
    if box is None:
        return cv2.resize(gray, (DIGIT_W, DIGIT_H), interpolation=cv2.INTER_AREA)
    x, y, w, h = box
    slot_h = h / DIGIT_FILL
    slot_w = slot_h * DIGIT_W / DIGIT_H
    cell_w = CELL_ASPECT * h
    if w < 0.6 * cell_w:
        # A "1": right-align it inside a full-width cell.
        cx = x + w - cell_w / 2
    else:
        cx = x + w / 2
    cy = y + h / 2
    src = np.array(
        [[cx - slot_w / 2, cy - slot_h / 2], [cx + slot_w / 2, cy - slot_h / 2], [cx + slot_w / 2, cy + slot_h / 2]],
        dtype=np.float32,
    )
    dst = np.array([[0, 0], [DIGIT_W, 0], [DIGIT_W, DIGIT_H]], dtype=np.float32)
    return cv2.warpAffine(
        gray,
        cv2.getAffineTransform(src, dst),
        (DIGIT_W, DIGIT_H),
        flags=cv2.INTER_AREA,
        borderMode=cv2.BORDER_REPLICATE,
    )


def resize_whole(image: np.ndarray) -> np.ndarray:
    """The crop resized to a slot as it is, for comparison with frame_digit."""
    gray = image if image.ndim == 2 else cv2.cvtColor(image, cv2.COLOR_BGR2GRAY)
    return cv2.resize(gray, (DIGIT_W, DIGIT_H), interpolation=cv2.INTER_AREA)
