"""Xe chạy trên bản đồ AGV: mỗi làn là một tài nguyên SimPy nên kẹt xe tự sinh ra.

Hai loại xe theo `kind` của pool (theo trả lời của BTC DENSO):
- AGV: đi băng từ, tuyến cố định; gặp vật cản thì đứng chờ (quá thời gian chờ quy định thì người quản lý xử lý: đếm ở `deadlock_breaks`).
- AMR: FMS điều xe rảnh gần nhất tới chỗ lấy hàng, đi đường ngắn nhất theo tình hình tắc (chờ hoặc đi vòng), xe ở lại điểm trả hàng,
  có pin: hao theo quãng đường, thấp thì tự về chỗ sạc (bản đồ có điểm `charger`).
Các loại khác (xe kéo, xe nâng...) giữ cách chạy cũ: chọn lại đường ở mỗi ngã tư, luôn quay về trạm nguồn sau chuyến.
"""
from __future__ import annotations

import math
from dataclasses import dataclass, field

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
    heading: float = 0.0       # hướng cuối cùng (độ), giữ lại khi xe đứng
    kind: str = "TUGGER"       # kind của pool: AGV | AMR | TUGGER | FORKLIFT
    battery: float | None = None   # % pin; None khi không mô hình hoá (không phải AMR, hoặc bản đồ chưa có chỗ sạc)
    speed: float = 0.0         # m/s đang chạy (0 khi đứng)
    dest: str | None = None    # điểm đích của chặng đang chạy
    route: list[str] = field(default_factory=list)  # các điểm còn phải qua tới đích
    approach_s: float = 0.0    # thời gian chạy rỗng tới chỗ lấy hàng của chuyến hiện tại


@dataclass
class DriveResult:
    wait_s: float
    ideal_s: float


