"""The builder's labels agree with the renderer's ground truth."""

import json

import cv2
import numpy as np

from gauge_ml import CLASS_BLANK, CLASS_TRANSITION, DIAL_INPUT, DIGIT_H, DIGIT_W, KP_CENTER, KP_TIP
from gauge_ml.dataset import digits
from gauge_ml.dataset.builder import find_stations
from gauge_ml.dataset.dial import read_value
from gauge_ml.dataset.split import assign_splits
from gauge_ml.dial_data import load_index

SPLITS = ("train", "val", "test")


def all_dial_rows(dataset_dir):
    return [row for split in SPLITS for row in load_index(dataset_dir, split)]


def load_digits(dataset_dir, split):
    with np.load(dataset_dir / "digits" / f"{split}.npz") as archive:
        return {key: archive[key] for key in archive.files}


def test_summary_counts_match_files(dataset_dir):
    summary = json.loads((dataset_dir / "summary.json").read_text())
    assert sum(summary["stations"].values()) == 6
    assert all(summary["stations"][s] >= 1 for s in SPLITS)
    for split in SPLITS:
        assert summary[split]["dial_samples"] == len(load_index(dataset_dir, split))
        assert summary[split]["digit_slots"] == len(load_digits(dataset_dir, split)["labels"])
    assert sum(summary[s]["dial_samples"] for s in SPLITS) > 20
    assert sum(summary[s]["digit_slots"] for s in SPLITS) > 200


def test_dial_keypoint_labels_decode_to_the_ground_truth_value(dataset_dir):
    """Decoding the labelled keypoints with the edge formula gives back the value."""
    rows = all_dial_rows(dataset_dir)
    errors = []
    for row in rows:
        calib = row["calib"]
        value = read_value(row["keypoints"], tuple(row["crop"]), row["quad"], row["rect_size"], calib)
        errors.append(abs(value - row["value"]) / (calib["max_val"] - calib["min_val"]) * 100)
    # The labels include the camera shake of each frame while the decoder uses
    # the nominal quad, hence a small residual.
    assert np.mean(errors) < 0.2 and np.max(errors) < 1.0, (np.mean(errors), np.max(errors))


def test_dial_crops_and_keypoints_are_consistent(dataset_dir):
    rows = all_dial_rows(dataset_dir)
    for row in rows[:: max(1, len(rows) // 25)]:
        image = cv2.imread(row["image_path"])
        assert image.shape == (DIAL_INPUT, DIAL_INPUT, 3)
        assert row["keypoints"].shape == (5, 2) and row["visible"].shape == (5,)
        inside = (row["keypoints"] >= 0).all(axis=1) & (row["keypoints"] < DIAL_INPUT).all(axis=1)
        assert inside[KP_CENTER]
        assert not (row["visible"] & ~inside).any()
        # The needle tip is closer to the pivot than the crop is wide.
        assert np.linalg.norm(row["keypoints"][KP_TIP] - row["keypoints"][KP_CENTER]) < DIAL_INPUT * 0.6


def test_yolo_pose_labels_have_box_and_five_keypoints(dataset_dir):
    labels = sorted((dataset_dir / "dial").rglob("labels/*.txt"))
    assert len(labels) == len(all_dial_rows(dataset_dir))
    fields = labels[0].read_text().split()
    assert len(fields) == 1 + 4 + 5 * 3 and fields[0] == "0"
    assert all(0.0 <= float(v) <= 1.0 for v in fields[1:5])


def test_digit_slots_have_expected_shape_and_classes(dataset_dir):
    seen_types, classes = set(), set()
    for split in SPLITS:
        data = load_digits(dataset_dir, split)
        assert data["images"].shape[1:] == (DIGIT_H, DIGIT_W) and data["images"].dtype == np.uint8
        assert len({len(data[k]) for k in data}) == 1
        seen_types |= set(data["gauge_type"].tolist())
        classes |= set(data["labels"].tolist())
        # The transition class only exists on rolling counters.
        transition = data["labels"] == CLASS_TRANSITION
        assert set(data["gauge_type"][transition].tolist()) <= {"rolling_counter"}
        # Slots of one display share a sequence id and are numbered from 0.
        for seq in np.unique(data["sequence"])[:20]:
            slots = data["slot"][data["sequence"] == seq]
            assert sorted(slots.tolist()) == list(range(len(slots)))
    assert seen_types == {"seg7", "timer_mmss", "rolling_counter"}
    assert CLASS_BLANK in classes and len(classes & set(range(10))) >= 8


def test_slot_labels_follow_text_and_transition_mask():
    assert digits.slot_labels("_225", "0000") == [CLASS_BLANK, 2, 2, 5]
    assert digits.slot_labels("001299", "000011") == [0, 0, 1, 2, CLASS_TRANSITION, CLASS_TRANSITION]
    assert digits.slot_labels("0325", "0000") == [0, 3, 2, 5]


def test_cut_slots_splits_the_quad_evenly():
    image = np.zeros((100, 400, 3), np.uint8)
    for i in range(4):
        image[20:80, 40 + i * 80 : 120 + i * 80] = 60 * i + 30
    quad = np.array([[40, 20], [360, 20], [360, 80], [40, 80]], dtype=np.float64)

    slots = digits.cut_slots(image, quad, 4)

    assert slots.shape == (4, DIGIT_H, DIGIT_W)
    for i in range(4):
        assert abs(float(slots[i, 5:-5, 3:-3].mean()) - (60 * i + 30)) < 2


def test_split_keeps_every_station_in_exactly_one_split(sim_dir):
    stations = find_stations([sim_dir])
    first, second = assign_splits(stations), assign_splits(list(reversed(stations)))

    assert first == second
    assert set(first.values()) == {"train", "val", "test"}
    assert len(first) == len(stations) == 6


def test_preprocess_spec_reproduces_the_training_inputs(dataset_dir):
    """Applying preprocess.json-style specs gives exactly what the models were trained on."""
    from gauge_ml import preprocess

    row = all_dial_rows(dataset_dir)[0]
    crop = cv2.imread(row["image_path"])
    batch = preprocess.to_tensor(crop[None], preprocess.DIAL)
    assert batch.shape == (1, 3, DIAL_INPUT, DIAL_INPUT) and batch.dtype == np.float32
    # RGB order, scaled to [0, 1], no mean/std outside the graph.
    assert np.allclose(batch[0, 0], crop[:, :, 2] / 255.0, atol=1e-6)
    assert np.allclose(batch[0, 2], crop[:, :, 0] / 255.0, atol=1e-6)

    slots = load_digits(dataset_dir, "train")["images"][:4]
    batch = preprocess.to_tensor(slots, preprocess.DIGIT)
    assert batch.shape == (4, 1, DIGIT_H, DIGIT_W)
    assert np.allclose(batch[:, 0], slots / 255.0, atol=1e-6)
