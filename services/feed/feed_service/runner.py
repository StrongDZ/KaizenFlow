"""Runner: vòng lặp nền đẩy World theo đồng hồ thật × tốc độ và phát bản tin ra sink."""
from __future__ import annotations

import threading
import time
from typing import Callable

from feed_service.emitter import Emitter
from feed_service.scale import Truth
from feed_service.world import World

MIN_SPEED, MAX_SPEED = 0.1, 2000.0


class Runner:
    def __init__(self, sink: Callable[[list[dict]], None], tick_s: float = 0.25):
        self.sink = sink
        self.tick_s = tick_s
        self._lock = threading.RLock()
        self._stop_evt = threading.Event()
        self._thread: threading.Thread | None = None
        self.world: World | None = None
        self.emitter: Emitter | None = None
        self.state = "idle"
        self.speed = 10.0
        self.model: str | None = None
        self.version_id: int | None = None
        self.sent = 0
        self.send_errors = 0
        self.last_error: str | None = None

    # --- điều khiển -------------------------------------------------------------------------
    def start(self, blueprint: dict, speed: float = 10.0, truth: Truth | None = None, seed: int = 7) -> None:
        world = World(blueprint, truth=truth, seed=seed)  # dựng ngoài khoá: mất khoảng một giây
        with self._lock:
            self.world, self.emitter = world, Emitter(world, seed=seed + 1)
            self.model, self.version_id = blueprint.get("model"), blueprint.get("version_id")
            self.speed = self._clamp(speed)
            self.state = "running"
            self.sent = self.send_errors = 0
            self.last_error = None
            first = self.emitter.messages()
            if self._thread is None or not self._thread.is_alive():
                self._stop_evt.clear()
                self._thread = threading.Thread(target=self._loop, name="feed-runner", daemon=True)
                self._thread.start()
        self._send(first)

    def pause(self) -> None:
        with self._lock:
            if self.state == "running":
                self.state = "paused"

    def resume(self) -> None:
        with self._lock:
            if self.state == "paused":
                self.state = "running"

    def stop(self) -> None:
        with self._lock:
            self.world = self.emitter = None
            self.state, self.model, self.version_id = "idle", None, None

    def shutdown(self) -> None:
        self.stop()
        self._stop_evt.set()
        if self._thread is not None:
            self._thread.join(timeout=2)

    @staticmethod
    def _clamp(speed: float) -> float:
        return min(MAX_SPEED, max(MIN_SPEED, float(speed)))

    def set_speed(self, speed: float) -> None:
        with self._lock:
            self.speed = self._clamp(speed)

    # --- sự cố ------------------------------------------------------------------------------
    def _need_world(self) -> World:
        if self.world is None:
            raise RuntimeError("feed chưa chạy: hãy bấm Bắt đầu trước")
        return self.world

    def add_incident(self, kind: str, target: str, duration_s: float | None = None, **params) -> dict:
        with self._lock:
            return self._need_world().add_incident(kind, target, duration_s, **params)

    def clear_incident(self, incident_id: int) -> bool:
        with self._lock:
            return self._need_world().clear_incident(incident_id)

    def list_incidents(self) -> list[dict]:
        with self._lock:
            return self.world.list_incidents() if self.world else []

    # --- trạng thái -------------------------------------------------------------------------
    def status(self) -> dict:
        with self._lock:
            w = self.world
            return {
                "state": self.state, "model": self.model, "version_id": self.version_id, "speed": self.speed,
                "virtual_now": w.virtual_now().isoformat() if w else None,
                "sent": self.sent, "send_errors": self.send_errors, "last_error": self.last_error,
                "truth": {"cycle_factor": w.truth.cycle_factor, "demand_factor": w.truth.demand_factor} if w else None,
                "vehicles": sum(len(v) for v in w.fleet.vehicles.values()) if w and w.fleet else 0,
                "deadlock_breaks": w.fleet.deadlock_breaks if w and w.fleet else 0,
                "has_map": bool(w and w.fleet),
                "incidents": w.list_incidents() if w else [],
            }

    # --- vòng lặp ---------------------------------------------------------------------------
    def _loop(self) -> None:
        last = time.monotonic()
        while not self._stop_evt.wait(self.tick_s):
            now = time.monotonic()
            dt, last = now - last, now
            with self._lock:
                if self.state != "running" or self.world is None or self.emitter is None:
                    continue
                self.world.step(dt * self.speed)
                msgs = self.emitter.messages()
            self._send(msgs)

    def _send(self, msgs: list[dict]) -> None:
        try:
            self.sink(msgs)
            self.sent += len(msgs)
        except Exception as exc:  # feed không được chết vì API tạm mất
            self.send_errors += 1
            self.last_error = f"{type(exc).__name__}: {exc}"
