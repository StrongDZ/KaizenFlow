"""Evaluation metrics on hand-made cases."""

import numpy as np

from gauge_ml import CLASS_TRANSITION
from gauge_ml.dataset.dial import read_value
from gauge_ml.eval_dial import dial_metrics
from gauge_ml.eval_digit import digit_metrics, exact_match
from gauge_ml.geometry import dial_keypoints_rect, dial_value_from_points

CALIB = {
    "center": [128.0, 128.0],
    "min_pt": [52.0, 204.0],
    "max_pt": [204.0, 204.0],
    "min_val": 0.0,
    "max_val": 150.0,
    "sweep": "cw",
    "scale": "linear",
}


def test_exact_match_counts_whole_displays():
    # Three displays of 3 slots: all right; one slot wrong; all right but in transition.
    labels = np.array([1, 2, 3, 4, 5, 6, 7, CLASS_TRANSITION, 9])
    predicted = np.array([1, 2, 3, 4, 0, 6, 7, CLASS_TRANSITION, 9])
    sequence = np.array([5, 5, 5, 8, 8, 8, 2, 2, 2])

    overall, readable, displays, steady = exact_match(labels, predicted, sequence)

    assert (displays, steady) == (3, 2)
    assert overall == 2 / 3
    assert readable == 1 / 2


def test_digit_metrics_report_accuracy_per_group():
    split = {
        "labels": np.array([1, 2, 3, 4], dtype=np.uint8),
        "sequence": np.array([0, 0, 1, 1]),
        "gauge_type": np.array(["seg7", "seg7", "timer_mmss", "timer_mmss"]),
        "color": np.array(["lcd", "lcd", "red_led", "red_led"]),
        "noise_level": np.array(["low", "low", "high", "high"]),
    }
    metrics = digit_metrics(split, np.array([1, 2, 3, 9]))

    assert metrics["slot_accuracy"] == 0.75
    assert metrics["accuracy_by_gauge_type"] == {"seg7": 1.0, "timer_mmss": 0.5}
    assert metrics["accuracy_per_class"]["4"] == 0.0
    assert metrics["exact_match"] == 0.5
    assert metrics["confusion"][4][9] == 1


def test_keypoints_and_angle_formula_are_inverse():
    for sweep in ("cw", "ccw"):
        calib = dict(CALIB, sweep=sweep)
        if sweep == "ccw":
            calib["min_pt"], calib["max_pt"] = calib["max_pt"], calib["min_pt"]
        for value in (0.0, 37.5, 75.0, 149.0):
            points = dial_keypoints_rect(calib, value, 0.8, 256)
            assert abs(dial_value_from_points(points[0], points[4], calib) - value) < 1e-6
            # mid is the 50% mark, start/end the ends of the scale.
            assert abs(dial_value_from_points(points[0], points[3], calib) - 75.0) < 1e-6
            assert np.allclose(points[1], calib["min_pt"]) and np.allclose(points[2], calib["max_pt"])


def test_dial_metrics_measure_error_in_percent_of_full_scale():
    quad = np.array([[100, 50], [356, 50], [356, 306], [100, 306]], dtype=np.float64)  # frontal, 256 px
    crop = (90.0, 40.0, 276.0, 276.0)
    rows, predicted = [], []
    for value, offset in ((30.0, 0.0), (90.0, 3.0)):
        rect = dial_keypoints_rect(CALIB, value, 0.8, 256)
        truth = (rect + quad[0] - np.array(crop[:2])) * 256 / 276
        shifted = (dial_keypoints_rect(CALIB, value + offset, 0.8, 256) + quad[0] - np.array(crop[:2])) * 256 / 276
        rows.append(
            {
                "keypoints": truth.astype(np.float32),
                "visible": np.ones(5, bool),
                "crop": list(crop),
                "quad": quad,
                "rect_size": 256,
                "calib": CALIB,
                "value": value,
                "noise_level": "none",
            }
        )
        predicted.append(shifted)
        assert abs(read_value(truth, crop, quad, 256, CALIB) - value) < 1e-3

    metrics = dial_metrics(rows, np.stack(predicted))

    # Errors are 0 and 3 units out of 150: 0% and 2% of full scale.
    assert abs(metrics["percent_fs"]["mean"] - 1.0) < 0.01
    assert metrics["percent_fs"]["share_within_target"] == 0.5
    assert metrics["percent_fs_by_noise_level"]["none"]["samples"] == 2


def test_needle_in_the_dead_zone_reads_beyond_the_scale_like_edge_agent():
    # Same cases as edge/decode TestDialCounterClockwiseAndDeadZone: the scale
    # starts at 135 degrees and spans 270, so 9 degrees are 5 units.
    from gauge_ml.geometry import dial_value_from_angle

    cases = {126: -5.0, 100: -35 * 150 / 270, 54: 155.0, 80: 150 + 35 * 150 / 270, 135: 0.0, 45: 150.0}
    for angle, want in cases.items():
        assert abs(dial_value_from_angle(angle, CALIB) - want) < 1e-6
