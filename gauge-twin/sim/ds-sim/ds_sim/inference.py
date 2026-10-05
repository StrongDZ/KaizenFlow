"""The two ONNX models with their preprocessing specs."""

from __future__ import annotations

from pathlib import Path

import numpy as np
import onnxruntime

from ds_sim import preprocess

DIAL, DIGIT = "dial_pose", "digit_cls"


class Model:
    def __init__(self, directory: Path, name: str, threads: int) -> None:
        onnx_path = directory / f"{name}.onnx"
        spec_path = directory / f"{name}.preprocess.json"
        if not onnx_path.exists() or not spec_path.exists():
            raise FileNotFoundError(f"{onnx_path} or {spec_path} is missing")
        self.spec = preprocess.load_spec(spec_path)
        options = onnxruntime.SessionOptions()
        options.intra_op_num_threads = threads
        self.session = onnxruntime.InferenceSession(
            str(onnx_path), options, providers=["CPUExecutionProvider"]
        )
        self.input = self.session.get_inputs()[0].name

    def run(self, images: np.ndarray) -> list[np.ndarray]:
        return self.session.run(None, {self.input: preprocess.to_tensor(images, self.spec)})


class Models:
    """dial_pose and digit_cls loaded from one directory."""

    def __init__(self, directory: Path, threads: int = 2) -> None:
        self.dial = Model(directory, DIAL, threads)
        self.digit = Model(directory, DIGIT, threads)

    def dial_keypoints(self, frame: np.ndarray, roi: list[int]) -> tuple[np.ndarray, np.ndarray]:
        """Keypoints (5, 2) in frame pixels and their confidence (5,) for one dial."""
        crop = preprocess.roi_crop(frame, roi, self.dial.spec)
        keypoints, confidence = self.dial.run(crop[None])
        x, y, w, h = roi
        scale = np.array(
            [w / self.dial.spec["input"]["width"], h / self.dial.spec["input"]["height"]]
        )
        return keypoints[0] * scale + np.array([x, y]), confidence[0]

    def digit_probabilities(self, frame: np.ndarray, quad: np.ndarray, digits: int) -> np.ndarray:
        """Class probabilities (digits, 12) of one digit display."""
        slots = preprocess.quad_slots(frame, quad, digits, self.digit.spec)
        return self.digit.run(slots)[0]
