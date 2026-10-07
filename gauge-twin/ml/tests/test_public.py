"""Public-dataset loaders and the ground-truth measurement, on drawn images."""

import cv2
import numpy as np
import pytest

from gauge_ml import DIGIT_H, DIGIT_W
from gauge_ml.dataset.public import pressure_gauge as pg
from gauge_ml.dataset.public.slots import digit_box, frame_digit
from gauge_ml.dataset.public.trodo import slot_from_box
from gauge_ml.eval_public import digit_metrics

# Seven-segment strokes of an "8" in a 60x100 cell (x0, y0, x1, y1).
SEGMENTS = [
    (8, 0, 52, 8),
    (0, 6, 8, 48),
    (52, 6, 60, 48),
    (8, 46, 52, 54),
    (0, 52, 8, 94),
    (52, 52, 60, 94),
    (8, 92, 52, 100),
]


def draw_eight(image: np.ndarray, x: int, y: int, color: int) -> None:
    for x0, y0, x1, y1 in SEGMENTS:
        cv2.rectangle(image, (x + x0, y + y0), (x + x1, y + y1), color, -1)


def test_digit_box_finds_the_whole_digit_and_skips_cut_neighbours():
    # An LCD crop: light face, the digit off-centre, a neighbour cut by the right edge.
    image = np.full((300, 150), 200, np.uint8)
    draw_eight(image, 40, 120, 40)
    draw_eight(image, 120, 120, 40)

    x, y, w, h = digit_box(image, "dark")

    assert abs(x - 40) <= 3 and abs(y - 120) <= 3
    assert abs(w - 60) <= 4 and abs(h - 100) <= 4


def test_frame_digit_fills_the_slot_like_the_synthetic_ones():
    image = np.full((300, 150), 30, np.uint8)
    draw_eight(image, 45, 60, 220)

    slot = frame_digit(image, "light")

    assert slot.shape == (DIGIT_H, DIGIT_W)
    rows = np.flatnonzero((slot > 128).any(axis=1))
    # The digit spans about 85% of the slot height, centred.
    assert (rows[-1] - rows[0] + 1) / DIGIT_H == pytest.approx(0.85, abs=0.06)
    assert (rows[0] + rows[-1]) / 2 == pytest.approx(DIGIT_H / 2, abs=2)


def test_slot_from_box_centres_the_box():
    image = np.zeros((200, 200), np.uint8)
    image[50:150, 80:120] = 255
    slot = slot_from_box(image, (80, 50, 120, 150))
    cols = np.flatnonzero((slot > 128).any(axis=0))
    assert slot.shape == (DIGIT_H, DIGIT_W)
    assert (cols[0] + cols[-1]) / 2 == pytest.approx(DIGIT_W / 2, abs=1.5)


CALIB = pg.GaugeCalib((256, 256), (150, 175), (0, 1, 2, 3, 4, 5, 6), 133, 407)
TRUE_TICKS = np.linspace(135.0, 405.0, 7)


def draw_gauge(needle_deg: float, center=(256, 256)) -> np.ndarray:
    image = np.full((512, 512), 235, np.uint8)
    cx, cy = center
    for deg in np.arange(135.0, 405.1, 9.0):
        major = any(abs(deg - t) < 1e-6 for t in TRUE_TICKS)
        r0 = 150 if major else 162
        a = np.radians(deg)
        cv2.line(
            image,
            (int(round(cx + r0 * np.cos(a))), int(round(cy + r0 * np.sin(a)))),
            (int(round(cx + 175 * np.cos(a))), int(round(cy + 175 * np.sin(a)))),
            20,
            4 if major else 2,
        )
    a = np.radians(needle_deg)
    tip = (int(round(cx + 145 * np.cos(a))), int(round(cy + 145 * np.sin(a))))
    tail = (int(round(cx - 40 * np.cos(a))), int(round(cy - 40 * np.sin(a))))
    cv2.line(image, tail, tip, 10, 3, cv2.LINE_AA)
    cv2.circle(image, (cx, cy), 10, 10, -1)
    return image


