"""preview-svc: the commissioning helper behind config-api.

Runs the inference of ds-sim (same models, same preprocess.json) on single
frames, so the commissioning page shows what the edge will see. It only
produces raw model output; config-api decodes it with the decoder edge-agent
uses. Internal service: no port is published outside the Docker network.

Entry point: python -m ds_sim.preview. Configuration from the environment:
MODEL_DIR, HTTP_ADDR (default :8080), GRAB_TIMEOUT_S (default 10),
INFERENCE_THREADS (default 2).
"""

from __future__ import annotations

import base64
import json
import os
import signal
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlparse

import cv2
import numpy as np
from google.protobuf import json_format

from ds_sim import station
from ds_sim.pipeline import process_frame

MAX_BODY = 32 << 20
ALLOWED_SCHEMES = ("rtsp", "rtsps")


def log(level: str, message: str, **fields) -> None:
    record = {
        "time": time.strftime("%Y-%m-%dT%H:%M:%S%z"),
        "level": level,
        "service": "preview-svc",
        "msg": message,
    }
    print(json.dumps(record | fields), flush=True)


class BadRequest(ValueError):
    """The request cannot be served as sent (HTTP 400)."""


class Unavailable(RuntimeError):
    """The camera or the models cannot be reached now (HTTP 502/503)."""


def encode_jpeg(image: np.ndarray, quality: int = 90) -> bytes:
    ok, data = cv2.imencode(".jpg", image, [cv2.IMWRITE_JPEG_QUALITY, quality])
    if not ok:
        raise RuntimeError("JPEG encoding failed")
    return data.tobytes()


def decode_jpeg(b64: str) -> np.ndarray:
    try:
        data = np.frombuffer(base64.b64decode(b64, validate=True), dtype=np.uint8)
    except (ValueError, TypeError) as err:
        raise BadRequest("frame_jpeg is not base64") from err
    frame = cv2.imdecode(data, cv2.IMREAD_COLOR)
    if frame is None:
        raise BadRequest("frame_jpeg is not an image")
    return frame


def grab(url: str, timeout_s: float) -> np.ndarray:
    """Reads one decoded frame from an RTSP stream."""
    if urlparse(url).scheme not in ALLOWED_SCHEMES:
        raise BadRequest(
            f"camera url must start with {' or '.join(s + '://' for s in ALLOWED_SCHEMES)}"
        )
    params = [
        cv2.CAP_PROP_OPEN_TIMEOUT_MSEC,
        int(timeout_s * 1000),
        cv2.CAP_PROP_READ_TIMEOUT_MSEC,
        int(timeout_s * 1000),
    ]
    capture = cv2.VideoCapture(url, cv2.CAP_FFMPEG, params)
    try:
        if not capture.isOpened():
            raise Unavailable(f"cannot open {url}")
        ok, frame = capture.read()
        if not ok or frame is None:
            raise Unavailable(f"no frame from {url}")
        return frame
    finally:
        capture.release()


def rectify(frame: np.ndarray, quad: list, size: int) -> np.ndarray:
    """Warps the quad (TL, TR, BR, BL) onto a size x size square: the space calib points live in."""
    points = station._points(quad)
    if points.shape != (4, 2):
        raise BadRequest("quad must have 4 points")
    if not 16 <= size <= 2048:
        raise BadRequest("size must be between 16 and 2048")
    dst = np.array([[0, 0], [size, 0], [size, size], [0, size]], dtype=np.float32)
    matrix = cv2.getPerspectiveTransform(points.astype(np.float32), dst)
    return cv2.warpPerspective(frame, matrix, (size, size), flags=cv2.INTER_LINEAR)


