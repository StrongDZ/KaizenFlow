"""Finds the digit band of a display and the box of every digit in it, from the image alone.

The screening VLM gives a rough box around the main reading; refine_quad
turns it into a quad that hugs the digits, rectify straightens it, and
find_cells returns one box per digit. Separators (colon, decimal point) are
lower than a digit and drop out, so cells follow the real layout of the
display instead of an even split of the quad.
"""

from __future__ import annotations

import cv2
import numpy as np

from gauge_ml.dataset.public.slots import _foreground as foreground

# Share of the band height a blob column must reach to count as a digit.
DIGIT_MIN_HEIGHT = 0.6
# Margin added around the digits, as a share of the band height.
QUAD_MARGIN = 0.1
# Columns fainter than this share of the clearest digit are not digits.
MIN_CONTRAST = 0.5
# Blobs filling less of their bounding box than this are slanted lines, not strokes.
MIN_FILL = 0.12
# Blobs smaller than this share of the largest allowed size are specks.
SPECK = 0.06


def order_quad(points: np.ndarray) -> np.ndarray:
    """Four points ordered TL, TR, BR, BL."""
    pts = np.asarray(points, np.float32).reshape(4, 2)
    by_y = pts[np.argsort(pts[:, 1])]
    top = by_y[:2][np.argsort(by_y[:2, 0])]
    bottom = by_y[2:][np.argsort(by_y[2:, 0])]
    return np.array([top[0], top[1], bottom[1], bottom[0]], np.float32)


def _columns(mask: np.ndarray, max_size: float) -> list[list[int]]:
    """Blobs grouped into columns when they clearly overlap horizontally (as in slots.digit_box).

    Specks (dust, noise, decimal points: under SPECK of max_size), blobs wider
    or taller than max_size (bezel, panel edge) and long thin
    slanted lines (edges of a tilted panel, which fill little of their box)
    are dropped first so that they cannot swallow the digits.
    """
    count, _, stats, _ = cv2.connectedComponentsWithStats(mask, connectivity=8)
    blobs = sorted(
        [int(x), int(y), int(x + w), int(y + h)]
        for x, y, w, h, area in stats[1:count]
        if max(w, h) >= SPECK * max_size and w <= max_size and h <= max_size and area >= MIN_FILL * w * h
    )
    columns: list[list[int]] = []
    for x0, y0, x1, y1 in blobs:
        if columns and min(columns[-1][2], x1) - max(columns[-1][0], x0) >= 0.3 * min(
            x1 - x0, columns[-1][2] - columns[-1][0]
        ):
            col = columns[-1]
            col[0], col[1], col[2], col[3] = min(col[0], x0), min(col[1], y0), max(col[2], x1), max(col[3], y1)
        else:
            columns.append([x0, y0, x1, y1])
    return columns


def refine_quad(image: np.ndarray, box: tuple[float, float, float, float], polarity: str) -> np.ndarray | None:
    """Quad (TL, TR, BR, BL, image pixels) around the digits inside a rough box (x0, y0, x1, y1), or None."""
    gray = image if image.ndim == 2 else cv2.cvtColor(image, cv2.COLOR_BGR2GRAY)
    height, width = gray.shape
    x0, y0, x1, y1 = box
    if x1 <= x0 or y1 <= y0:
        return None
    mx, my = 0.25 * (x1 - x0), 0.25 * (y1 - y0)
    cx0, cy0 = int(max(0, x0 - mx)), int(max(0, y0 - my))
    cx1, cy1 = int(min(width, x1 + mx)), int(min(height, y1 + my))
    if cx1 - cx0 < 8 or cy1 - cy0 < 8:
        return None
    crop = gray[cy0:cy1, cx0:cx1]
    mask = foreground(crop, polarity)
    ch, cw = mask.shape
    box_h = y1 - y0
    # Digit-like columns: a good part of the box tall, not a bezel line, not cut by the crop.
    columns = [
        c
        for c in _columns(mask, 1.05 * box_h)
        if 0.25 * box_h <= c[3] - c[1] <= 1.05 * box_h
        and c[2] - c[0] <= box_h
        and c[0] > 0
        and c[1] > 0
        and c[2] < cw
        and c[3] < ch
    ]
    if not columns:
        return None
    # The reading is the run of columns sharing the height and baseline of the tallest ones.
    heights = np.array([c[3] - c[1] for c in columns], np.float32)
    centres = np.array([(c[1] + c[3]) / 2 for c in columns], np.float32)
    ref = float(np.percentile(heights, 75))
    ref_centre = float(np.median(centres[heights >= 0.65 * ref]))
    keep = [
        c
        for c, h, y in zip(columns, heights, centres, strict=True)
        if h >= 0.65 * ref and abs(y - ref_centre) <= 0.4 * ref
    ]
    inside = np.zeros_like(mask)
    for x0c, y0c, x1c, y1c in keep:
        inside[y0c:y1c, x0c:x1c] = mask[y0c:y1c, x0c:x1c]
    ys, xs = np.nonzero(inside)
    if len(xs) < 10:
        return None
    (cx, cy), (w, h), angle = cv2.minAreaRect(np.column_stack([xs, ys]).astype(np.float32))
    if w < h:
        w, h, angle = h, w, angle + 90.0
    pad = QUAD_MARGIN * h
    rect = ((cx + cx0, cy + cy0), (w + 2 * pad, h + 2 * pad), angle)
    return order_quad(cv2.boxPoints(rect))


def rectify(image: np.ndarray, quad: np.ndarray, height: int) -> np.ndarray:
    """The quad warped to a straight band `height` pixels tall, keeping its aspect ratio."""
    q = order_quad(quad)
    top, bottom = np.linalg.norm(q[1] - q[0]), np.linalg.norm(q[2] - q[3])
    left, right = np.linalg.norm(q[3] - q[0]), np.linalg.norm(q[2] - q[1])
    width = max(8, int(round(height * (top + bottom) / max(left + right, 1e-6))))
    dst = np.array([[0, 0], [width, 0], [width, height], [0, height]], np.float32)
    return cv2.warpPerspective(
        image,
        cv2.getPerspectiveTransform(q, dst),
        (width, height),
        flags=cv2.INTER_AREA,
        borderMode=cv2.BORDER_REPLICATE,
    )


def find_cells(gray: np.ndarray, polarity: str) -> list[tuple[int, int, int, int]]:
    """Box (x0, y0, x1, y1) of every digit of a rectified band, left to right."""
    height, width = gray.shape
    mask = foreground(gray, polarity)
    sign = 1.0 if polarity == "light" else -1.0
    cells, contrasts = [], []
    for x0, y0, x1, y1 in _columns(mask, 0.98 * height):
        if y1 - y0 < DIGIT_MIN_HEIGHT * height or x1 - x0 > 0.9 * height:
            continue  # separator, speck, or a bezel line along the band
        patch, on = gray[y0:y1, x0:x1].astype(np.float32), mask[y0:y1, x0:x1] > 0
        if on.all() or not on.any():
            continue
        cells.append((x0, y0, x1, y1))
        contrasts.append(sign * (patch[on].mean() - np.median(patch[~on])))
    if not cells:
        return []
    # Gaps between drums and reflections pass the adaptive threshold but are
    # much fainter than the digits.
    top = max(contrasts)
    return [c for c, k in zip(cells, contrasts, strict=True) if k >= MIN_CONTRAST * top]