def test_ticks_and_needle_are_measured_to_a_fraction_of_a_degree():
    for needle in (150.0, 222.5, 300.0, 390.0):
        gray = draw_gauge(needle)
        majors = pg.refine_majors(gray, CALIB)
        assert np.abs(majors - TRUE_TICKS).max() < 0.75
        angle, measure = pg.needle_angle(gray, CALIB)
        assert measure.score >= pg.MIN_SCORE
        assert abs(angle - needle) < 0.5
        expected = (needle - 135.0) / 45.0
        assert pg.value_at(angle, majors, CALIB.values) == pytest.approx(expected, abs=0.03)


def test_center_is_recovered_from_needle_lines():
    true_center = (259.0, 251.0)
    grays = [draw_gauge(deg, center=(259, 251)) for deg in (160.0, 240.0, 320.0, 380.0)]
    # Clicked 5 px off the real pivot.
    found = pg.refine_center(grays, CALIB)
    assert np.hypot(found[0] - true_center[0], found[1] - true_center[1]) < 1.5


def test_value_at_extrapolates_into_the_dead_zone():
    majors = TRUE_TICKS
    # 9 deg below the first tick is -0.2 on a 45 deg/unit scale; same past the last.
    assert pg.value_at(126.0, majors, CALIB.values) == pytest.approx(-0.2)
    assert pg.value_at(414.0, majors, CALIB.values) == pytest.approx(6.2)
    # Angles given in the other turn are understood too.
    assert pg.value_at(126.0 + 360.0, majors, CALIB.values) == pytest.approx(-0.2)


def test_digit_metrics_on_single_digit_crops():
    labels = np.array([1, 2, 3, 3])
    probs = np.zeros((4, 12))
    probs[[0, 1, 2, 3], [1, 2, 8, 3]] = [0.95, 0.6, 0.8, 0.99]
    metrics = digit_metrics(labels, probs, np.array([0, 0, 1, 1]))
    assert metrics["slot_accuracy"] == 0.75
    assert metrics["exact_match"] == 0.5
    assert metrics["by_confidence"]["0.9"] == {"share_kept": 0.5, "accuracy_kept": 1.0}


def test_tenths_of_a_drum_map_to_digit_transition_or_next_digit():
    from gauge_ml import CLASS_TRANSITION
    from gauge_ml.dataset.public.meter_digits import class_of

    assert [class_of(f"4.{t}") for t in range(10)] == [4, 4, 4] + [CLASS_TRANSITION] * 5 + [5, 5]
    assert class_of("9.9") == 0


def test_roboflow_yaml_names_inline_and_block(tmp_path):
    from gauge_ml.dataset.public.yolo_digits import _names, original_photo

    inline = tmp_path / "a.yaml"
    inline.write_text("nc: 3\nnames: ['0', '1', 'screen']\n")
    block = tmp_path / "b.yaml"
    block.write_text("nc: 2\nnames:\n- center\n- tip\nroboflow:\n  x: 1\n")
    assert _names(inline) == ["0", "1", "screen"]
    assert _names(block) == ["center", "tip"]
    assert original_photo("00_66_jpg.rf.5bb7b95f190daec4") == "00_66_jpg"


def test_sweep_follows_the_long_way_round_the_bottom_dead_zone():
    from gauge_ml.dataset.public.gauge_keypoints import sweep_of

    c = np.array([100.0, 100.0])
    low_left, low_right, top = np.array([30.0, 170.0]), np.array([170.0, 170.0]), np.array([100.0, 20.0])
    assert sweep_of(c, low_left, low_right, top) == "cw"
    assert sweep_of(c, low_right, low_left, top) == "ccw"


def test_module_readings_become_lit_digit_classes():
    from gauge_ml.dataset.public.seg7_modules import labels_of

    assert labels_of("0056") == [0, 0, 5, 6]
    assert labels_of("56") == [5, 6]
    assert labels_of("12345") is None


def test_splits_are_deterministic_and_keep_eval_only_data_out_of_training():
    from gauge_ml.dataset.build_real import split_of

    splits = [split_of("trodo", f"img{i}", eval_only=False) for i in range(2000)]
    assert splits == [split_of("trodo", f"img{i}", eval_only=False) for i in range(2000)]
    assert 0.75 < splits.count("train") / 2000 < 0.85
    assert {split_of("seg7-industrial", f"img{i}", eval_only=True) for i in range(50)} == {"test"}


