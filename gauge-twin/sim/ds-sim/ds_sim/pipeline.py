"""Turns one camera frame into a FrameResult."""

from __future__ import annotations

import cv2
import numpy as np
from denso.gauge.v1 import frame_result_pb2

from ds_sim import measure
from ds_sim.inference import Models
from ds_sim.station import DIAL_TYPE, StationConfig


def process_frame(
    config: StationConfig,
    frame: np.ndarray,
    ts_ms: int,
    models: Models,
    drift: tuple[bool, float] = (False, 0.0),
) -> frame_result_pb2.FrameResult:
    """Runs both models on every gauge of the station.

    Keypoints are reported in pixels of the camera frame; no business logic
    happens here, edge-agent does the decoding.
    """
    result = frame_result_pb2.FrameResult(camera_id=config.machine_id, frame_ts_ms=ts_ms)
    height, width = frame.shape[:2]
    for gauge in config.gauges:
        x, y, w, h = gauge.roi
        if w <= 0 or h <= 0 or x < 0 or y < 0 or x + w > width or y + h > height:
            continue  # the roi does not fit this frame; edge-agent reports the gauge as stale
        roi = result.rois.add(gauge_id=gauge.gauge_id, roi_drift=drift[0], drift_px=drift[1])
        gray = cv2.cvtColor(frame[y : y + h, x : x + w], cv2.COLOR_BGR2GRAY)
        roi.sharpness = measure.sharpness(gray)
        roi.glare_ratio = measure.glare_ratio(gray)
        if gauge.type == DIAL_TYPE:
            keypoints, confidence = models.dial_keypoints(frame, gauge.roi)
            for px, py in keypoints:
                roi.keypoints.add(x=float(px), y=float(py))
            roi.kp_conf.extend(float(c) for c in confidence)
        else:
            for probabilities in models.digit_probabilities(frame, gauge.quad, gauge.digits):
                roi.slot_probs.add(probs=[float(p) for p in probabilities])
    return result
