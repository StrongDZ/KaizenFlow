"""Edge (Transfer) và pool xe/người."""
from __future__ import annotations

from sim_service.contract import EdgeSpec
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
        self.dst.in_box(spec.material)
        self.travel = make_sampler(spec.travel, ctx.rng)
        self.in_transit = 0.0

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
        yield from self._direct_worker()

    def _direct_worker(self):
        env, m, rec = self.ctx.env, self.spec.material, self.ctx.rec
        while True:
            lot = self.dst.lot_for(m, self.spec.lot)
            while not self.dst.wants(m, lot):
                yield env.timeout(self.spec.poll_s)
            self.dst.reserve(m, lot)
            yield from self.src.take(m, lot)
            self.in_transit += lot
            rec.event(env.now, self.key, "TASK_START", {"qty": lot})
            yield env.timeout(self.travel())
            yield from self.dst.give(m, lot)
            self.dst.unreserve(m, lot)
            self.in_transit -= lot
            rec.event(env.now, self.key, "TASK_END", {"qty": lot})

    def sample(self, now):
        self.ctx.rec.sample(now, self.key, "in_transit", self.in_transit)

    def kpi(self):
        t = self.ctx.rec.tallies

        def mean(name):
            v = t.get((self.key, name), [])
            return float(sum(v) / len(v)) if v else 0.0

        return {"wait_pool_mean": mean("WAIT_POOL"), "wait_hook_mean": mean("WAIT_HOOK")}
