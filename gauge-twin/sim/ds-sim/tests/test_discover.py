"""discover-svc without the detector.

A fake detector and fake models stand in for OWLv2 and the ONNX models.
"""

import base64
import threading

import cv2
import numpy as np
from ds_sim import discover
from ds_sim.discover import Found


class FakeModels:
    """dial_pose answers fixed keypoints; digit_cls is sure only with four slots."""

    def dial_keypoints(self, frame, roi):
        x, y, w, h = roi
        points = np.array(
            [
                [x + w / 2, y + h / 2],
                [x + w / 4, y + h * 0.75],
                [x + w * 0.75, y + h * 0.75],
                [x + w / 2, y],
                [x, y],
            ]
        )
        return points, np.array([0.9, 0.8, 0.7, 0.9, 0.9])

    def digit_probabilities(self, frame, quad, digits):
        p = np.full((digits, 12), 0.05)
        p[:, 3] = 0.9 if digits == 4 else 0.4
        return p


def test_nms_keeps_the_best_of_overlapping_boxes_whatever_query_found_them():
    found = [
        Found((0, 0, 100, 100), 0.3, 0),
        Found((5, 5, 100, 100), 0.5, 1),
        Found((300, 0, 400, 100), 0.2, 2),
    ]
    kept = discover.nms(found)
    assert [(f.score, f.query) for f in kept] == [(0.5, 1), (0.2, 2)]


def test_to_roi_clips_to_the_frame_and_drops_slivers():
    assert discover.to_roi((-10.4, 20.6, 110.2, 90.0), 100, 80) == [0, 21, 100, 59]
    assert discover.to_roi((10, 10, 15, 100), 100, 100) is None
    assert discover.to_roi((80, 80, 140, 140), 100, 100) is None  # mostly outside


def test_to_calib_maps_the_roi_onto_the_256_square():
    assert discover.to_calib(np.array([150.0, 50.0]), [100, 0, 100, 200]) == [128.0, 64.0]


def test_guess_digits_prefers_the_count_the_model_is_surest_about():
    m = FakeModels()
    assert (
        discover.guess_digits({n: m.digit_probabilities(None, None, n) for n in range(3, 7)}) == 4
    )


def test_guess_colour_from_the_brightest_pixels():
    def display(bgr):
        image = np.full((40, 120, 3), 20, np.uint8)
        image[10:30, 10:110] = bgr
        return image

    assert discover.guess_colour(display((40, 40, 250))) == "red_led"
    assert discover.guess_colour(display((60, 230, 60))) == "green_led"
    assert discover.guess_colour(display((200, 210, 205))) == "lcd"


def test_scan_builds_the_payload_config_api_expects():
    frame = np.zeros((480, 640, 3), np.uint8)
    cv2.circle(frame, (160, 240), 100, (255, 255, 255), -1)

    def detector(image):
        assert image.shape == (480, 640, 3)
        return [
            Found((60, 140, 260, 340), 0.45, 0),  # a dial
            Found((62, 142, 258, 338), 0.30, 1),  # the same dial again, worse
            Found((400, 200, 600, 260), 0.25, 3),  # an LCD display
            Found((630, 470, 700, 520), 0.9, 2),  # mostly outside the frame
        ]

    payload = discover.scan("cam-1", frame, detector, FakeModels())
    assert (payload["camera_id"], payload["width"], payload["height"]) == ("cam-1", 640, 480)
    dial, lcd = payload["detections"]
    assert (
        dial["roi"] == [60, 140, 200, 200]
        and dial["type"] == "analog_dial"
        and dial["score"] == 0.45
    )
    assert (
        dial["hint"]["center"] == [128.0, 128.0]
        and dial["hint"]["min_pt"] == [64.0, 192.0]
        and dial["hint"]["confidence"] == 0.7
    )
    assert lcd["type"] == "seg7" and lcd["hint"] == {"digits": 4, "color": "lcd"}
    crop = cv2.imdecode(
        np.frombuffer(base64.b64decode(dial["crop_jpeg"]), np.uint8), cv2.IMREAD_COLOR
    )
    assert crop.shape[:2] == (200, 200)


def test_scan_without_models_sends_the_detections_without_hints():
    frame = np.zeros((100, 100, 3), np.uint8)
    payload = discover.scan("cam-1", frame, lambda _: [Found((10, 10, 60, 60), 0.4, 4)], None)
    assert (
        payload["detections"][0]["type"] == "rolling_counter"
        and payload["detections"][0]["hint"] == {}
    )


def test_a_failing_camera_does_not_stop_the_others(monkeypatch):
    posted = []

    class Api:
        def cameras(self):
            return [
                {"camera_id": "dead", "url": "rtsp://dead"},
                {"camera_id": "ok", "url": "rtsp://ok"},
            ]

        def post_scan(self, payload):
            posted.append(payload["camera_id"])
            return {"new": 0}

        def last_scans(self):
            raise OSError("config-api down")

    def grab(url, timeout_s):
        if "dead" in url:
            raise RuntimeError("cannot open")
        return np.zeros((50, 50, 3), np.uint8)

    monkeypatch.setattr(discover, "grab", grab)
    assert discover.scan_all(Api(), lambda _: [], None, 1.0, threading.Event()) == 1
    assert posted == ["ok"]


def test_cameras_scanned_longest_ago_come_first():
    cameras = [{"camera_id": c} for c in ("a", "b", "c", "d")]
    last = {"a": "2026-10-10T08:05:00Z", "b": "2026-10-10T08:01:00Z", "d": "2026-10-10T08:03:00Z"}
    assert [c["camera_id"] for c in discover.scan_order(cameras, last)] == ["c", "b", "d", "a"]
