"""Sức khoẻ máy: MTBF/MTTR, failure mode theo đường cong P-F, injection, planned stop, sensor, nhãn."""
from __future__ import annotations

import math

from sim_service.contract import ContractError
from sim_service.dists import make_sampler

INF = float("inf")
EFFECT_KINDS = frozenset({"ramp", "exp", "step", "spike", "freeze", "zero"})


class Health:
    def __init__(self, ctx, owner):
        self.ctx = ctx
        self.owner = owner
        self.env = ctx.env
        self.reasons: set[str] = set()
        self._down = self.env.event()
        self._up = self.env.event()
        p = owner.p
        self.mtbf = make_sampler(p["mtbf"], ctx.stream(f"{owner.key}:mtbf")) if p.get("mtbf") else None
        self.mttr = make_sampler(p.get("mttr"), ctx.stream(f"{owner.key}:mttr"), default=0.0)
        self.modes = {m["code"]: m for m in p.get("failure_modes", [])}
        self.signals = p.get("signals", [])
        self.injections = [i for i in ctx.req.injections if i.target == owner.key]
        self.active: dict | None = None
        self.failed_mode: str | None = None
        self.renewal = 0
        self.spike_rng = ctx.stream(f"{owner.key}:spike")
        for s in self.signals:
            if float(s.get("hz", 1.0)) <= 0:
                raise ContractError(owner.key, f"signal '{s['name']}' needs hz > 0")
        for m in self.modes.values():
            for e in m.get("effects", []):
                if e.get("kind") not in EFFECT_KINDS:
                    raise ContractError(owner.key, f"unknown effect kind '{e.get('kind')}'")

    # --- lên / xuống -------------------------------------------------------
    def wait_down(self):
        return self._down

    def wait_up(self):
        return self._up

    @property
    def is_up(self) -> bool:
        return not self.reasons

    def go_down(self, reason: str) -> None:
        """Đếm lý do dừng: máy chỉ chạy lại khi mọi lý do (RANDOM, PLANNED, failure mode) đã hết."""
        was_up = self.is_up
        self.reasons.add(reason)
        self.ctx.rec.event(self.env.now, self.owner.key, "DOWN", {"reason": reason})
        if was_up:
            self._up = self.env.event()
            ev, self._down = self._down, self.env.event()
            ev.succeed(reason)
            self.owner.on_health_change()

    def go_up(self, reason: str) -> None:
        if reason not in self.reasons:
            return
        self.reasons.discard(reason)
        if self.is_up:
            self._up.succeed()
            self.owner.on_health_change()

    # --- tiến trình --------------------------------------------------------
    def start(self) -> None:
        if self.mtbf is not None:
            self.env.process(self._random_failures())
        injected = {i.failure: i for i in self.injections if i.kind == "failure"}
        for code, mode in self.modes.items():
            self.env.process(self._mode_loop(mode, injected.get(code)))
        for inj in self.injections:
            if inj.kind == "planned_stop":
                self.env.process(self._planned(inj))
        rec = self.ctx.rec
        if self.signals and rec.keep_raw and self.ctx.req.outputs.sensors:
            for s in self.signals:
                self.env.process(self._sensor(s))

    def _random_failures(self):
        while True:
            yield self.env.timeout(self.mtbf())
            self.go_down("RANDOM")
            yield self.env.timeout(self.mttr())
            self.go_up("RANDOM")

    def _mode_loop(self, mode: dict, inj):
        env, rec, key = self.env, self.ctx.rec, self.owner.key
        tag = f"{key}:{mode['code']}"
        onset = make_sampler(mode.get("onset"), self.ctx.stream(f"{tag}:onset"), default=INF)
        p_to_f = make_sampler(mode.get("p_to_f"), self.ctx.stream(f"{tag}:p_to_f"), default=0.0)
        mttr = make_sampler(mode.get("on_fail", {}).get("mttr"), self.ctx.stream(f"{tag}:mttr"), default=0.0)
        first = True
        while True:
            gen = self.renewal
            d = p_to_f()
            if first and inj is not None:
                F = self.ctx.warmup + inj.at_s
                P = max(env.now, F - d)
            else:
                P = env.now + onset()
                F = P + d
            first = False
            if math.isinf(P):
                return
            yield env.timeout(P - env.now)
            if self.renewal != gen:
                continue
            self.active = {"mode": mode["code"], "P": P, "F": F, "effects": mode.get("effects", [])}
            rec.event(env.now, key, "FAULT_ONSET", {"mode": mode["code"], "failure_at": rec.ts(F).isoformat()})
            yield env.timeout(max(0.0, F - env.now))
            if self.renewal != gen:
                continue
            self.failed_mode = mode["code"]
            rec.event(env.now, key, "FAILURE", {"mode": mode["code"]})
            self.go_down(mode["code"])
            yield env.timeout(mttr())
            self.active = None
            self.failed_mode = None
            self.renewal += 1
            self.go_up(mode["code"])
            rec.event(env.now, key, "REPAIRED", {"mode": mode["code"]})

    def _planned(self, inj):
        env = self.env
        yield env.timeout(max(0.0, self.ctx.warmup + inj.at_s - env.now))
        self.ctx.rec.event(env.now, self.owner.key, "PLANNED_STOP", {
            "duration_s": inj.duration_s,
            "ends_at": self.ctx.rec.ts(env.now + inj.duration_s).isoformat(),
        })
        # Bảo trì bắt đầu → làm mới mọi failure mode đang suy giảm (kể cả khi dừng trùm qua F).
        self.go_down("PLANNED")
        self.active = None
        self.renewal += 1
        yield env.timeout(inj.duration_s)
        self.go_up("PLANNED")
        self.ctx.rec.event(env.now, self.owner.key, "PLANNED_STOP_END", {})

    # --- sensor & nhãn -----------------------------------------------------
    def _effect(self, name: str, now: float, sd: float):
        a = self.active
        if a is None:
            return 0.0
        for e in a["effects"]:
            if e["signal"] != name:
                continue
            kind = e["kind"]
            mag = float(e["delta"]) if "delta" in e else float(e.get("mag_sd", 0.0)) * sd
            x = min(1.0, max(0.0, (now - a["P"]) / max(a["F"] - a["P"], 1e-9)))
            if kind == "ramp":
                return mag * x
            if kind == "exp":
                return mag * (math.exp(3 * x) - 1) / (math.exp(3) - 1)
            if kind == "step":
                return mag
            if kind == "spike":
                return mag if self.spike_rng.random() < 0.05 else 0.0
            if kind == "freeze":
                return "freeze"
            if kind == "zero":
                return "zero" if not self.is_up else 0.0
            raise ContractError(self.owner.key, f"unknown effect kind '{kind}'")
        return 0.0

    def _sensor(self, s: dict):
        env, rec = self.env, self.ctx.rec
        base = make_sampler(s["base"], self.ctx.stream(f"{self.owner.key}:sensor:{s['name']}"), nonneg=False)
        sd = float(s["base"].get("sd", 0.0)) if isinstance(s["base"], dict) else 0.0
        period = 1.0 / float(s.get("hz", 1.0))
        last = None
        yield env.timeout(self.ctx.warmup)
        while True:
            v = base()
            eff = self._effect(s["name"], env.now, sd)
            if eff == "freeze":
                v = last if last is not None else v
            elif eff == "zero":
                v = 0.0
            else:
                if eff == 0.0:
                    last = v
                v += eff
            rec.signal(env.now, self.owner.key, s["name"], v)
            yield env.timeout(period)

    def sample(self, now) -> None:
        if not self.modes:
            return
        rec, key = self.ctx.rec, self.owner.key
        rec.sample(now, key, "label_fault", 1.0 if (self.active or self.failed_mode) else 0.0)
        if self.active is not None and self.failed_mode is None:
            rec.sample(now, key, "rul_s", max(0.0, self.active["F"] - now))