def test_digit_training_can_start_from_a_checkpoint(tmp_path, monkeypatch):
    import torch

    from gauge_ml.models.digit_cnn import DigitCNN
    from gauge_ml.train_digit import train

    monkeypatch.setenv("MLFLOW_TRACKING_URI", f"file://{tmp_path}/mlruns")
    rng = np.random.default_rng(0)
    (tmp_path / "data" / "digits").mkdir(parents=True)
    for split, n in (("train", 64), ("val", 16)):
        np.savez(
            tmp_path / "data" / "digits" / f"{split}.npz",
            images=rng.integers(0, 255, (n, DIGIT_H, DIGIT_W), dtype=np.uint8),
            labels=rng.integers(0, 10, n).astype(np.uint8),
            sequence=np.arange(n),
            gauge_type=np.array(["seg7"] * n),
            color=np.array(["x"] * n),
            noise_level=np.array(["real"] * n),
        )
    start = DigitCNN()
    torch.save({"arch": "digit_cnn", "model": start.state_dict()}, tmp_path / "start.pt")

    train(tmp_path / "data", tmp_path / "out", 1, 32, 1e-3, "cpu", 0, init=tmp_path / "start.pt")
    assert (tmp_path / "out" / "best.pt").exists()

    torch.save({"arch": "dial_keypoint", "model": {}}, tmp_path / "wrong.pt")
    with pytest.raises(SystemExit):
        train(tmp_path / "data", tmp_path / "out2", 1, 32, 1e-3, "cpu", 0, init=tmp_path / "wrong.pt")


def test_hold_out_moves_a_whole_source_to_test(tmp_path):
    from gauge_ml.dataset.holdout import hold_out

    (tmp_path / "data" / "digits").mkdir(parents=True)
    sources = {"train": ["a", "a", "b", "c"], "val": ["a", "b"], "test": ["b", "c", "c"]}
    for split, color in sources.items():
        n = len(color)
        np.savez(
            tmp_path / "data" / "digits" / f"{split}.npz",
            images=np.zeros((n, DIGIT_H, DIGIT_W), np.uint8),
            labels=np.arange(n, dtype=np.uint8),
            color=np.array(color),
        )

    summary = hold_out(tmp_path / "data", tmp_path / "out", ["b"])

    assert summary == {"held_out": ["b"], "train": 3, "val": 1, "test": 3}
    with np.load(tmp_path / "out" / "digits" / "test.npz") as test:
        assert set(test["color"]) == {"b"}
    with np.load(tmp_path / "out" / "digits" / "train.npz") as train:
        assert "b" not in set(train["color"])
    with pytest.raises(SystemExit):
        hold_out(tmp_path / "data", tmp_path / "out2", ["nope"])


def test_e2e_phase_is_recovered_for_a_looping_video(tmp_path):
    from gauge_ml.e2e_real import check

    # A 20 s video whose value ramps 0 -> 4 in its last 5 s; readings start 7.3 s into the loop.
    duration, phase = 20.0, 7.3
    gt_t = np.arange(0, duration, 0.1)
    gt_v = np.clip((gt_t - 15.0) * 0.8, 0, 4)
    station = tmp_path / "stations" / "pump_x"
    station.mkdir(parents=True)
    with (station / "groundtruth.csv").open("w") as f:
        f.write("t_s,value,clear\n" + "".join(f"{t:.4f},{v:.5f},1\n" for t, v in zip(gt_t, gt_v, strict=True)))
    (tmp_path / "stations" / "summary.json").write_text('{"pump_x": {"duration_s": 20.0, "full_scale": 4.0}}')
    wall = 1_000_000.0 + np.arange(0, 60, 1.0)
    truth = np.interp(((wall + phase) % duration) - 0.5, gt_t, gt_v)
    with (tmp_path / "readings.csv").open("w") as f:
        for i, (ts, v) in enumerate(zip(wall, truth, strict=True)):
            quality, value = (0.2, "") if i == 3 else (0.9, f"{v + 0.01:.4f}")  # one unreadable window
            f.write(f"pump_x,{ts},{value},{quality},{'FLAG_BLUR' if i == 3 else ''},2\n")

    report = check(tmp_path / "stations", tmp_path / "readings.csv", 1.0)["pump_x"]

    assert abs(report["phase_s"] - phase) <= 0.1
    assert report["windows"] == 60 and report["flags"] == {"FLAG_BLUR": 1}
    assert report["percent_fs"]["max"] < 1.0 and report["percent_fs"]["windows"] == 59
