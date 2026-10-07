"""ds-sim (onnxruntime + preprocess.json) must give the same numbers as the
PyTorch models fed by the training preprocessing, on the same camera frame.
This guards the classic failure: a model that is right in Python and wrong in
the deployed pipeline because resize, colour order or scaling differ.
"""

import cv2
import numpy as np
import torch
from ds_sim.inference import Models

from gauge_ml import export, preprocess
from gauge_ml.dataset.builder import find_stations
from gauge_ml.dataset.station import Station
from gauge_ml.models.dial_keypoint import DialExport, DialKeypointNet
from gauge_ml.models.digit_cnn import DigitCNN, DigitExport


def test_ds_sim_matches_pytorch_on_the_same_frame(sim_dir, tmp_path):
    # Untrained weights are enough: only numerical agreement is tested.
    torch.manual_seed(0)
    dial_model, digit_model = DialKeypointNet("mobilenet_v3_small", pretrained=False).eval(), DigitCNN().eval()
    torch.save(
        {"arch": "dial_keypoint", "backbone": "mobilenet_v3_small", "model": dial_model.state_dict()},
        tmp_path / "dial.pt",
    )
    torch.save({"arch": "digit_cnn", "model": digit_model.state_dict()}, tmp_path / "digit.pt")
    export.run("dial", tmp_path / "dial.pt", tmp_path / "onnx", register=False)
    export.run("digit", tmp_path / "digit.pt", tmp_path / "onnx", register=False)
    models = Models(tmp_path / "onnx", threads=1)

    checked = set()
    for directory in find_stations([sim_dir]):
        station = Station(directory)
        frame = next(iter(station.frames(sample_fps=1.0))).image
        for gauge in station.gauges:
            if gauge.type == "analog_dial":
                keypoints, confidence = models.dial_keypoints(frame, gauge.roi)
                crop = preprocess.dial_crop(frame, tuple(gauge.roi))
                tensor = torch.from_numpy(cv2.cvtColor(crop, cv2.COLOR_BGR2RGB)).permute(2, 0, 1).float().div(255)[None]
                with torch.no_grad():
                    expected, expected_confidence = DialExport(dial_model)(tensor)
                x, y, w, h = gauge.roi
                expected = expected[0].numpy() * np.array([w / 256, h / 256]) + np.array([x, y])
                assert np.abs(keypoints - expected).max() < 0.05, "keypoints differ (pixels)"
                assert np.abs(confidence - expected_confidence[0].numpy()).max() < 1e-3
            else:
                digits = int(gauge.calib["digits"])
                probabilities = models.digit_probabilities(frame, gauge.quad, digits)
                slots = preprocess.digit_slots(frame, gauge.quad, digits)
                tensor = torch.from_numpy(slots).float().div(255).unsqueeze(1)
                with torch.no_grad():
                    expected = DigitExport(digit_model)(tensor).numpy()
                assert probabilities.shape == (digits, 12)
                assert np.abs(probabilities - expected).max() < 1e-4
            checked.add(gauge.type)
    assert "analog_dial" in checked and len(checked) >= 3
