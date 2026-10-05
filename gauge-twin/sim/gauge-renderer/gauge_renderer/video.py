"""H.264 encoding through the ffmpeg binary (libx264)."""

from __future__ import annotations

import subprocess
import tempfile
from pathlib import Path

import numpy as np


class VideoWriter:
    """Pipes raw BGR frames into ffmpeg."""

    def __init__(self, path: Path, width: int, height: int, fps: float, crf: int) -> None:
        self.path = path
        self._stderr = tempfile.TemporaryFile()
        # A keyframe exactly every 2 x fps frames (no scene-cut keyframes) and
        # no B-frames, so the file can be looped over RTSP with a stream copy:
        # the loop point always lands on a keyframe.
        gop = str(max(1, int(round(2 * fps))))
        command = [
            "ffmpeg", "-hide_banner", "-loglevel", "error", "-y",
            "-f", "rawvideo", "-pix_fmt", "bgr24", "-s", f"{width}x{height}",
            "-r", f"{fps:g}", "-i", "-",
            "-c:v", "libx264", "-preset", "veryfast", "-crf", str(crf), "-pix_fmt", "yuv420p",
            "-g", gop, "-keyint_min", gop, "-sc_threshold", "0", "-bf", "0", "-threads", "2",
            "-movflags", "+faststart", str(path),
        ]  # fmt: skip
        self._process = subprocess.Popen(command, stdin=subprocess.PIPE, stderr=self._stderr)

    def write(self, frame: np.ndarray) -> None:
        try:
            self._process.stdin.write(frame.tobytes())
        except BrokenPipeError:
            self.close()

    def close(self) -> None:
        if self._process.stdin and not self._process.stdin.closed:
            self._process.stdin.close()
        code = self._process.wait()
        self._stderr.seek(0)
        errors = self._stderr.read().decode(errors="replace")
        self._stderr.close()
        if code != 0:
            raise RuntimeError(f"ffmpeg failed with exit code {code}: {errors.strip()}")

    def __enter__(self) -> VideoWriter:
        return self

    def __exit__(self, exc_type, exc, tb) -> None:
        if exc_type is None:
            self.close()
        else:
            self._process.kill()
            self._process.wait()
            self._stderr.close()
