"""Image statistics sent with every ROI, and the periodic ROI drift check."""

from __future__ import annotations

import cv2
import numpy as np

SATURATED = 250  # 8-bit level from which a pixel counts as blown out


def sharpness(gray_roi: np.ndarray) -> float:
    """Variance of the Laplacian: low for a blurred image."""
    return float(cv2.Laplacian(gray_roi, cv2.CV_64F).var())


def glare_ratio(gray_roi: np.ndarray) -> float:
    """Share of saturated pixels, in [0, 1]."""
    return float((gray_roi >= SATURATED).mean())


class DriftDetector:
    """Compares the current frame with a reference image using ORB features.

    The reference is the first frame seen after a config (re)load. The drift
    is the median displacement of the matched features, in pixels.
    """

    def __init__(self, interval_s: float, threshold_px: float, max_width: int = 960) -> None:
        self.interval_s, self.threshold_px, self.max_width = interval_s, threshold_px, max_width
        self.orb = cv2.ORB_create(nfeatures=1000)
        self.matcher = cv2.BFMatcher(cv2.NORM_HAMMING, crossCheck=True)
        self.reference: tuple[list, np.ndarray] | None = None
        self.scale = 1.0
        self.last_check_s = 0.0
        self.drift_px = 0.0
        self.drifted = False

    def _features(self, frame: np.ndarray) -> tuple[list, np.ndarray | None]:
        gray = cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY)
        self.scale = min(1.0, self.max_width / gray.shape[1])
        if self.scale < 1.0:
            gray = cv2.resize(
                gray, None, fx=self.scale, fy=self.scale, interpolation=cv2.INTER_AREA
            )
        return self.orb.detectAndCompute(gray, None)

    def update(self, frame: np.ndarray, now_s: float) -> tuple[bool, float]:
        """Runs the check when it is due and returns (drifted, drift in pixels)."""
        if self.reference is None:
            keypoints, descriptors = self._features(frame)
            if descriptors is not None and len(keypoints) >= 20:
                self.reference = (keypoints, descriptors)
                self.last_check_s = now_s
            return self.drifted, self.drift_px
        if now_s - self.last_check_s < self.interval_s:
            return self.drifted, self.drift_px
        self.last_check_s = now_s
        keypoints, descriptors = self._features(frame)
        if descriptors is None:
            return self.drifted, self.drift_px
        matches = self.matcher.match(self.reference[1], descriptors)
        if len(matches) < 20:
            return self.drifted, self.drift_px
        shifts = np.array(
            [
                np.subtract(keypoints[m.trainIdx].pt, self.reference[0][m.queryIdx].pt)
                for m in matches
            ]
        )
        self.drift_px = float(np.linalg.norm(np.median(shifts, axis=0)) / self.scale)
        self.drifted = self.drift_px > self.threshold_px
        return self.drifted, self.drift_px