class Preview:
    """The operations of the service, independent of HTTP."""

    def __init__(self, models, grab_timeout_s: float = 10.0) -> None:
        self.models = models
        self.grab_timeout_s = grab_timeout_s
        self.lock = threading.Lock()
        self.counts: dict[str, int] = {}

    def count(self, name: str) -> None:
        with self.lock:
            self.counts[name] = self.counts.get(name, 0) + 1

    def frame(self, body: dict) -> dict:
        frame = grab(str(body.get("url", "")), self.grab_timeout_s)
        height, width = frame.shape[:2]
        return {
            "frame_jpeg": base64.b64encode(encode_jpeg(frame)).decode(),
            "width": width,
            "height": height,
            "ts_ms": time.time_ns() // 1_000_000,
        }

    def rectify(self, body: dict) -> dict:
        frame = decode_jpeg(str(body.get("frame_jpeg", "")))
        image = rectify(frame, body.get("quad") or [], int(body.get("size", 256)))
        return {"image_jpeg": base64.b64encode(encode_jpeg(image)).decode()}

    def infer(self, body: dict) -> dict:
        """Runs the models on a frame for a draft config; grabs a fresh frame when none is given."""
        try:
            config = station.parse(body["config"])
        except (KeyError, TypeError, ValueError) as err:
            raise BadRequest(f"config: {err}") from err
        out: dict = {}
        if body.get("frame_jpeg"):
            frame = decode_jpeg(str(body["frame_jpeg"]))
        else:
            url = str(body.get("url") or config.camera_url)
            frame = grab(url, self.grab_timeout_s)
            out["frame_jpeg"] = base64.b64encode(encode_jpeg(frame)).decode()
        if self.models is None:
            raise Unavailable("models are not loaded")
        result = process_frame(config, frame, time.time_ns() // 1_000_000, self.models)
        out["frame_result"] = json_format.MessageToDict(result, preserving_proto_field_name=True)
        return out


def make_handler(preview: Preview):
    routes = {
        "/v1/frame": preview.frame,
        "/v1/rectify": preview.rectify,
        "/v1/infer": preview.infer,
    }

    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *_args) -> None:  # requests are logged as JSON below
            pass

        def reply(
            self, code: int, body: dict | str, content_type: str = "application/json"
        ) -> None:
            data = (json.dumps(body) if isinstance(body, dict) else body).encode()
            self.send_response(code)
            self.send_header("Content-Type", content_type)
            self.send_header("Content-Length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)

        def do_GET(self) -> None:
            if self.path == "/healthz":
                if preview.models is None:
                    self.reply(503, {"status": "models not loaded"})
                else:
                    self.reply(200, {"status": "ok"})
            elif self.path == "/metrics":
                with preview.lock:
                    counts = dict(preview.counts)
                lines = [
                    "# HELP preview_requests_total Requests by route and result.",
                    "# TYPE preview_requests_total counter",
                ]
                for key, value in sorted(counts.items()):
                    route, result = key.split("|")
                    lines.append(
                        f'preview_requests_total{{route="{route}",result="{result}"}} {value}'
                    )
                self.reply(200, "\n".join(lines) + "\n", "text/plain; version=0.0.4")
            else:
                self.reply(404, {"error": "not found"})

        def do_POST(self) -> None:
            route = routes.get(self.path)
            if route is None:
                self.reply(404, {"error": "not found"})
                return
            started = time.monotonic()
            result = "ok"
            try:
                length = int(self.headers.get("Content-Length", "0"))
                if length > MAX_BODY:
                    raise BadRequest("body too large")
                try:
                    body = json.loads(self.rfile.read(length) or b"{}")
                except json.JSONDecodeError as err:
                    raise BadRequest(f"invalid JSON: {err}") from err
                if not isinstance(body, dict):
                    raise BadRequest("body must be a JSON object")
                self.reply(200, route(body))
            except BadRequest as err:
                result = "bad_request"
                self.reply(400, {"error": str(err)})
            except Unavailable as err:
                result = "unavailable"
                self.reply(502, {"error": str(err)})
            except Exception as err:  # noqa: BLE001 - reported to the caller, logged in full
                result = "error"
                log("error", "request failed", path=self.path, error=repr(err))
                self.reply(500, {"error": "internal error"})
            preview.count(f"{self.path}|{result}")
            log(
                "info",
                "request",
                path=self.path,
                result=result,
                ms=round((time.monotonic() - started) * 1000),
            )

    return Handler


def main() -> int:
    from ds_sim.inference import Models

    models = None
    try:
        models = Models(
            Path(os.environ.get("MODEL_DIR", "/models")),
            int(os.environ.get("INFERENCE_THREADS", "2")),
        )
    except FileNotFoundError as err:
        log("error", "models not loaded; /v1/infer and /healthz will fail", error=str(err))
    preview = Preview(models, float(os.environ.get("GRAB_TIMEOUT_S", "10")))
    host, _, port = os.environ.get("HTTP_ADDR", ":8080").rpartition(":")
    server = ThreadingHTTPServer((host or "0.0.0.0", int(port)), make_handler(preview))
    stop = threading.Event()

    def shutdown(*_args) -> None:
        if not stop.is_set():
            stop.set()
            threading.Thread(target=server.shutdown, daemon=True).start()

    signal.signal(signal.SIGTERM, shutdown)
    signal.signal(signal.SIGINT, shutdown)
    log("info", "starting", addr=os.environ.get("HTTP_ADDR", ":8080"))
    server.serve_forever()
    server.server_close()
    log("info", "stopped")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
