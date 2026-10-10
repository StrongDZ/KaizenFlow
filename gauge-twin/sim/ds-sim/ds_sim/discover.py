"""discover-svc: finds gauges on the frames of the registered cameras.

Every DISCOVER_INTERVAL seconds it takes one frame of every camera of the
config-api registry, runs an open-vocabulary detector (OWLv2) asking for dials,
digit displays and counters, and posts what it found to config-api, which
keeps a detection where no gauge is declared as a candidate for a person to
check. For each detection it suggests what the commissioning form needs: the
gauge type, for a dial the centre and the two ends of the scale (dial_pose
model), for a display the digit count (digit_cls model) and the colour.

Nothing found here is read as a measurement until a person saves it.

Entry point: python -m ds_sim.discover. Configuration from the environment:
CONFIG_API_URL (default http://config-api:8080), MODEL_DIR (default /models),
DISCOVER_INTERVAL (s, default 300), DETECT_THRESHOLD (default 0.2),
DETECTOR_MODEL (default google/owlv2-base-patch16-ensemble), GRAB_TIMEOUT_S
(default 10), INFERENCE_THREADS (default 2).
"""

from __future__ import annotations

import base64
import json
import os
import signal
import threading
import time
import urllib.request
from dataclasses import dataclass
from pathlib import Path
from typing import Protocol

import cv2
import numpy as np

from ds_sim.inference import Models
from ds_sim.preview import grab

# What the detector is asked for, and the gauge type and colour each answer suggests.
QUERIES: list[tuple[str, str, str | None]] = [
    ("a round pressure gauge with a needle", "analog_dial", None),
    ("an analog dial gauge", "analog_dial", None),
    ("a seven-segment LED display", "seg7", None),
    ("a digital LCD display", "seg7", "lcd"),
    ("a mechanical counter with number wheels", "rolling_counter", None),
    ("an hour meter", "rolling_counter", None),
]

# Square the roi is stretched to before decoding (config.proto: rect_size default);
# calib points live in it.
RECT = 256
# Digit counts tried when guessing the width of a display.
DIGIT_COUNTS = {"seg7": range(3, 7), "rolling_counter": range(5, 9)}
CROP_SIDE = 320
CLASS_BLANK = 10


def log(level: str, message: str, **fields) -> None:
    record = {
        "time": time.strftime("%Y-%m-%dT%H:%M:%S%z"),
        "level": level,
        "service": "discover-svc",
        "msg": message,
    }
    print(json.dumps(record | fields), flush=True)


@dataclass
class Found:
    """One detection in frame pixels: box x0, y0, x1, y1, score, index into QUERIES."""

    box: tuple[float, float, float, float]
    score: float
    query: int


class Detector(Protocol):
    def __call__(self, frame: np.ndarray) -> list[Found]: ...


def light_attention(
    self, hidden_states, attention_mask=None, causal_attention_mask=None, output_attentions=False
):
    """Owlv2Attention.forward through torch's scaled_dot_product_attention.

    The original builds the full (heads, 3601, 3601) weight matrix of a 960 x 960
    image and its softmax copy, about 600 MB more at the peak; this computes the
    same result blockwise (logits within 0.01 on the demo frames).
    """
    import torch

    bsz, tgt_len, embed_dim = hidden_states.size()

    def heads(x):
        return x.view(bsz, -1, self.num_heads, self.head_dim).transpose(1, 2)

    q = heads(self.q_proj(hidden_states) * self.scale)
    k, v = heads(self.k_proj(hidden_states)), heads(self.v_proj(hidden_states))
    mask = None
    for m in (causal_attention_mask, attention_mask):
        if m is not None:
            mask = m if mask is None else mask + m
    out = torch.nn.functional.scaled_dot_product_attention(q, k, v, attn_mask=mask, scale=1.0)
    return self.out_proj(out.transpose(1, 2).reshape(bsz, tgt_len, embed_dim)), None


class OwlDetector:
    """OWLv2 asked for the QUERIES. torch and transformers are imported here only."""

    def __init__(self, model: str, threshold: float, threads: int) -> None:
        import torch
        from transformers import Owlv2ForObjectDetection, Owlv2Processor
        from transformers.models.owlv2 import modeling_owlv2

        modeling_owlv2.Owlv2Attention.forward = light_attention
        torch.set_num_threads(threads)
        self.torch = torch
        self.processor = Owlv2Processor.from_pretrained(model)
        self.model = Owlv2ForObjectDetection.from_pretrained(model).eval()
        self.threshold = threshold
        # The processor method was renamed between transformers releases.
        self.post = (
            getattr(self.processor, "post_process_grounded_object_detection", None)
            or self.processor.post_process_object_detection
        )

    def __call__(self, frame: np.ndarray) -> list[Found]:
        rgb = cv2.cvtColor(frame, cv2.COLOR_BGR2RGB)
        side = max(rgb.shape[:2])
        inputs = self.processor(text=[[q for q, _, _ in QUERIES]], images=rgb, return_tensors="pt")
        with self.torch.inference_mode():
            outputs = self.model(**inputs)
        # OWLv2 pads the image to a square: boxes are relative to the padded side.
        result = self.post(outputs, threshold=self.threshold, target_sizes=[(side, side)])[0]
        return [
            Found(tuple(float(v) for v in b), float(s), int(q))
            for b, s, q in zip(
                result["boxes"].tolist(),
                result["scores"].tolist(),
                result["labels"].tolist(),
                strict=True,
            )
        ]


