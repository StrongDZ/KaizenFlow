import simpy

from sim_service.contract import ContractError
from sim_service.dists import make_sampler, mean_of
from sim_service.nodes.base import FlowNode, register


@register("SINK")
class Sink(FlowNode):
    category = "sinks"

    def __init__(self, ctx, spec):
        super().__init__(ctx, spec)
        self.buffer = float(self.p.get("buffer", 10))
        self.boxes: dict[str, simpy.Container] = {}
        d = self.p.get("demand", [])
        self.demands = [d] if isinstance(d, dict) else list(d)
        self.counts_throughput = bool(self.p.get("throughput", True))
        self.demanded = 0.0
        self.fulfilled = 0.0
        self.fulfilled_rec = 0.0
        for d in self.demands:
            kind = d.get("kind", "TAKT")
            if kind not in ("TAKT", "FORECAST"):
                raise ContractError(self.key, f"unknown demand kind '{kind}'")
            if kind == "TAKT" and mean_of(d["takt"]) <= 0:
                raise ContractError(self.key, "takt mean must be > 0")

    def _box(self, m):
        if m not in self.boxes:
            self.boxes[m] = simpy.Container(self.env, capacity=self.buffer)
        return self.boxes[m]

    def in_box(self, m):
        return self._box(m)

    def start(self):
        demanded = set()
        for d in self.demands:
            m = d["material"]
            demanded.add(m)
            tokens = simpy.Container(self.env)
            kind = d.get("kind", "TAKT")
            if kind == "TAKT":
                self.env.process(self._takt(d, tokens))
            elif kind == "FORECAST":
                self.env.process(self._forecast(d, tokens))
            else:
                raise ContractError(self.key, f"unknown demand kind '{kind}'")
            self.env.process(self._consume(m, tokens))
        for m in list(self.boxes):
            if m not in demanded:
                self.env.process(self._consume(m, None))

    def _takt(self, d, tokens):
        takt = make_sampler(d["takt"], self.ctx.stream(f"{self.key}:demand:{d['material']}"))
        qty = float(d.get("qty", 1))
        while True:
            yield self.env.timeout(takt())
            yield tokens.put(qty)
            self.demanded += qty

    def _forecast(self, d, tokens):
        rates = [float(r) for r in d["hourly_rate"]]
        lam_max = max(rates) if rates else 0.0
        if lam_max <= 0:
            return
        rng = self.ctx.stream(f"{self.key}:demand:{d['material']}")
        while True:
            yield self.env.timeout(float(rng.exponential(3600.0 / lam_max)))
            h = int(max(0.0, self.env.now - self.ctx.warmup) // 3600) % len(rates)
            if rng.random() < rates[h] / lam_max:
                yield tokens.put(1.0)
                self.demanded += 1.0

    def _consume(self, m, tokens):
        box = self._box(m)
        while True:
            if tokens is not None:
                yield tokens.get(1.0)
            yield box.get(1.0)
            self.fulfilled += 1.0
            if self.rec.recording(self.env.now):
                self.fulfilled_rec += 1.0

    def backorder(self) -> float:
        return max(0.0, self.demanded - self.fulfilled) if self.demands else 0.0

    def sample(self, now):
        self.rec.sample(now, self.key, "demand", self.demanded)
        self.rec.sample(now, self.key, "fulfilled", self.fulfilled)
        self.rec.sample(now, self.key, "backorder", self.backorder())

    def kpi(self):
        return {"fulfilled": self.fulfilled_rec, "backorder_end": self.backorder(),
                "counts_throughput": self.counts_throughput}
