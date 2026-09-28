"""Gom tín hiệu, sự kiện, chuỗi mẫu, khoảng trạng thái và tally cho một replication."""
from __future__ import annotations

from collections import defaultdict
from datetime import datetime, timedelta


class Recorder:
    def __init__(self, sim_start: datetime, record_from: float, keep_raw: bool):
        self.sim_start = sim_start
        self.record_from = float(record_from)
        self.keep_raw = keep_raw
        self.signals: list[tuple] = []
        self.events: list[tuple] = []
        self.series: dict = defaultdict(list)
        self.intervals: dict = defaultdict(list)
        self.tallies: dict = defaultdict(list)
        self._cur: dict = {}

    def ts(self, now: float) -> datetime:
        return self.sim_start + timedelta(seconds=now - self.record_from)

    def recording(self, now: float) -> bool:
        return now >= self.record_from

    def signal(self, now, subject, name, value) -> None:
        if self.keep_raw and self.recording(now):
            self.signals.append((self.ts(now), subject, name, float(value)))

    def event(self, now, subject, type_, payload=None) -> None:
        if self.keep_raw and self.recording(now):
            self.events.append((self.ts(now), subject, type_, payload or {}))

    def sample(self, now, subject, metric, value) -> None:
        if self.recording(now):
            self.series[(subject, metric)].append((now - self.record_from, float(value)))
        self.signal(now, subject, metric, value)

    def state(self, now, subject, state, etype="STATE", **payload) -> None:
        cur = self._cur.get(subject)
        if cur is not None and cur[0] == state:
            return
        if cur is not None:
            self._close(subject, cur, now)
        self._cur[subject] = (state, now)
        self.event(now, subject, etype, {"state": state, **payload})

    def tally(self, now, subject, name, value) -> None:
        if self.recording(now):
            self.tallies[(subject, name)].append(float(value))
        self.event(now, subject, name, {"duration_s": float(value)})

    def _close(self, subject, cur, now) -> None:
        start = max(cur[1], self.record_from)
        if now > start:
            self.intervals[subject].append((cur[0], start - self.record_from, now - self.record_from))

    def finalize(self, now: float) -> None:
        for subject, cur in list(self._cur.items()):
            self._close(subject, cur, now)
            self._cur[subject] = (cur[0], now)
