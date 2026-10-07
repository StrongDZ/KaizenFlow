"""Dial dataset for training: crops, keypoints and training-time augmentation."""

from __future__ import annotations

import json
from pathlib import Path

import cv2
import numpy as np
import pyarrow.parquet as pq
import torch
from torch.utils.data import Dataset

from gauge_ml import DIAL_INPUT, KEYPOINTS


def load_index(data: Path, split: str) -> list[dict]:
    """Rows of the split's index; calib is decoded and arrays are reshaped."""
    path = data / "dial" / split / "index.parquet"
    rows = pq.read_table(path).to_pylist()
    if rows and "keypoints" not in rows[0]:
        return []
    for row in rows:
        row["keypoints"] = np.array(row["keypoints"], dtype=np.float32).reshape(len(KEYPOINTS), 2)
        row["visible"] = np.array(row["visible"], dtype=bool)
        row["quad"] = np.array(row["quad"], dtype=np.float64).reshape(4, 2)
        row["calib"] = json.loads(row["calib"])
        row["image_path"] = str(data / "dial" / split / "images" / f"{row['id']}.jpg")
    return rows


def augment(image: np.ndarray, keypoints: np.ndarray, rng: np.random.Generator) -> tuple[np.ndarray, np.ndarray]:
    """Random perspective, photometric changes, blur and glare.

    Returns the augmented BGR image and the keypoints moved accordingly. No
    flips: they would swap the meaning of start/end and of cw/ccw.
    """
    size = DIAL_INPUT
    corners = np.array([[0, 0], [size, 0], [size, size], [0, size]], dtype=np.float32)
    jitter = rng.uniform(-0.08, 0.08, (4, 2)).astype(np.float32) * size
    matrix = cv2.getPerspectiveTransform(corners, corners + jitter)
    image = cv2.warpPerspective(image, matrix, (size, size), flags=cv2.INTER_LINEAR, borderMode=cv2.BORDER_REPLICATE)
    keypoints = cv2.perspectiveTransform(keypoints.reshape(-1, 1, 2).astype(np.float32), matrix).reshape(-1, 2)

    out = image.astype(np.float32)
    out = (out - 127.5) * rng.uniform(0.6, 1.4) + 127.5 + rng.uniform(-35, 35)
    out *= rng.uniform(0.9, 1.1, 3).astype(np.float32)  # slight colour cast
    if rng.random() < 0.3:
        # Glare: a soft bright disc somewhere on the crop.
        cx, cy, radius = rng.uniform(0, size), rng.uniform(0, size), rng.uniform(0.15, 0.4) * size
        ys, xs = np.mgrid[0:size, 0:size].astype(np.float32)
        out += (rng.uniform(60, 200) * np.exp(-((xs - cx) ** 2 + (ys - cy) ** 2) / (2 * radius**2)))[:, :, None]
    out = np.clip(out, 0, 255).astype(np.uint8)
    if rng.random() < 0.4:
        out = cv2.GaussianBlur(out, (0, 0), rng.uniform(0.5, 2.0))
    return out, keypoints


class DialDataset(Dataset):
    """Yields (image RGB float in [0, 1] as (3, H, W), keypoints (5, 2) in [0, 1], visible (5,))."""

    def __init__(self, rows: list[dict], train: bool, seed: int = 0) -> None:
        self.rows, self.train, self.seed = rows, train, seed
        self.epoch = 0

    def __len__(self) -> int:
        return len(self.rows)

    def __getitem__(self, index: int):
        row = self.rows[index]
        image = cv2.imread(row["image_path"])
        keypoints, visible = row["keypoints"].copy(), row["visible"].copy()
        if self.train:
            rng = np.random.default_rng([self.seed, self.epoch, index])
            image, keypoints = augment(image, keypoints, rng)
            visible &= (keypoints >= 0).all(axis=1) & (keypoints < DIAL_INPUT).all(axis=1)
        tensor = torch.from_numpy(cv2.cvtColor(image, cv2.COLOR_BGR2RGB)).permute(2, 0, 1).float().div(255)
        return tensor, torch.from_numpy(keypoints / DIAL_INPUT).float(), torch.from_numpy(visible)
