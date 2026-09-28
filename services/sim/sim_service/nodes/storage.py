from collections import defaultdict, deque

import simpy

from sim_service.nodes.base import INF, FlowNode, register

_RANK = {"GREEN": 0, "YELLOW": 1, "RED": 2}
NO_USE_COVERAGE = 999.0


@register("STORAGE")
class Storage(FlowNode):
    category = "storages"

    def __init__(self, ctx, spec):
        super().__init__(ctx, spec)
        self.capacity = float(self.p.get("capacity", INF))
        self.boxes: dict[str, simpy.Container] = {}
        for s in self.p.get("stock", []):
            mx = float(s.get("max", self.capacity))
            self.boxes[s["material"]] = simpy.Container(ctx.env, capacity=mx,
                                                        init=min(float(s.get("initial", 0)), mx))
        th = self.p.get("coverage_thresholds", {})
        self.red_h = float(th.get("red_h", 1.0))
        self.ylo_h = float(th.get("yellow_low_h", 4.0))
        self.yhi_h = float(th.get("yellow_high_h", 12.0))
        rp = self.p.get("replenish", {})
        self.policy = rp.get("policy", "NONE")
        self.rop = float(rp.get("rop", 0))
        self.rqty = rp.get("qty")
        self.window_s = float(self.p.get("coverage_window_s", 3600.0))
        self.takes: dict[str, deque] = defaultdict(deque)

    def _box(self, m):
        if m not in self.boxes:
            self.boxes[m] = simpy.Container(self.env, capacity=self.capacity)
        return self.boxes[m]

    def in_box(self, m):
        return self._box(m)

    def out_box(self, m):
        return self._box(m)

    def wants(self, m, lot):
        if self.policy == "REORDER_POINT":
            return self._box(m).level + self.reserved[m] <= self.rop and self.room(m) >= lot
        return self.room(m) >= lot

    def lot_for(self, m, default):
        if self.policy == "REORDER_POINT" and self.rqty:
            return int(self.rqty)
        return default

    def on_take(self, m, q):
        self.takes[m].append((self.env.now, q))

    def rate_per_h(self, m, now) -> float:
        dq = self.takes[m]
        while dq and dq[0][0] < now - self.window_s:
            dq.popleft()
        return sum(q for _, q in dq) / self.window_s * 3600.0

    def coverage_h(self, m, now) -> float:
        r = self.rate_per_h(m, now)
        return NO_USE_COVERAGE if r <= 0 else self._box(m).level / r

    def color_for(self, cov: float) -> str:
        if cov >= NO_USE_COVERAGE:
            return "GREEN"
        if cov < self.red_h:
            return "RED"
        if cov < self.ylo_h or cov > self.yhi_h:
            return "YELLOW"
        return "GREEN"

    def sample(self, now):
        worst, min_cov = "GREEN", NO_USE_COVERAGE
        for m, box in self.boxes.items():
            self.rec.sample(now, self.key, f"level:{m}", box.level)
            cov = self.coverage_h(m, now)
            min_cov = min(min_cov, cov)
            c = self.color_for(cov)
            if _RANK[c] > _RANK[worst]:
                worst = c
        self.rec.sample(now, self.key, "coverage_h", min_cov)
        self.rec.state(now, self.key, worst, etype="COLOR_CHANGE")

    def kpi(self):
        reds = [(a, b) for st, a, b in self.rec.intervals.get(self.key, []) if st == "RED"]
        return {"red_s": sum(b - a for a, b in reds),
                "first_red_s": reds[0][0] if reds else None,
                "level_end": {m: b.level for m, b in self.boxes.items()}}