class Fleet:
    """Trạng thái giao thông của mọi đội xe trên một bản đồ.

    retry_s: bao lâu thử tìm đường lại khi không còn đường (bị chặn hết).
    deadlock_s: chờ vào làn quá lâu thì "chen" qua (không giữ làn mới) và đếm vào deadlock_breaks.
    """

    def __init__(self, graph: MapGraph, *, retry_s: float = 5.0, deadlock_s: float = 600.0, jitter: float = 0.1, seed: int = 0,
                 drain_per_m: float = 0.004, battery_range: tuple[float, float] = (55.0, 100.0), low_pct: float = 25.0,
                 full_pct: float = 95.0, charge_pct_per_s: float = 100.0 / 3600.0, floor_pct: float = 2.0):
        self.graph = graph
        self.drain_per_m = drain_per_m          # % pin mỗi mét (xe có hàng hao thêm 30 %)
        self.battery_range = battery_range      # pin lúc bắt đầu của mỗi xe AMR
        self.low_pct, self.full_pct = low_pct, full_pct
        self.charge_pct_per_s = charge_pct_per_s
        self.floor_pct = floor_pct              # xe không bao giờ hết sạch pin giữa đường
        self.charger_points = [p.id for p in graph.points.values() if p.kind == "charger"]
        self.charger_res: dict[str, simpy.Resource] = {}
        self.charges = 0
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
        self.charger_res = {pid: simpy.Resource(ctx.env, capacity=1) for pid in self.charger_points}

    def covers(self, spec) -> bool:
        return self.graph.best_pair(spec.src, spec.dst) is not None

    def make_edge(self, ctx, spec):
        """edge_factory cho sim_service.engine.build: edge POOL có trạm trên bản đồ thì chạy theo bản đồ."""
        self.bind(ctx)
        if spec.mode == "POOL" and self.covers(spec):
            return MapTransfer(ctx, spec, self)
        return Transfer(ctx, spec)

    def ensure_pool(self, pool_key: str, count: int, home: str, kind: str = "TUGGER") -> list[Vehicle]:
        if pool_key not in self.vehicles:
            base = pool_key.upper().replace("_", "-")
            modelled = kind == "AMR" and bool(self.charger_points)  # pin chỉ có nghĩa khi bản đồ có chỗ sạc
            self.vehicles[pool_key] = [
                Vehicle(f"{base}-{i + 1:02d}", pool_key, point=home, kind=kind,
                        battery=round(float(self.rng.uniform(*self.battery_range)), 1) if modelled else None)
                for i in range(count)
            ]
        return self.vehicles[pool_key]

    # --- xe -----------------------------------------------------------------------------------
    def _dist(self, a: str | None, b: str) -> float:
        """Độ dài đường ngắn nhất (m) theo độ dài làn, bỏ qua tắc; inf nếu không có đường."""
        if a is None or a not in self.graph.points:
            return math.inf
        if a == b:
            return 0.0
        path = self.graph.shortest(a, b, lambda lane: lane.length_m)
        return math.inf if path is None else sum(lane.length_m for lane in path)

    def pick(self, pool_key: str, at_point: str) -> Vehicle | None:
        """Xe rảnh sẽ nhận chuyến lấy hàng ở `at_point`: AMR thì xe gần nhất (FMS điều xe gần vị trí phù hợp), loại khác thì xe rảnh đầu tiên. None nếu không có xe rảnh."""
        idle = [v for v in self.vehicles[pool_key] if not v.busy]
        if not idle:
            return None
        if idle[0].kind != "AMR":
            return idle[0]
        return min(idle, key=lambda v: self._dist(v.point, at_point))

    def assign(self, veh: Vehicle, at_point: str) -> None:
        veh.busy, veh.lane, veh.state, veh.dur, veh.speed = True, None, "LOADING", 0.0, 0.0
        if veh.kind != "AMR":
            veh.point = at_point  # xe kiểu cũ coi như nằm sẵn ở chỗ lấy hàng; AMR phải tự chạy tới (xem MapTransfer._approach)

    def acquire(self, pool_key: str, at_point: str) -> Vehicle:
        veh = self.pick(pool_key, at_point)
        if veh is None:
            raise RuntimeError(f"pool {pool_key}: không còn xe rảnh (engine cấp nhiều hơn số xe?)")
        self.assign(veh, at_point)
        return veh

    def release(self, veh: Vehicle) -> None:
        veh.busy, veh.state, veh.load, veh.lane, veh.speed = False, "IDLE", 0.0, None, 0.0
        veh.dest, veh.route = None, []
        if veh.battery is not None and veh.battery < self.low_pct and self.charger_points:
            veh.busy = True  # đi sạc: chưa nhận chuyến được
            self.env.process(self._charge(veh))

    # --- pin ----------------------------------------------------------------------------------
    def _drain(self, veh: Vehicle, lane: Lane) -> None:
        if veh.battery is not None:
            veh.battery = max(self.floor_pct, veh.battery - lane.length_m * self.drain_per_m * (1.3 if veh.load > 0 else 1.0))

    def _charge(self, veh: Vehicle):
        """Về chỗ sạc gần nhất (xếp hàng nếu có xe đang sạc), sạc tới `full_pct`, rồi nhận chuyến lại."""
        env = self.env
        target = min(self.charger_points, key=lambda c: self._dist(veh.point, c))
        if math.isinf(self._dist(veh.point, target)):
            veh.busy = False  # không có đường tới chỗ sạc: đành chạy tiếp
            return
        self.charges += 1
        yield from self.drive(veh, target)
        with self.charger_res[target].request() as req:
            veh.state = "WAITING" if not req.triggered else "CHARGING"
            yield req
            veh.state, veh.speed = "CHARGING", 0.0
            yield env.timeout(max(0.0, self.full_pct - (veh.battery or 0.0)) / self.charge_pct_per_s)
            veh.battery = self.full_pct
        veh.state, veh.busy = "IDLE", False

    def pose(self, veh: Vehicle, now: float) -> tuple[float, float, float] | None:
        """(x, y, hướng độ) của xe trên bản đồ; None nếu chưa có chỗ đứng."""
        if veh.lane is None:
            if veh.point is None:
                return None
            x, y = self.graph.xy_of(veh.point)
            return (x, y, veh.heading)
        frac = min(1.0, (now - veh.t0) / veh.dur) if veh.state == "MOVING" and veh.dur > 0 else 1.0
        x, y, veh.heading = self.graph.pose_on_lane(veh.lane, frac)
        return (x, y, veh.heading)

    def xy(self, veh: Vehicle, now: float) -> tuple[float, float] | None:
        p = self.pose(veh, now)
        return None if p is None else (p[0], p[1])

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
        static = lambda lane: lane.length_m  # noqa: E731
        cost = static if veh.kind == "AGV" else self._cost  # AGV đi tuyến cố định: không né làn tắc hay bị chặn, chỉ chờ
        ideal_path = graph.shortest(veh.point, dst, static)
        ideal = sum(l.length_m for l in ideal_path) / self.speed if ideal_path else 0.0
        wait = 0.0
        held: tuple[str, simpy.Request | None] | None = None
        cur = veh.point
        veh.dest = dst
        while cur != dst:
            path = graph.shortest(cur, dst, cost)
            if not path:
                veh.state, veh.speed = "WAITING", 0.0
                yield env.timeout(self.retry_s)
                wait += self.retry_s
                continue
            veh.route = [l.to for l in path]
            lane = path[0]
            res = self.res[lane.id]
            req = res.request()
            t_req = env.now
            if not req.triggered:
                veh.state, veh.speed = "WAITING", 0.0
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
            veh.speed = lane.length_m / veh.dur
            yield env.timeout(veh.dur)
            self._drain(veh, lane)
            cur = lane.to
            veh.point = cur
        if held is not None and held[1] is not None:
            self.res[held[0]].release(held[1])
        veh.lane, veh.state, veh.dur, veh.speed = None, "IDLE", 0.0, 0.0
        veh.dest, veh.route = None, []
        return DriveResult(wait, ideal)

    # --- đo -----------------------------------------------------------------------------------
    def record_trip(self, edge: str, dur: float, wait: float, ideal: float, appr: float = 0.0) -> None:
        """dur/wait/ideal chỉ tính chặng có hàng (cho hiệu chỉnh `trip_s`); appr là thời gian chạy rỗng tới chỗ lấy hàng (AMR)."""
        self.trips.append({"edge": edge, "dur": dur, "wait": wait, "ideal": ideal, "appr": appr})

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
        self.kind = ctx.pools[spec.pool].kind
        self.roaming = self.kind == "AMR"  # AMR tự hành: ở lại điểm trả hàng, chạy rỗng tới chỗ lấy hàng của chuyến sau
        self.src_pt, self.dst_pt = fleet.graph.best_pair(spec.src, spec.dst)  # node nhiều chỗ đỗ: dùng cặp gần nhau nhất
        fleet.ensure_pool(spec.pool, ctx.pools[spec.pool].count, self.src_pt, self.kind)

    def _take_vehicle(self, pool):
        while True:
            veh = self.fleet.pick(pool.key, self.src_pt)
            if veh is not None:
                self.fleet.assign(veh, self.src_pt)
                return veh
            yield self.ctx.env.timeout(self.fleet.retry_s)  # mọi xe đang bận hoặc đang sạc: chờ

    def _phase(self, veh, phase: str) -> None:
        if phase == "UNLOAD":
            veh.load = 0.0
        veh.state = "LOADING"

    def _approach(self, veh):
        veh.approach_s = 0.0
        if not self.roaming:
            return
        if veh.point != self.src_pt:
            t0 = self.ctx.env.now
            veh.load = 0.0
            yield from self.fleet.drive(veh, self.src_pt)
            veh.approach_s = self.ctx.env.now - t0
        veh.state = "LOADING"

    def _leg(self, veh, kind: str):
        loading = kind == "LOAD"
        if not loading and self.roaming:
            return  # AMR không quay về nguồn
        veh.load = float(self.spec.lot) if loading else 0.0
        t0 = self.ctx.env.now
        result = yield from self.fleet.drive(veh, self.dst_pt if loading else self.src_pt)
        if loading:
            self.fleet.record_trip(self.key, self.ctx.env.now - t0, result.wait_s, result.ideal_s, veh.approach_s)

    def _vehicle_freed(self, pool, veh) -> None:
        self.fleet.release(veh)
