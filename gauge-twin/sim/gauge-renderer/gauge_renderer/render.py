"""Rendering of one station clip and redrawing of single frames from its ground truth."""

from __future__ import annotations

import json
import time
from dataclasses import dataclass
from pathlib import Path

import cv2
import numpy as np
from denso.gauge.v1 import config_pb2
from google.protobuf import json_format

from gauge_renderer import RENDERER_VERSION, groundtruth, noise
from gauge_renderer.noise import FRAME_COLUMNS, FrameNoise
from gauge_renderer.station import (
    FRAME_HEIGHT,
    FRAME_WIDTH,
    STREAM_NOISE,
    STREAM_VALUES,
    Station,
    station_rng,
)
from gauge_renderer.video import VideoWriter

META_FILENAME = "render_meta.json"
CONFIG_FILENAME = "station_config.json"
VIDEO_FILENAME = "video.mp4"
FRAMES_DIRNAME = "frames"


@dataclass(frozen=True)
class RenderResult:
    machine_id: str
    directory: Path
    n_frames: int
    seconds: float


def reference_frame_path(directory: Path, frame_idx: int) -> Path:
    return directory / FRAMES_DIRNAME / f"frame_{frame_idx:06d}.png"


def render_station(
    seed: int,
    index: int,
    out_dir: Path,
    n_frames: int,
    fps: float,
    noise_level: str = "medium",
    keep_frames: int = 3,
) -> RenderResult:
    """Renders one station: video.mp4, groundtruth.parquet, station_config.json, render_meta.json.

    keep_frames lossless PNG frames (taken before H.264 encoding) are stored
    next to the video as pixel-exact references.
    """
    started = time.monotonic()
    cv2.setNumThreads(1)
    station = Station(seed, index, noise_level)
    directory = out_dir / station.machine_id
    (directory / FRAMES_DIRNAME).mkdir(parents=True, exist_ok=True)

    t = np.arange(n_frames) / fps
    displays = [
        gauge.simulate(t, fps, station_rng(seed, index, STREAM_VALUES, i), station.cycle)
        for i, gauge in enumerate(station.gauges)
    ]
    frame_noise = noise.generate(
        station.profile,
        station_rng(seed, index, STREAM_NOISE),
        t,
        station.cycle,
        station.width,
        station.height,
    )
    per_gauge = [
        {
            "occluded": noise.occluded_fraction(roi, frame_noise),
            "glare_local": noise.glare_at(
                tuple(quad.mean(axis=0)), station.profile.glare_radius, frame_noise
            ),
        }
        for roi, quad in zip(station.rois, station.quads, strict=True)
    ]
    table = groundtruth.build_table(
        fps, [(g.gauge_id, g.type) for g in station.gauges], displays, per_gauge, frame_noise
    )
    groundtruth.write(table, directory)

    # Parsing into the generated message guarantees the file follows config.proto.
    config = json_format.ParseDict(station.config_dict(fps), config_pb2.StationConfig())
    (directory / CONFIG_FILENAME).write_text(
        json_format.MessageToJson(config, preserving_proto_field_name=True, indent=2) + "\n"
    )

    keep = (
        sorted({int(i) for i in np.linspace(0, n_frames - 1, min(keep_frames, n_frames))})
        if keep_frames
        else []
    )
    meta = {
        "renderer_version": RENDERER_VERSION,
        "seed": seed,
        "station_index": index,
        "machine_id": station.machine_id,
        "noise_level": noise_level,
        "fps": fps,
        "n_frames": n_frames,
        "width": station.width,
        "height": station.height,
        "reference_frames": keep,
        **station.describe(),
    }
    (directory / META_FILENAME).write_text(json.dumps(meta, indent=2) + "\n")

    with VideoWriter(
        directory / VIDEO_FILENAME, station.width, station.height, fps, station.profile.crf
    ) as video:
        for f in range(n_frames):
            states = {
                g.gauge_id: (float(d.values[f]), d.texts[f])
                for g, d in zip(station.gauges, displays, strict=True)
            }
            fn = FrameNoise(**{name: float(frame_noise[name][f]) for name in FRAME_COLUMNS})
            frame = station.render_frame(states, fn)
            video.write(frame)
            if f in keep:
                cv2.imwrite(str(reference_frame_path(directory, f)), frame)

    return RenderResult(station.machine_id, directory, n_frames, time.monotonic() - started)


def load_station(directory: Path) -> tuple[Station, dict]:
    """Rebuilds the Station of an output directory from its render_meta.json."""
    meta = json.loads((directory / META_FILENAME).read_text())
    if meta["renderer_version"] != RENDERER_VERSION:
        raise RuntimeError(
            f"{directory} was rendered with renderer version {meta['renderer_version']}, "
            f"this is version {RENDERER_VERSION}"
        )
    if (meta["width"], meta["height"]) != (FRAME_WIDTH, FRAME_HEIGHT):
        raise RuntimeError(f"unsupported frame size in {directory}")
    return Station(meta["seed"], meta["station_index"], meta["noise_level"]), meta


def redraw_frame(directory: Path, frame_idx: int, station: Station | None = None) -> np.ndarray:
    """Redraws a frame from the ground truth; pixel-identical to the frame that was encoded."""
    if station is None:
        station, _ = load_station(directory)
    states, fn = groundtruth.read_frame(directory, frame_idx)
    return station.render_frame(states, fn)
