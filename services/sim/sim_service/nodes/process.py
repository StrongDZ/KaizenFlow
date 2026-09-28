from collections import defaultdict

import simpy

from sim_service.contract import ContractError
from sim_service.dists import make_sampler
from sim_service.health import Health
from sim_service.nodes.base import FlowNode, register


@register("PROCESS")
class Process(FlowNode):
    category = "processes"

    def __init__(self, ctx, spec):
        super().__init__(ctx, spec)
        r = self.p["recipes"][0]
        self.inputs = [(i["material"], float(i["qty"])) for i in r.get("inputs", [])]
        self.outputs = [(o["material"], float(o["qty"]), o.get("port", "OK")) for o in r.get("outputs", [])]
        in_cap = self.p.get("in_buffer")
        self.in_boxes = {m: simpy.Container(ctx.env, capacity=float(in_cap) if in_cap is not None else 2 * q)
                         for m, q in self.inputs}
        self._out_cap = self.p.get("out_buffer")
        self.out_boxes = {m: simpy.Container(ctx.env) for m, _, _ in self.outputs}
        self.cycle = make_sampler(self.p.get("cycle"), ctx.stream(f"{spec.key}:cycle"), default=1.0)
        self.ng_rng = ctx.stream(f"{spec.key}:ng")
        self.slots = int(self.p.get("slots", 1))
        self.ng_rate = float(self.p.get("ng_rate", 0.0))
        self.slot_state = ["STARVED"] * self.slots
        self.counts = defaultdict(float)
        self.health = Health(ctx, self)

    def in_box(self, m):
        if m not in self.in_boxes:
            raise ContractError(self.key, f"does not consume '{m}'")
        return self.in_boxes[m]

    def out_box(self, m):
        if m not in self.out_boxes:
            raise ContractError(self.key, f"does not produce '{m}'")
        return self.out_boxes[m]

    def mark_output_edge(self, m):
        self.out_box(m)
        qty = next(q for mm, q, _ in self.outputs if mm == m)
        cap = float(self._out_cap) if self._out_cap is not None else 10 * qty
        self.out_boxes[m] = simpy.Container(self.env, capacity=cap)

    def start(self):
        self.health.start()
        for i in range(self.slots):
            self.env.process(self._slot(i))
        self._update_state()

    def on_health_change(self):
        self._update_state()

    def _set(self, i, st):
        self.slot_state[i] = st
        self._update_state()

    def _update_state(self):
        if not self.health.is_up:
            st = "DOWN"
        else:
            st = next((s for s in ("RUNNING", "BLOCKED", "STARVED") if s in self.slot_state), "IDLE")
        self.rec.state(self.env.now, self.key, st)

    def _count(self, name):
        if self.rec.recording(self.env.now):
            self.counts[name] += 1.0

    def _slot(self, i):
        env = self.env
        while True:
            self._set(i, "STARVED")
            for m, q in self.inputs:
                yield self.in_boxes[m].get(q)
            self._count("count_in")
            remaining = self.cycle()
            while remaining > 1e-9:
                if not self.health.is_up:
                    yield self.health.wait_up()
                self._set(i, "RUNNING")
                t0 = env.now
                yield env.timeout(remaining) | self.health.wait_down()
                remaining -= env.now - t0
            ng = self.ng_rate > 0 and self.ng_rng.random() < self.ng_rate
            port = "NG" if ng else "OK"
            self._count("count_ng" if ng else "count_ok")
            self._set(i, "BLOCKED")
            for m, q, p in self.outputs:
                if p == port:
                    yield self.out_boxes[m].put(q)

    def sample(self, now):
        for m, b in self.in_boxes.items():
            self.rec.sample(now, self.key, f"in:{m}", b.level)
        for m, b in self.out_boxes.items():
            self.rec.sample(now, self.key, f"out:{m}", b.level)
        for name in ("count_in", "count_ok", "count_ng"):
            self.rec.sample(now, self.key, name, self.counts[name])
        self.health.sample(now)

    def kpi(self):
        state_s = defaultdict(float)
        for st, a, b in self.rec.intervals.get(self.key, []):
            state_s[st] += b - a
        return {"state_s": dict(state_s), "util": state_s.get("RUNNING", 0.0) / self.ctx.req.horizon_s,
                "count_in": self.counts["count_in"], "count_ok": self.counts["count_ok"],
                "count_ng": self.counts["count_ng"]}