def iou(a: tuple[float, ...], b: tuple[float, ...]) -> float:
    w = max(0.0, min(a[2], b[2]) - max(a[0], b[0]))
    h = max(0.0, min(a[3], b[3]) - max(a[1], b[1]))
    inter = w * h
    union = (a[2] - a[0]) * (a[3] - a[1]) + (b[2] - b[0]) * (b[3] - b[1]) - inter
    return inter / union if union > 0 else 0.0


def nms(found: list[Found], threshold: float = 0.3) -> list[Found]:
    """Keeps the best of overlapping boxes, whatever query found them."""
    kept: list[Found] = []
    for f in sorted(found, key=lambda f: f.score, reverse=True):
        if all(iou(f.box, k.box) <= threshold for k in kept):
            kept.append(f)
    return kept


def to_roi(box: tuple[float, ...], width: int, height: int) -> list[int] | None:
    """A box as x, y, w, h in whole pixels inside the frame.

    None for a box mostly outside the frame, or too small to read.
    """
    x0, y0 = max(0, int(round(box[0]))), max(0, int(round(box[1])))
    x1, y1 = min(width, int(round(box[2]))), min(height, int(round(box[3])))
    inside = max(0, x1 - x0) * max(0, y1 - y0)
    if x1 - x0 < 8 or y1 - y0 < 8 or inside < 0.5 * (box[2] - box[0]) * (box[3] - box[1]):
        return None
    return [x0, y0, x1 - x0, y1 - y0]


def to_calib(point: np.ndarray, roi: list[int]) -> list[float]:
    """A point of the frame in the RECT square the roi is stretched to (calib coordinates)."""
    x, y, w, h = roi
    return [round(float((point[0] - x) * RECT / w), 1), round(float((point[1] - y) * RECT / h), 1)]


def dial_hint(models: Models, frame: np.ndarray, roi: list[int]) -> dict:
    """Centre and both ends of the scale, from the dial_pose keypoints.

    The keypoints are, in order: center, start, end, mid, tip.
    """
    keypoints, confidence = models.dial_keypoints(frame, roi)
    return {
        "center": to_calib(keypoints[0], roi),
        "min_pt": to_calib(keypoints[1], roi),
        "max_pt": to_calib(keypoints[2], roi),
        "confidence": round(float(np.min(confidence[:3])), 2),
    }


def guess_digits(probabilities_for: dict[int, np.ndarray]) -> int:
    """The digit count whose slots the model is surest about.

    With the right count every slot holds one digit, not half of two.
    """

    def sureness(p: np.ndarray) -> float:
        return float(np.mean(np.max(p, axis=1)))

    return max(probabilities_for, key=lambda n: sureness(probabilities_for[n]))


def guess_colour(crop: np.ndarray) -> str:
    """red_led, green_led or lcd from the hue of the brightest pixels of a display."""
    hsv = cv2.cvtColor(crop, cv2.COLOR_BGR2HSV)
    bright = hsv[hsv[..., 2] >= np.percentile(hsv[..., 2], 90)]
    saturated = bright[bright[..., 1] > 90]
    if len(saturated) < 0.3 * len(bright):
        return "lcd"
    hue = np.median(saturated[:, 0])  # OpenCV hue: 0..180
    if hue < 12 or hue > 165:
        return "red_led"
    if 35 < hue < 90:
        return "green_led"
    return "lcd"


def digit_hint(
    models: Models, frame: np.ndarray, roi: list[int], gauge_type: str, colour: str | None
) -> dict:
    x, y, w, h = roi
    quad = np.array([[x, y], [x + w, y], [x + w, y + h], [x, y + h]], dtype=np.float32)
    probabilities = {
        n: models.digit_probabilities(frame, quad, n) for n in DIGIT_COUNTS[gauge_type]
    }
    hint: dict = {"digits": guess_digits(probabilities)}
    if gauge_type == "seg7":
        hint["color"] = colour or guess_colour(frame[y : y + h, x : x + w])
    return hint


def crop_jpeg(frame: np.ndarray, roi: list[int]) -> str:
    x, y, w, h = roi
    crop = frame[y : y + h, x : x + w]
    scale = min(1.0, CROP_SIDE / max(w, h))
    if scale < 1.0:
        crop = cv2.resize(crop, None, fx=scale, fy=scale, interpolation=cv2.INTER_AREA)
    ok, data = cv2.imencode(".jpg", crop, [cv2.IMWRITE_JPEG_QUALITY, 85])
    if not ok:
        raise RuntimeError("JPEG encoding failed")
    return base64.b64encode(data.tobytes()).decode()


