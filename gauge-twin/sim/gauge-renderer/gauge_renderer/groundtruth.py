"""Ground truth table: one row per (frame, gauge)."""

from __future__ import annotations

from pathlib import Path

import numpy as np
import pyarrow as pa
import pyarrow.parquet as pq

from gauge_renderer.gauges import Display
from gauge_renderer.noise import FRAME_COLUMNS, FrameNoise

FILENAME = "groundtruth.parquet"

SCHEMA = pa.schema(
    [
        ("frame_idx", pa.int32()),
        # Milliseconds since the start of the video.
        ("ts_ms", pa.int64()),
        ("gauge_id", pa.string()),
        ("type", pa.string()),
        # What a perfect reader reports; timers in seconds.
        ("value", pa.float64()),
        # Digit slots left to right, "_" = blank; empty for dials.
        ("text", pa.string()),
        # One "0"/"1" per slot, "1" while a rolling digit is mid-change.
        ("transition", pa.string()),
        # Scenario label: "", "over_range" or "frozen".
        ("anomaly", pa.string()),
        # Share of the gauge ROI hidden by the occluder, 0..1.
        ("occluded", pa.float64()),
        # Glare added at the gauge centre, in 8-bit intensity levels.
        ("glare_local", pa.float64()),
        *[(name, pa.float64()) for name in FRAME_COLUMNS],
    ]
)


def frame_timestamps(n_frames: int, fps: float) -> np.ndarray:
    return np.rint(np.arange(n_frames) * 1000.0 / fps).astype(np.int64)


def build_table(
    fps: float,
    gauges: list[tuple[str, str]],
    displays: list[Display],
    per_gauge: list[dict[str, np.ndarray]],
    frame_noise: dict[str, np.ndarray],
) -> pa.Table:
    """Assembles the table, ordered by frame then by gauge.

    gauges: (gauge_id, type) pairs; per_gauge: "occluded" and "glare_local"
    arrays for each gauge.
    """
    n_frames = len(displays[0].values)
    n_gauges = len(gauges)
    ts = frame_timestamps(n_frames, fps)

    def interleave(columns: list) -> list:
        return [columns[g][f] for f in range(n_frames) for g in range(n_gauges)]

    data = {
        "frame_idx": np.repeat(np.arange(n_frames, dtype=np.int32), n_gauges),
        "ts_ms": np.repeat(ts, n_gauges),
        "gauge_id": [gid for gid, _ in gauges] * n_frames,
        "type": [kind for _, kind in gauges] * n_frames,
        "value": np.stack([d.values for d in displays], axis=1).reshape(-1),
        "text": interleave([d.texts for d in displays]),
        "transition": interleave([d.transitions for d in displays]),
        "anomaly": interleave([d.anomalies for d in displays]),
        "occluded": np.stack([p["occluded"] for p in per_gauge], axis=1).reshape(-1),
        "glare_local": np.stack([p["glare_local"] for p in per_gauge], axis=1).reshape(-1),
    }
    for name in FRAME_COLUMNS:
        data[name] = np.repeat(frame_noise[name], n_gauges)
    return pa.Table.from_pydict(data, schema=SCHEMA)


def write(table: pa.Table, directory: Path) -> Path:
    path = directory / FILENAME
    pq.write_table(table, path, compression="zstd")
    return path


def read_frame(directory: Path, frame_idx: int) -> tuple[dict[str, tuple[float, str]], FrameNoise]:
    """Reads back what is needed to redraw one frame: gauge states and noise."""
    table = pq.read_table(directory / FILENAME, filters=[("frame_idx", "=", frame_idx)])
    rows = table.to_pylist()
    if not rows:
        raise IndexError(f"frame {frame_idx} is not in {directory / FILENAME}")
    states = {row["gauge_id"]: (row["value"], row["text"]) for row in rows}
    noise = FrameNoise(**{name: rows[0][name] for name in FRAME_COLUMNS})
    return states, noise
