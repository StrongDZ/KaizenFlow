"""Camera readers: one thread per stream, keeping only the latest frame."""

from __future__ import annotations

import threading
import time

import cv2
import numpy as np


class Camera:
    """Reads a stream continuously and hands out frames at sample_fps.

    The stream is read at its own rate so the decoder never falls behind;
    frames between two samples are dropped. A lost stream is reopened.
    """

    def __init__(self, url: str, sample_fps: float, reconnect_s: float = 2.0) -> None:
        self.url, self.reconnect_s = url, reconnect_s
        self.interval_s = 1.0 / max(sample_fps, 0.1)
        self._lock = threading.Lock()
        self._latest: tuple[np.ndarray, int] | None = None
        self._next_sample = 0.0
        self._stop = threading.Event()
        self.frames_read = 0
        self.reconnects = 0
        self._thread = threading.Thread(target=self._run, name=f"camera-{url}", daemon=True)
        self._thread.start()

    def _run(self) -> None:
        while not self._stop.is_set():
            capture = cv2.VideoCapture(self.url, cv2.CAP_FFMPEG)
            while not self._stop.is_set():
                ok, frame = capture.read()
                if not ok:
                    break
                self.frames_read += 1
                now = time.monotonic()
                if now >= self._next_sample:
                    self._next_sample = max(self._next_sample + self.interval_s, now)
                    # The capture timestamp is the wall clock at decode time.
                    with self._lock:
                        self._latest = (frame, time.time_ns() // 1_000_000)
            capture.release()
            self.reconnects += 1
            self._stop.wait(self.reconnect_s)

    def take(self) -> tuple[np.ndarray, int] | None:
        """Returns the newest sampled frame once, or None if there is none."""
        with self._lock:
            latest, self._latest = self._latest, None
        return latest

    def close(self) -> None:
        self._stop.set()
        self._thread.join(timeout=5)