def scan(camera_id: str, frame: np.ndarray, detector: Detector, models: Models | None) -> dict:
    """The scan config-api records.

    Every detection with its region, suggested type, hints and a crop.
    """
    height, width = frame.shape[:2]
    detections = []
    for f in nms(detector(frame)):
        roi = to_roi(f.box, width, height)
        if roi is None:
            continue
        _, gauge_type, colour = QUERIES[f.query]
        hint: dict = {}
        if models is not None:
            try:
                hint = (
                    dial_hint(models, frame, roi)
                    if gauge_type == "analog_dial"
                    else digit_hint(models, frame, roi, gauge_type, colour)
                )
            except Exception as err:  # noqa: BLE001 - a hint is a suggestion; the detection stands without it
                log("WARNING", "no hint", camera_id=camera_id, roi=roi, error=str(err))
        detections.append(
            {
                "roi": roi,
                "type": gauge_type,
                "score": round(f.score, 3),
                "hint": hint,
                "crop_jpeg": crop_jpeg(frame, roi),
            }
        )
    return {"camera_id": camera_id, "width": width, "height": height, "detections": detections}


class ConfigApi:
    def __init__(self, base: str, timeout_s: float = 30.0) -> None:
        self.base, self.timeout_s = base.rstrip("/"), timeout_s

    def _call(self, method: str, path: str, body: dict | None = None) -> dict:
        data = json.dumps(body).encode() if body is not None else None
        headers = {"Content-Type": "application/json"}
        request = urllib.request.Request(self.base + path, data, headers, method=method)
        with urllib.request.urlopen(request, timeout=self.timeout_s) as response:
            return json.loads(response.read() or b"{}")

    def cameras(self) -> list[dict]:
        return self._call("GET", "/v1/cameras")["cameras"]

    def post_scan(self, payload: dict) -> dict:
        return self._call("POST", "/v1/discovery/scans", payload)

    def last_scans(self) -> dict[str, str]:
        """camera_id -> time of its last scan (RFC 3339)."""
        return {
            s["camera_id"]: s["scanned_at"]
            for s in self._call("GET", "/v1/discovery/gauges")["scans"]
        }


def scan_order(cameras: list[dict], last_scans: dict[str, str]) -> list[dict]:
    """Cameras never scanned first, then the ones scanned longest ago: a pass cut short
    (the service restarted) does not keep the same cameras waiting."""
    return sorted(cameras, key=lambda c: last_scans.get(c["camera_id"], ""))


def scan_all(
    api: ConfigApi,
    detector: Detector,
    models: Models | None,
    grab_timeout_s: float,
    stop: threading.Event,
) -> int:
    """One pass over every camera; returns the number scanned.

    A camera that fails does not stop the others.
    """
    done = 0
    try:
        last = api.last_scans()
    except Exception as err:  # noqa: BLE001 - the order is a nicety; scan in registry order
        log("WARNING", "no scan times", error=str(err))
        last = {}
    for camera in scan_order(api.cameras(), last):
        if stop.is_set():
            break
        camera_id = camera["camera_id"]
        try:
            frame = grab(camera["url"], grab_timeout_s)
            started = time.monotonic()
            payload = scan(camera_id, frame, detector, models)
            answer = api.post_scan(payload)
            done += 1
            log(
                "INFO",
                "scanned",
                camera_id=camera_id,
                detections=len(payload["detections"]),
                seconds=round(time.monotonic() - started, 1),
                **answer,
            )
        except Exception as err:  # noqa: BLE001 - one camera must not stop the scan of the others
            log("WARNING", "scan failed", camera_id=camera_id, error=str(err))
    return done


def main() -> int:
    os.environ.setdefault("OPENCV_FFMPEG_CAPTURE_OPTIONS", "rtsp_transport;tcp")
    interval = float(os.environ.get("DISCOVER_INTERVAL", "300"))
    threads = int(os.environ.get("INFERENCE_THREADS", "2"))
    api = ConfigApi(os.environ.get("CONFIG_API_URL", "http://config-api:8080"))
    try:
        models: Models | None = Models(Path(os.environ.get("MODEL_DIR", "/models")), threads)
    except Exception as err:  # noqa: BLE001 - without models the detections go out without hints
        log("WARNING", "models not loaded; detections carry no hints", error=str(err))
        models = None
    detector = OwlDetector(
        os.environ.get("DETECTOR_MODEL", "google/owlv2-base-patch16-ensemble"),
        float(os.environ.get("DETECT_THRESHOLD", "0.2")),
        threads,
    )
    stop = threading.Event()
    signal.signal(signal.SIGTERM, lambda *_: stop.set())
    signal.signal(signal.SIGINT, lambda *_: stop.set())
    log("INFO", "started", interval_s=interval)
    while not stop.is_set():
        try:
            log(
                "INFO",
                "pass done",
                cameras=scan_all(
                    api, detector, models, float(os.environ.get("GRAB_TIMEOUT_S", "10")), stop
                ),
            )
        except Exception as err:  # noqa: BLE001 - config-api down: try again next time
            log("WARNING", "pass failed", error=str(err))
        stop.wait(interval)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
