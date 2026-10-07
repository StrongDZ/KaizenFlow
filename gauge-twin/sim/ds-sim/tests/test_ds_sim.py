"""Unit tests of ds-sim that need no model files."""

import json

import cv2
import numpy as np
import pytest
from ds_sim import measure, pipeline, preprocess, station

DIAL_SPEC = {
    "model": "dial_pose",
    "source": "roi_crop",
    "color": "RGB",
    "input": {"name": "crops", "width": 256, "height": 256},
    "resize": {"mode": "stretch", "interpolation": "area"},
    "scale": 1 / 255,
    "mean": [0, 0, 0],
    "std": [1, 1, 1],
}
DIGIT_SPEC = {
    "model": "digit_cls",
    "source": "quad_warp_slots",
    "color": "GRAY",
    "input": {"name": "slots", "width": 32, "height": 48},
    "gray_weights_bgr": [0.114, 0.587, 0.299],
    "resize": {"mode": "perspective_warp", "interpolation": "linear"},
    "scale": 1 / 255,
    "mean": [0],
    "std": [1],
}


def textured(height=480, width=640, seed=0) -> np.ndarray:
    rng = np.random.default_rng(seed)
    image = rng.integers(0, 255, (height // 8, width // 8, 3), dtype=np.uint8)
    return cv2.resize(image, (width, height), interpolation=cv2.INTER_NEAREST)


def test_spec_validation_rejects_what_ds_sim_cannot_reproduce(tmp_path):
    path = tmp_path / "spec.json"
    path.write_text(json.dumps(DIAL_SPEC))
    assert preprocess.load_spec(path)["color"] == "RGB"
    for key, value in (
        ("color", "BGR"),
        ("resize", {"mode": "letterbox", "interpolation": "area"}),
        ("resize", {"mode": "stretch", "interpolation": "lanczos"}),
    ):
        path.write_text(json.dumps(DIAL_SPEC | {key: value}))
        with pytest.raises(ValueError):
            preprocess.load_spec(path)
    path.write_text(json.dumps(DIGIT_SPEC | {"gray_weights_bgr": [1 / 3, 1 / 3, 1 / 3]}))
    with pytest.raises(ValueError):
        preprocess.load_spec(path)


def test_roi_crop_and_tensor_follow_the_spec():
    frame = textured()
    crop = preprocess.roi_crop(frame, [100, 50, 200, 120], DIAL_SPEC)
    assert crop.shape == (256, 256, 3)
    batch = preprocess.to_tensor(crop[None], DIAL_SPEC)
    assert batch.shape == (1, 3, 256, 256) and batch.dtype == np.float32
    # Channel 0 of the tensor is red, which is channel 2 of the BGR image.
    assert np.allclose(batch[0, 0], crop[:, :, 2] / 255, atol=1e-6)
    shifted = preprocess.to_tensor(
        crop[None], DIAL_SPEC | {"mean": [0.5, 0.5, 0.5], "std": [0.25, 0.25, 0.25]}
    )
    assert np.allclose(shifted, (batch - 0.5) / 0.25, atol=1e-5)


def test_quad_slots_cut_the_quad_evenly():
    frame = np.zeros((100, 400, 3), np.uint8)
    for i in range(4):
        frame[20:80, 40 + i * 80 : 120 + i * 80] = 60 * i + 30
    quad = np.array([[40, 20], [360, 20], [360, 80], [40, 80]], dtype=np.float64)

    slots = preprocess.quad_slots(frame, quad, 4, DIGIT_SPEC)

    assert slots.shape == (4, 48, 32) and slots.dtype == np.uint8
    for i in range(4):
        assert abs(float(slots[i, 5:-5, 3:-3].mean()) - (60 * i + 30)) < 2
    assert preprocess.to_tensor(slots, DIGIT_SPEC).shape == (4, 1, 48, 32)


def test_sharpness_drops_with_blur_and_glare_counts_saturated_pixels():
    gray = cv2.cvtColor(textured(), cv2.COLOR_BGR2GRAY)
    assert measure.sharpness(gray) > 5 * measure.sharpness(cv2.GaussianBlur(gray, (0, 0), 3))
    flat = np.full((10, 10), 100, np.uint8)
    flat[:2] = 255
    assert measure.glare_ratio(flat) == pytest.approx(0.2)


def test_drift_detector_measures_a_shifted_camera():
    frame = cv2.GaussianBlur(textured(720, 1280), (0, 0), 1.5)
    detector = measure.DriftDetector(interval_s=10, threshold_px=8)
    assert detector.update(frame, now_s=0.0) == (False, 0.0)  # becomes the reference
    assert detector.update(frame, now_s=5.0) == (False, 0.0)  # not due yet

    drifted, pixels = detector.update(frame, now_s=11.0)
    assert not drifted and pixels < 1.0

    shift = np.float32([[1, 0, 20], [0, 1, -12]])
    moved = cv2.warpAffine(frame, shift, (1280, 720), borderMode=cv2.BORDER_REFLECT)
    drifted, pixels = detector.update(moved, now_s=22.0)
    assert drifted and abs(pixels - np.hypot(20, 12)) < 3.0


def test_station_config_accepts_both_quad_forms(tmp_path):
    config = {
        "config_version": 7,
        "machine_id": "machine_001",
        "camera": {"url": "rtsp://mediamtx:8554/machine_001", "sample_fps": 2},
        "gauges": [
            {
                "gauge_id": "A",
                "type": "analog_dial",
                "roi": [10, 20, 100, 100],
                "quad": [
                    {"x": 12, "y": 22},
                    {"x": 108, "y": 24},
                    {"x": 106, "y": 118},
                    {"x": 14, "y": 116},
                ],
            },
            {
                "gauge_id": "B",
                "type": "seg7",
                "roi": [200, 20, 128, 48],
                "quad": [[200, 20], [328, 20], [328, 68], [200, 68]],
                "calib": {"digits": 4},
            },
            {
                "gauge_id": "C",
                "type": "rolling_counter",
                "roi": [200, 100, 192, 48],
                "calib": {"digits": 6},
            },
        ],
    }
    path = tmp_path / "machine_001.json"
    path.write_text(json.dumps(config))

    loaded = station.load(path)

    assert (loaded.machine_id, loaded.config_version, loaded.sample_fps) == ("machine_001", 7, 2.0)
    assert loaded.gauges[0].quad.tolist()[0] == [12, 22]
    assert loaded.gauges[1].quad.tolist()[2] == [328, 68] and loaded.gauges[1].digits == 4
    # No quad: the roi corners, TL, TR, BR, BL.
    assert loaded.gauges[2].quad.tolist() == [[200, 100], [392, 100], [392, 148], [200, 148]]

    config["gauges"][0]["type"] = "sundial"
    path.write_text(json.dumps(config))
    with pytest.raises(ValueError):
        station.load(path)


class StubModels:
    """Stands in for the ONNX models: fixed keypoints and uniform probabilities."""

    def dial_keypoints(self, frame, roi):
        x, y, w, h = roi
        points = np.array([[x + w / 2, y + h / 2]] * 5)
        return points, np.full(5, 0.9)

    def digit_probabilities(self, frame, quad, digits):
        return np.full((digits, 12), 1 / 12)


def test_station_config_reads_quad_corners_on_the_frame_edge():
    # edge-agent writes proto3 JSON, which omits zero coordinates: a roi that
    # is the whole frame has its corners at x = 0 and y = 0.
    config = station.parse(
        {
            "machine_id": "pump",
            "gauges": [
                {
                    "gauge_id": "P",
                    "type": "analog_dial",
                    "roi": [0, 0, 512, 512],
                    "quad": [{}, {"x": 512}, {"x": 512, "y": 512}, {"y": 512}],
                }
            ],
        }
    )
    assert config.gauges[0].quad.tolist() == [[0, 0], [512, 0], [512, 512], [0, 512]]


def test_process_frame_builds_a_frame_result_in_frame_pixels(tmp_path):
    config = station.StationConfig(
        machine_id="machine_001",
        config_version=7,
        camera_url="",
        sample_fps=2,
        gauges=[
            station.Gauge("DIAL", "analog_dial", [100, 50, 200, 200], np.zeros((4, 2)), 0),
            station.Gauge(
                "VOLT",
                "seg7",
                [400, 60, 128, 48],
                np.array([[400, 60], [528, 60], [528, 108], [400, 108]]),
                4,
            ),
            station.Gauge("OUTSIDE", "seg7", [600, 460, 128, 48], np.zeros((4, 2)), 4),
        ],
    )
    frame = textured()

    result = pipeline.process_frame(
        config, frame, 1_700_000_000_123, StubModels(), drift=(True, 9.5)
    )

    assert result.camera_id == "machine_001" and result.frame_ts_ms == 1_700_000_000_123
    # The roi that does not fit the 640x480 frame is left out.
    assert [roi.gauge_id for roi in result.rois] == ["DIAL", "VOLT"]
    dial, volt = result.rois
    assert len(dial.keypoints) == 5 and (dial.keypoints[0].x, dial.keypoints[0].y) == (200.0, 150.0)
    assert len(dial.kp_conf) == 5 and len(dial.slot_probs) == 0
    assert (
        len(volt.slot_probs) == 4
        and len(volt.slot_probs[0].probs) == 12
        and len(volt.keypoints) == 0
    )
    assert dial.sharpness > 0 and 0 <= dial.glare_ratio <= 1
    assert volt.roi_drift and volt.drift_px == pytest.approx(9.5)
