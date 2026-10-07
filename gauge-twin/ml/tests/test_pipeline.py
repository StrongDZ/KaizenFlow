"""End to end on a tiny dataset: train, evaluate, export, register."""

import json

import numpy as np
import onnx
import onnxruntime
import torch
from mlflow.tracking import MlflowClient

from gauge_ml import eval_dial, eval_digit, export, train_dial, train_digit


def test_digit_pipeline_trains_evaluates_exports_and_registers(dataset_dir, mlflow_dir, tmp_path):
    out = tmp_path / "digit"
    assert train_digit.main(["--data", str(dataset_dir), "--out", str(out), "--epochs", "4", "--batch-size", "64"]) == 0
    metrics = json.loads((out / "metrics.json").read_text())
    # Far from converged after 4 epochs on a few hundred slots, but clearly learning.
    assert metrics["slot_accuracy"] > 0.3

    report = tmp_path / "digit-eval.json"
    assert eval_digit.main(["--data", str(dataset_dir), "--weights", str(out / "best.pt"), "--out", str(report)]) == 0
    evaluated = json.loads(report.read_text())
    assert evaluated["slots"] > 0 and 0.0 <= evaluated["exact_match"] <= evaluated["exact_match_no_transition"] + 1.0

    assert export.main(["--model", "digit", "--weights", str(out / "best.pt"), "--out", str(tmp_path / "onnx")]) == 0
    model_path = tmp_path / "onnx" / "digit_cls.onnx"
    graph = onnx.load(str(model_path))
    assert graph.opset_import[0].version == 17
    shape = graph.graph.input[0].type.tensor_type.shape.dim
    assert shape[0].dim_param == "batch" and [d.dim_value for d in shape[1:]] == [1, 48, 32]
    session = onnxruntime.InferenceSession(str(model_path), providers=["CPUExecutionProvider"])
    for batch in (1, 128):
        (probabilities,) = session.run(None, {"slots": np.random.rand(batch, 1, 48, 32).astype(np.float32)})
        assert probabilities.shape == (batch, 12)

    card = json.loads(model_path.with_suffix(".json").read_text())
    assert card["trt_profile"] == {"min": 1, "opt": 32, "max": 128}
    spec = json.loads((tmp_path / "onnx" / "digit_cls.preprocess.json").read_text())
    assert spec["color"] == "GRAY" and spec["input"]["width"] == 32 and spec["input"]["height"] == 48
    versions = MlflowClient().search_model_versions("name='digit_cls'")
    assert len(versions) == 1 and versions[0].tags["trt_opt_batch"] == "32"
    assert versions[0].source.endswith("onnx/digit_cls.onnx")


def test_dial_pipeline_trains_evaluates_exports_and_registers(dataset_dir, mlflow_dir, tmp_path):
    out = tmp_path / "dial"
    code = train_dial.main(
        [
            "--data",
            str(dataset_dir),
            "--out",
            str(out),
            "--epochs",
            "2",
            "--batch-size",
            "8",
            "--no-pretrained",
            "--workers",
            "0",
        ]
    )
    assert code == 0 and (out / "best.pt").exists()

    report = tmp_path / "dial-eval.json"
    assert eval_dial.main(["--data", str(dataset_dir), "--weights", str(out / "best.pt"), "--out", str(report)]) == 0
    evaluated = json.loads(report.read_text())
    assert evaluated["percent_fs"]["samples"] > 0
    assert set(evaluated["percent_fs_by_noise_level"]) <= {"none", "low", "medium", "high"}

    assert export.main(["--model", "dial", "--weights", str(out / "best.pt"), "--out", str(tmp_path / "onnx")]) == 0
    model_path = tmp_path / "onnx" / "dial_pose.onnx"
    graph = onnx.load(str(model_path))
    assert graph.opset_import[0].version == 17
    shape = graph.graph.input[0].type.tensor_type.shape.dim
    assert shape[0].dim_param == "batch" and [d.dim_value for d in shape[1:]] == [3, 256, 256]

    # ONNX and PyTorch agree at batch 1 and at a large batch.
    module = export.load_export_module("dial", out / "best.pt")
    session = onnxruntime.InferenceSession(str(model_path), providers=["CPUExecutionProvider"])
    for batch in (1, 32):
        x = np.random.rand(batch, 3, 256, 256).astype(np.float32)
        keypoints, confidence = session.run(None, {"crops": x})
        with torch.no_grad():
            expected_keypoints, expected_confidence = module(torch.from_numpy(x))
        assert keypoints.shape == (batch, 5, 2) and confidence.shape == (batch, 5)
        assert np.abs(keypoints - expected_keypoints.numpy()).max() < 1e-2
        assert np.abs(confidence - expected_confidence.numpy()).max() < 1e-3

    spec = json.loads((tmp_path / "onnx" / "dial_pose.preprocess.json").read_text())
    assert spec["color"] == "RGB" and spec["resize"] == {"mode": "stretch", "interpolation": "area"}
    assert spec["mean"] == [0.0, 0.0, 0.0], "normalisation lives inside the graph"

    versions = MlflowClient().search_model_versions("name='dial_pose'")
    assert len(versions) == 1 and versions[0].tags["trt_max_batch"] == "32"
