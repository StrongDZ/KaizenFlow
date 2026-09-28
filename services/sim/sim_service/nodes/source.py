from collections import defaultdict

import simpy

from sim_service.contract import ContractError
from sim_service.dists import make_sampler, mean_of
from sim_service.nodes.base import FlowNode, register


@register("SOURCE")
class Source(FlowNode):
    category = "sources"

    def __init__(self, ctx, spec):
        super().__init__(ctx, spec)
        self.lots = [(l["material"], make_sampler(l["qty"], ctx.stream(f"{spec.key}:lot:{l['material']}")))
                     for l in self.p.get("lots", [])]
        self.boxes = {m: simpy.Container(ctx.env) for m, _ in self.lots}
        arr = self.p.get("arrivals", {})
        self.schedule = sorted(float(t) for t in arr.get("schedule_s", []))
        self.ia = (make_sampler(arr["interarrival"], ctx.stream(f"{spec.key}:arrivals"))
                   if "interarrival" in arr else None)
        self.arrived: dict[str, float] = defaultdict(float)
        if "interarrival" in arr and mean_of(arr["interarrival"]) <= 0:
            raise ContractError(self.key, "interarrival mean must be > 0")

    def out_box(self, m):
        if m not in self.boxes:
            raise ContractError(self.key, f"does not produce '{m}'")
        return self.boxes[m]

    def start(self):
        self.env.process(self._run())

    def _run(self):
        if self.schedule:
            for t in self.schedule:
                yield self.env.timeout(max(0.0, self.ctx.warmup + t - self.env.now))
                yield from self._arrive()
        elif self.ia is not None:
            while True:
                yield self.env.timeout(self.ia())
                yield from self._arrive()

    def _arrive(self):
        for m, qty in self.lots:
            q = float(round(qty()))
            if q <= 0:
                continue
            yield self.boxes[m].put(q)
            self.arrived[m] += q
            self.rec.event(self.env.now, self.key, "ARRIVAL", {"material": m, "qty": q})

    def sample(self, now):
        for m, q in self.arrived.items():
            self.rec.sample(now, self.key, f"arrived:{m}", q)

    def kpi(self):
        return {"arrived": dict(self.arrived)}
