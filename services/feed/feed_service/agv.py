"""Xe chạy trên bản đồ AGV: mỗi làn là một tài nguyên SimPy nên kẹt xe tự sinh ra, đường đi chọn lại ở mỗi ngã tư."""
from __future__ import annotations

import math
from dataclasses import dataclass

import numpy as np
import simpy
from sim_service.transport import Transfer

from feed_service.mapgraph import Lane, MapGraph


@dataclass
class Vehicle:
    id: str
    pool: str
    point: str | None = None   # điểm đang đứng (khi không ở trên làn nào)
    lane: str | None = None    # làn đang giữ
    state: str = "IDLE"        # IDLE | LOADING | MOVING | WAITING
    load: float = 0.0
    t0: float = 0.0            # lúc bắt đầu chạy làn hiện tại
    dur: float = 0.0           # thời gian chạy hết làn hiện tại
    busy: bool = False


@dataclass
class DriveResult:
    wait_s: float
    ideal_s: float


class Fleet:
    """Trạng thái giao thông của mọi đội xe trên một bản đồ.

    retry_s: bao lâu thử tìm đường lại khi không còn đường (bị chặn hết).
    deadlock_s: chờ vào làn quá lâu thì "chen" qua (không giữ làn mới) và đếm vào deadlock_breaks.
    """

    def __init__(self, graph: MapGraph, *, retry_s: float = 5.0, deadlock_s: float = 600.0, jitter: float = 0.1, seed: int = 0):
        self.graph = graph
        self.speed = graph.speed_mps
        self.retry_s = retry_s
        self.deadlock_s = deadlock_s
        self.jitter = jitter
        self.rng = np.random.default_rng(seed)
        self.ctx = None
        self.env: simpy.Environment | None = None
        self.res: dict[str, simpy.Resource] = {}
        self.blocked: dict[str, float] = {}
        self.holds: dict[str, simpy.Process] = {}
        self.vehicles: dict[str, list[Vehicle]] = {}
        self.trips: list[dict] = []
        self.deadlock_breaks = 0

    # --- gắn vào engine -----------------------------------------------------------------------
    def bind(self, ctx) -> None:
        if self.ctx is ctx:
            return
        self.ctx, self.env = ctx, ctx.env
        self.res = {lid: simpy.Resource(ctx.env, capacity=lane.capacity) for lid, lane in self.graph.lanes.items()}

    def covers(self, spec) -> bool:
        return self.graph.station_of(spec.src) is not None and self.graph.station_of(spec.dst) is not None

    def make_edge(self, ctx, spec):
        """edge_factory cho sim_service.engine.build: edge POOL có trạm trên bản đồ thì chạy theo bản đồ."""
        self.bind(ctx)
        if spec.mode == "POOL" and self.covers(spec):
            return MapTransfer(ctx, spec, self)
        return Transfer(ctx, spec)

    def ensure_pool(self, pool_key: str, count: int, home: str) -> list[Vehicle]:
        if pool_key not in self.vehicles:
            base = pool_key.upper().replace("_", "-")
            self.vehicles[pool_key] = [Vehicle(f"{base}-{i + 1:02d}", pool_key, point=home) for i in range(count)]
        return self.vehicles[pool_key]

    # --- xe -----------------------------------------------------------------------------------
    def acquire(self, pool_key: str, at_point: str) -> Vehicle:
        for v in self.vehicles[pool_key]:
            if not v.busy:
                v.busy, v.point, v.lane, v.state, v.dur = True, at_point, None, "LOADING", 0.0
                return v
        raise RuntimeError(f"pool {pool_key}: không còn xe rảnh (engine cấp nhiều hơn số xe?)")

    def release(self, veh: Vehicle) -> None:
        veh.busy, veh.state, veh.load, veh.lane = False, "IDLE", 0.0, None

    def xy(self, veh: Vehicle, now: float) -> tuple[float, float] | None:
        if veh.lane is None:
            return self.graph.xy_of(veh.point) if veh.point is not None else None
        frac = min(1.0, (now - veh.t0) / veh.dur) if veh.state == "MOVING" and veh.dur > 0 else 1.0
        return self.graph.xy_on_lane(veh.lane, frac)

    # --- chi phí, chặn làn --------------------------------------------------------------------
    def _cost(self, lane: Lane) -> float:
        if self.blocked.get(lane.id, -1.0) > self.env.now:
            return math.inf
        res = self.res[lane.id]
        base = lane.length_m / self.speed
        return base * (1.0 + 0.5 * len(res.queue) + (0.25 if res.count >= res.capacity else 0.0))

    def block(self, lane_id: str, until: float, *, avoid: bool = True) -> None:
        """Chặn làn đến giờ mô phỏng `until`: chiếm hết chỗ của làn. avoid=True thì xe cũng coi làn là không đi được khi chọn đường."""
        if lane_id not in self.res:
            raise KeyError(lane_id)
        if avoid:
            self.blocked[lane_id] = until
        self.holds[lane_id] = self.env.process(self._hold(lane_id, until))

    def unblock(self, lane_id: str) -> None:
        """Gỡ chặn ngay: xoá cờ tránh đường và nhả các chỗ đang chiếm."""
        self.blocked.pop(lane_id, None)
        proc = self.holds.pop(lane_id, None)
        if proc is not None and proc.is_alive:
            proc.interrupt()

    def _hold(self, lane_id: str, until: float):
        res = self.res[lane_id]
        reqs = [res.request() for _ in range(res.capacity)]
        try:
            yield self.env.all_of(reqs) | self.env.timeout(max(0.0, until - self.env.now))
            remaining = until - self.env.now
            if remaining > 0 and all(r.triggered for r in reqs):
                yield self.env.timeout(remaining)
        except simpy.Interrupt:
            pass
        finally:
            for r in reqs:
                res.release(r) if r.triggered else r.cancel()

    # --- chạy ---------------------------------------------------------------------------------
    def drive(self, veh: Vehicle, dst: str):
        """Tiến trình SimPy: đưa xe từ điểm hiện tại tới `dst`. Giữ làn hiện tại đến khi vào được làn kế."""
        env, graph = self.env, self.graph
        ideal_path = graph.shortest(veh.point, dst, lambda lane: lane.length_m)
        ideal = sum(l.length_m for l in ideal_path) / self.speed if ideal_path else 0.0
        wait = 0.0
        held: tuple[str, simpy.Request | None] | None = None
        cur = veh.point
        while cur != dst:
            path = graph.shortest(cur, dst, self._cost)
            if not path:
                veh.state = "WAITING"
                yield env.timeout(self.retry_s)
                wait += self.retry_s
                continue
            lane = path[0]
            res = self.res[lane.id]
            req = res.request()
            t_req = env.now
            if not req.triggered:
                veh.state = "WAITING"
            yield req | env.timeout(self.deadlock_s)
            if not req.triggered:
                req.cancel()
                req = None
                self.deadlock_breaks += 1
            wait += env.now - t_req
            if held is not None and held[1] is not None:
                self.res[held[0]].release(held[1])
            held = (lane.id, req)
            veh.lane, veh.state, veh.t0 = lane.id, "MOVING", env.now
            veh.dur = lane.length_m / (self.speed * (1.0 + self.jitter * float(self.rng.uniform(-1.0, 1.0))))
            yield env.timeout(veh.dur)
            cur = lane.to
            veh.point = cur
        if held is not None and held[1] is not None:
            self.res[held[0]].release(held[1])
        veh.lane, veh.state, veh.dur = None, "IDLE", 0.0
        return DriveResult(wait, ideal)

    # --- đo -----------------------------------------------------------------------------------
    def record_trip(self, edge: str, dur: float, wait: float, ideal: float) -> None:
        self.trips.append({"edge": edge, "dur": dur, "wait": wait, "ideal": ideal})

    def drain_trips(self) -> list[dict]:
        out, self.trips = self.trips, []
        return out

    def lane_load(self) -> dict[str, dict[str, int]]:
        """Số xe đang giữ và đang chờ ở từng làn."""
        return {lid: {"holding": r.count, "queue": len(r.queue), "capacity": r.capacity} for lid, r in self.res.items()}


class MapTransfer(Transfer):
    """Edge POOL có chuyến đi/về theo bản đồ thay cho mẫu `travel`."""

    def __init__(self, ctx, spec, fleet: Fleet):
        super().__init__(ctx, spec)
        self.fleet = fleet
        self.src_pt = fleet.graph.station_of(spec.src)
        self.dst_pt = fleet.graph.station_of(spec.dst)
        fleet.ensure_pool(spec.pool, ctx.pools[spec.pool].count, self.src_pt)

    def _vehicle_got(self, pool):
        return self.fleet.acquire(pool.key, self.src_pt)

    def _phase(self, veh, phase: str) -> None:
        if phase == "UNLOAD":
            veh.load = 0.0
        veh.state = "LOADING"

    def _leg(self, veh, kind: str):
        loading = kind == "LOAD"
        veh.load = float(self.spec.lot) if loading else 0.0
        t0 = self.ctx.env.now
        result = yield from self.fleet.drive(veh, self.dst_pt if loading else self.src_pt)
        if loading:
            self.fleet.record_trip(self.key, self.ctx.env.now - t0, result.wait_s, result.ideal_s)

    def _vehicle_freed(self, pool, veh) -> None:
        self.fleet.release(veh)
