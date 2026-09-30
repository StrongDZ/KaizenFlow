"""Edge (Transfer) và pool xe/người."""
from __future__ import annotations

import simpy

from sim_service.contract import ContractError, EdgeSpec, PoolSpec
from sim_service.dists import make_sampler


class Transfer:
    category = "edges"

    def __init__(self, ctx, spec: EdgeSpec):
        self.ctx = ctx
        self.spec = spec
        self.key = spec.key
        self.src = ctx.nodes[spec.src]
        self.dst = ctx.nodes[spec.dst]
        self.src.out_box(spec.material)
        cap = self.dst.in_box(spec.material).capacity
        lot = max(spec.lot, self.dst.lot_for(spec.material, spec.lot))
        if lot > cap:
            raise ContractError(spec.key, f"lot {lot} exceeds '{spec.dst}' capacity {cap:g}")
        self.travel = make_sampler(spec.travel, ctx.stream(f"{spec.key}:travel"))
        self.in_transit = 0.0
        self.moved = 0.0  # tổng đơn vị đã giao tới nơi trong khoảng được ghi (sau warm-up)

    def workers(self) -> int:
        s = self.spec
        if s.workers:
            return s.workers
        if s.mode == "CONVEYOR":
            return max(1, (s.max_in_transit or s.lot) // s.lot)
        if s.mode == "POOL":
            return self.ctx.pools[s.pool].count
        return 1

    def start(self):
        for _ in range(self.workers()):
            self.ctx.env.process(self._worker())

    def _worker(self):
        if self.spec.mode == "POOL":
            yield from self._pool_worker()
        else:
            yield from self._direct_worker()

    def _direct_worker(self):
        env, m, rec = self.ctx.env, self.spec.material, self.ctx.rec
        while True:
            lot = self.dst.lot_for(m, self.spec.lot)
            while not self.dst.wants(m, lot):
                yield env.timeout(self.spec.poll_s)
            # Lấy hàng trước rồi mới giữ chỗ: worker đang chờ nguồn chậm không chiếm buffer đích.
            yield from self.src.take(m, lot)
            self.dst.reserve(m, lot)
            self.in_transit += lot
            rec.event(env.now, self.key, "TASK_START", {"qty": lot})
            yield env.timeout(self.travel())
            yield from self.dst.give(m, lot)
            self.dst.unreserve(m, lot)
            self.in_transit -= lot
            self._delivered(lot)
            rec.event(env.now, self.key, "TASK_END", {"qty": lot})

    def _pool_worker(self):
        env, m, rec = self.ctx.env, self.spec.material, self.ctx.rec
        pool = self.ctx.pools[self.spec.pool]
        hook = self.ctx.pools[self.spec.hook_pool] if self.spec.hook_pool else None
        while True:
            lot = self.dst.lot_for(m, self.spec.lot)
            while not (self.dst.wants(m, lot) and self.src.available(m) >= lot):
                yield env.timeout(self.spec.poll_s)
            self.dst.reserve(m, lot)
            self.src.claim(m, lot)
            t_req = env.now
            with pool.res.request() as vehicle:
                yield vehicle
                veh = self._vehicle_got(pool)
                self._phase(veh, "PICKUP")
                t_acq = env.now
                rec.tally(env.now, self.key, "WAIT_POOL", t_acq - t_req)
                if hook is not None and self.spec.hook_at_load:
                    yield from self._hook(hook)
                yield from self.src.take(m, lot)
                self.src.unclaim(m, lot)
                yield env.timeout(pool.service())
                self.in_transit += lot
                rec.event(env.now, self.key, "TASK_START", {"qty": lot})
                yield from self._leg(veh, "LOAD")
                self._phase(veh, "UNLOAD")
                if hook is not None and self.spec.hook_at_unload:
                    yield from self._hook(hook)
                yield from self.dst.give(m, lot)
                self.dst.unreserve(m, lot)
                self.in_transit -= lot
                self._delivered(lot)
                rec.event(env.now, self.key, "TASK_END", {"qty": lot})
                yield from self._leg(veh, "RETURN")
                pool.add_busy(t_acq, env.now)
                self._vehicle_freed(pool, veh)

    # --- điểm móc cho feed (bản đồ AGV): mặc định không làm gì, thời gian chặng = mẫu `travel` ---
    def _vehicle_got(self, pool):
        """Xe vừa được cấp cho chuyến này; trả token nhận dạng xe (mặc định None)."""
        return None

    def _phase(self, veh, phase: str) -> None:
        """Đổi giai đoạn của chuyến: 'PICKUP' (xe đã nhận, đang móc/lấy hàng), 'UNLOAD' (đã tới đích)."""

    def _leg(self, veh, kind: str):
        """Một chặng có xe: 'LOAD' (nguồn → đích, có hàng) rồi 'RETURN' (đích → nguồn, rỗng)."""
        yield self.ctx.env.timeout(self.travel())

    def _vehicle_freed(self, pool, veh) -> None:
        """Chuyến xong, trả xe."""

    def _hook(self, hook):
        env = self.ctx.env
        t = env.now
        with hook.res.request() as op:
            yield op
            self.ctx.rec.tally(env.now, self.key, "WAIT_HOOK", env.now - t)
            t1 = env.now
            yield env.timeout(hook.service())
            hook.add_busy(t1, env.now)

    def _delivered(self, lot):
        if self.ctx.rec.recording(self.ctx.env.now):
            self.moved += lot

    def sample(self, now):
        self.ctx.rec.sample(now, self.key, "in_transit", self.in_transit)
        self.ctx.rec.sample(now, self.key, "moved", self.moved)

    def kpi(self):
        t = self.ctx.rec.tallies

        def mean(name):
            v = t.get((self.key, name), [])
            return float(sum(v) / len(v)) if v else 0.0

        return {"wait_pool_mean": mean("WAIT_POOL"), "wait_hook_mean": mean("WAIT_HOOK")}


class Pool:
    category = "pools"

    def __init__(self, ctx, spec: PoolSpec):
        self.ctx = ctx
        self.key = spec.key
        self.kind = spec.kind
        self.count = spec.count
        self.res = simpy.Resource(ctx.env, capacity=spec.count)
        self.service = make_sampler(spec.service, ctx.stream(f"{spec.key}:service"), default=0.0)
        self.busy_s = 0.0

    def add_busy(self, start: float, end: float) -> None:
        a = max(start, self.ctx.warmup)
        if end > a:
            self.busy_s += end - a

    def start(self) -> None:
        pass

    def sample(self, now) -> None:
        self.ctx.rec.sample(now, self.key, "busy", self.res.count)
        self.ctx.rec.sample(now, self.key, "queue_len", len(self.res.queue))

    def kpi(self) -> dict:
        return {"util": self.busy_s / (self.count * self.ctx.req.horizon_s), "count": self.count}
