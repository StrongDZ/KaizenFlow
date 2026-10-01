from collections import defaultdict
import math

import simpy

from sim_service.contract import ContractError
from sim_service.dists import make_sampler, mean_of
from sim_service.health import Health
from sim_service.nodes.base import FlowNode, register


def mean_cycle_s(params: dict) -> float:
    """Chu kỳ trung bình theo đúng semantics của ``dists.mean_of``; thiếu cycle dùng default runtime là 1 giây."""
    try:
        value = mean_of(params.get("cycle", 1.0))
    except ArithmeticError as exc:
        raise ValueError("cycle distribution has invalid parameters") from exc
    if not math.isfinite(value) or value <= 0:
        raise ValueError("cycle mean must be finite and > 0")
    return value


def process_material_rate(params: dict, material: str | None = None, *, side: str = "outputs") -> float:
    """Năng lực danh nghĩa (quantity/hour) ở một phía recipe, có xét slots và hệ số quantity."""
    recipe = (params.get("recipes") or [{}])[0]
    rows = recipe.get(side, [])
    qty = sum(float(row.get("qty", 0.0)) for row in rows
              if (material is None or row.get("material") == material)
              and (side != "outputs" or row.get("port", "OK") == "OK"))
    return int(params.get("slots", 1)) * qty * 3600.0 / mean_cycle_s(params)


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
        raw_slots = float(self.p.get("slots", 1))
        if not math.isfinite(raw_slots) or raw_slots < 1 or not raw_slots.is_integer():
            raise ContractError(self.key, "slots must be a positive integer")
        self.slots = int(raw_slots)
        self.cycle_mean_s = mean_cycle_s(self.p)
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
        horizon = self.ctx.req.horizon_s
        states = {st: state_s.get(st, 0.0) for st in ("RUNNING", "BLOCKED", "STARVED", "DOWN", "IDLE")}
        ok_qty = sum(q for _, q, port in self.outputs if port == "OK")
        nominal_rate = self.slots * ok_qty * 3600.0 / self.cycle_mean_s
        effective_throughput = self.counts["count_ok"] * ok_qty * 3600.0 / horizon

        def wip(prefix, boxes):
            series = [values for (subject, name), values in self.rec.series.items()
                      if subject == self.key and name.startswith(prefix)]
            current = sum(float(box.level) for box in boxes.values())
            if not series:
                return current, current, current
            by_time = defaultdict(float)
            for values in series:
                for at, value in values:
                    by_time[at] += value
            ordered = sorted(by_time.items())
            return max(max(by_time.values()), current), current, ordered[0][1]

        input_peak, input_end, input_start = wip("in:", self.in_boxes)
        output_peak, output_end, output_start = wip("out:", self.out_boxes)
        utilization = states["RUNNING"] / horizon
        return {
            "state_s": dict(state_s),
            "util": utilization,  # tên cũ, giữ tương thích API/UI
            "utilization": utilization,
            "nominal_rate": nominal_rate,
            "effective_throughput": effective_throughput,
            "running_s": states["RUNNING"],
            "blocked_s": states["BLOCKED"],
            "starved_s": states["STARVED"],
            "down_s": states["DOWN"],
            "idle_s": states["IDLE"],
            "blocked_ratio": states["BLOCKED"] / horizon,
            "starved_ratio": states["STARVED"] / horizon,
            "down_ratio": states["DOWN"] / horizon,
            "count_in": self.counts["count_in"],
            "count_ok": self.counts["count_ok"],
            "count_ng": self.counts["count_ng"],
            "input_wip_peak": input_peak,
            "output_wip_peak": output_peak,
            "input_wip_end": input_end,
            "output_wip_end": output_end,
            "wip_growth": (input_end + output_end) - (input_start + output_start),
        }
