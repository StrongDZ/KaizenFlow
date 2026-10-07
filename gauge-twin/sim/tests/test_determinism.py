"""The renderer is a pure function of the seed: frames can be redrawn exactly."""

import json

import cv2
import numpy as np
import pyarrow.parquet as pq
from conftest import FPS, N_FRAMES, SEED
from gauge_renderer import groundtruth
from gauge_renderer.render import (
    CONFIG_FILENAME,
    META_FILENAME,
    VIDEO_FILENAME,
    redraw_frame,
    reference_frame_path,
    render_station,
)


def test_redraw_from_groundtruth_is_pixel_identical(rendered):
    for result in rendered:
        meta = json.loads((result.directory / META_FILENAME).read_text())
        assert len(meta["reference_frames"]) == 3
        for frame_idx in meta["reference_frames"]:
            reference = cv2.imread(str(reference_frame_path(result.directory, frame_idx)))
            redrawn = redraw_frame(result.directory, frame_idx)
            assert np.array_equal(redrawn, reference), f"{result.machine_id} frame {frame_idx}"


def test_same_seed_gives_identical_output(rendered, tmp_path):
    first = rendered[0]
    again = render_station(SEED, 0, tmp_path, N_FRAMES, FPS, "medium", keep_frames=3)

    a = pq.read_table(again.directory / groundtruth.FILENAME)
    b = pq.read_table(first.directory / groundtruth.FILENAME)
    assert a.schema.equals(b.schema)
    for name in a.column_names:
        left, right = a[name].to_numpy(), b[name].to_numpy()
        # Occluder columns hold NaN when nothing is in front of the camera.
        nan_ok = left.dtype.kind == "f"
        assert np.array_equal(left, right, equal_nan=nan_ok), name
    for name in (CONFIG_FILENAME, META_FILENAME):
        assert (again.directory / name).read_text() == (first.directory / name).read_text()
    last = N_FRAMES - 1
    assert np.array_equal(
        cv2.imread(str(reference_frame_path(again.directory, last))),
        cv2.imread(str(reference_frame_path(first.directory, last))),
    )


def test_different_seed_gives_different_output(rendered, tmp_path):
    other = render_station(SEED + 1, 0, tmp_path, 2, FPS, "medium", keep_frames=1)

    a = cv2.imread(str(reference_frame_path(other.directory, 0)))
    b = cv2.imread(str(reference_frame_path(rendered[0].directory, 0)))
    assert not np.array_equal(a, b)


def test_video_frames_match_groundtruth(rendered):
    """The encoded video is lossy, but each frame must be the one the ground truth describes."""
    result = rendered[0]
    capture = cv2.VideoCapture(str(result.directory / VIDEO_FILENAME))
    decoded = []
    while True:
        ok, frame = capture.read()
        if not ok:
            break
        decoded.append(frame)
    capture.release()

    assert len(decoded) == N_FRAMES
    for frame_idx in (0, N_FRAMES // 2, N_FRAMES - 1):
        redrawn = redraw_frame(result.directory, frame_idx)
        assert decoded[frame_idx].shape == redrawn.shape == (1080, 1920, 3)
        assert cv2.PSNR(decoded[frame_idx], redrawn) > 26.0, f"frame {frame_idx}"
