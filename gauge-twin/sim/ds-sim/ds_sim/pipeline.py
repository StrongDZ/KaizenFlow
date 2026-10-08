"""Turns one camera frame into a FrameResult."""

from __future__ import annotations

import cv2
import numpy as np
from denso.gauge.v1 import frame_result_pb2

from ds_sim import measure
from ds_sim.inference import Models
from ds_sim.station import DIAL_TYPE, StationConfig


def _add_rois(
    result: frame_result_pb2.FrameResult,
    config: StationConfig,
    frame: np.ndarray,
    models: Models,
    drift: tuple[bool, float],
    camera_url: str | None,
) -> None:
    """Runs both models on the gauges of one machine that are on this camera
    (on any camera when camera_url is None)."""
    height, width = frame.shape[:2]
    for gauge in config.gauges:
        if camera_url is not None and gauge.camera_url != camera_url:
            continue
        x, y, w, h = gauge.roi
        if w <= 0 or h <= 0 or x < 0 or y < 0 or x + w > width or y + h > height:
            continue  # the roi does not fit this frame; edge-agent reports the gauge as stale
        roi = result.rois.add(
            gauge_id=gauge.gauge_id,
            machine_id=config.machine_id,
            roi_drift=drift[0],
            drift_px=drift[1],
        )
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


def process_camera_frame(
    configs: list[StationConfig],
    camera_url: str,
    frame: np.ndarray,
    ts_ms: int,
    models: Models,
    drift: tuple[bool, float] = (False, 0.0),
) -> frame_result_pb2.FrameResult:
    """Reads, on one frame of one camera, the gauges of every machine that has
    some on it. Each ROI carries its machine.

    Keypoints are reported in pixels of the camera frame; no business logic
    happens here, edge-agent does the decoding.
    """
    result = frame_result_pb2.FrameResult(camera_id=camera_url, frame_ts_ms=ts_ms)
    for config in configs:
        _add_rois(result, config, frame, models, drift, camera_url)
    return result


def process_frame(
    config: StationConfig,
    frame: np.ndarray,
    ts_ms: int,
    models: Models,
    drift: tuple[bool, float] = (False, 0.0),
) -> frame_result_pb2.FrameResult:
    """Reads every gauge of one config on one frame, whatever its camera: the
    commissioning preview works on a single frame of a draft config."""
    result = frame_result_pb2.FrameResult(camera_id=config.machine_id, frame_ts_ms=ts_ms)
    _add_rois(result, config, frame, models, drift, None)
    return result


# Size and quality of the image sent while somebody watches a camera: enough
# to see the gauges and their readings, small enough for MQTT.
PREVIEW_MAX_WIDTH = 960
PREVIEW_JPEG_QUALITY = 70


def attach_preview(result: frame_result_pb2.FrameResult, frame: np.ndarray) -> None:
    """Adds the frame, scaled down and JPEG-encoded, to its FrameResult,
    together with the size of the original (the ROI coordinates are in it)."""
    height, width = frame.shape[:2]
    result.frame_width, result.frame_height = width, height
    if width > PREVIEW_MAX_WIDTH:
        scale = PREVIEW_MAX_WIDTH / width
        frame = cv2.resize(
            frame, (PREVIEW_MAX_WIDTH, round(height * scale)), interpolation=cv2.INTER_AREA
        )
    ok, encoded = cv2.imencode(".jpg", frame, [cv2.IMWRITE_JPEG_QUALITY, PREVIEW_JPEG_QUALITY])
    if ok:
        result.preview_jpeg = encoded.tobytes()
