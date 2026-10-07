"""Tests of preview-svc over real HTTP, with stub models and no camera."""

import base64
import json
import threading
import urllib.error
import urllib.request
from http.server import ThreadingHTTPServer

import cv2
import numpy as np
import pytest
from ds_sim import preview
from test_ds_sim import StubModels, textured

CONFIG = {
    "machine_id": "machine_001",
    "camera": {"url": "rtsp://mediamtx:8554/machine_001"},
    "gauges": [
        {
            "gauge_id": "DIAL",
            "type": "analog_dial",
            "roi": [100, 50, 200, 200],
            "quad": [[100, 50], [300, 50], [300, 250], [100, 250]],
        },
        {"gauge_id": "VOLT", "type": "seg7", "roi": [400, 60, 128, 48], "calib": {"digits": 4}},
    ],
}


def jpeg_b64(image) -> str:
    return base64.b64encode(cv2.imencode(".jpg", image)[1].tobytes()).decode()


@pytest.fixture
def service():
    svc = preview.Preview(StubModels(), grab_timeout_s=1)
    server = ThreadingHTTPServer(("127.0.0.1", 0), preview.make_handler(svc))
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    yield svc, f"http://127.0.0.1:{server.server_address[1]}"
    server.shutdown()
    server.server_close()


def call(base, path, body=None):
    data = None if body is None else json.dumps(body).encode()
    request = urllib.request.Request(
        base + path, data=data, headers={"Content-Type": "application/json"}
    )
    try:
        with urllib.request.urlopen(request, timeout=10) as response:
            raw = response.read()
            return response.status, (
                json.loads(raw)
                if response.headers["Content-Type"] == "application/json"
                else raw.decode()
            )
    except urllib.error.HTTPError as err:
        return err.code, json.loads(err.read())


def test_infer_returns_the_frame_result_of_the_draft_config(service):
    _, base = service
    code, body = call(base, "/v1/infer", {"config": CONFIG, "frame_jpeg": jpeg_b64(textured())})

    assert code == 200
    result = body["frame_result"]
    assert result["camera_id"] == "machine_001"
    dial, volt = result["rois"]
    assert dial["gauge_id"] == "DIAL" and len(dial["keypoints"]) == 5
    assert dial["keypoints"][0] == {"x": 200.0, "y": 150.0}
    assert volt["gauge_id"] == "VOLT" and len(volt["slot_probs"]) == 4
    assert "frame_jpeg" not in body  # the caller's frame is not sent back


def test_rectify_maps_the_quad_onto_the_square_of_the_calib_points(service):
    _, base = service
    frame = np.zeros((480, 640, 3), np.uint8)
    frame[50:250, 100:300] = (0, 0, 255)  # the gauge face, red
    frame[50:60, 100:110] = (255, 0, 0)  # its top-left corner, blue
    code, body = call(
        base,
        "/v1/rectify",
        {
            "frame_jpeg": jpeg_b64(frame),
            "size": 128,
            "quad": [
                {"x": 100, "y": 50},
                {"x": 300, "y": 50},
                {"x": 300, "y": 250},
                {"x": 100, "y": 250},
            ],
        },
    )

    assert code == 200
    image = cv2.imdecode(
        np.frombuffer(base64.b64decode(body["image_jpeg"]), np.uint8), cv2.IMREAD_COLOR
    )
    assert image.shape == (128, 128, 3)
    assert image[64, 64, 2] > 200 and image[64, 64, 0] < 60  # centre is the red face
    assert image[2, 2, 0] > 200  # top-left corner landed at the origin


def test_bad_requests_are_400_and_camera_failures_502(service):
    svc, base = service
    assert (
        call(base, "/v1/infer", {"config": {"gauges": []}, "frame_jpeg": jpeg_b64(textured())})[0]
        == 400
    )
    assert call(base, "/v1/rectify", {"frame_jpeg": "not base64!", "quad": []})[0] == 400
    assert (
        call(base, "/v1/rectify", {"frame_jpeg": jpeg_b64(textured()), "quad": [[0, 0]]})[0] == 400
    )
    # Only RTSP: the service must not become a proxy to arbitrary URLs.
    code, body = call(base, "/v1/frame", {"url": "http://example.com/x"})
    assert code == 400 and "rtsp" in body["error"]
    code, _ = call(base, "/v1/frame", {"url": "rtsp://127.0.0.1:1/none"})
    assert code == 502

    code, text = call(base, "/metrics")
    assert (
        code == 200 and 'preview_requests_total{route="/v1/frame",result="unavailable"} 1' in text
    )
    assert call(base, "/healthz")[0] == 200
    svc.models = None
    assert call(base, "/healthz")[0] == 503
