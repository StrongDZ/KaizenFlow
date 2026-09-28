"""Trạng thái sức khoẻ máy: lên/xuống, hỏng ngẫu nhiên MTBF/MTTR."""
from __future__ import annotations

from sim_service.dists import make_sampler


class Health:
    def __init__(self, ctx, owner):
        self.ctx = ctx
        self.owner = owner
        self.env = ctx.env
        self.is_up = True
        self._down = self.env.event()
        self._up = self.env.event()
        p = owner.p
        self.mtbf = make_sampler(p["mtbf"], ctx.rng) if p.get("mtbf") else None
        self.mttr = make_sampler(p.get("mttr"), ctx.rng, default=0.0)

    def wait_down(self):
        return self._down

    def wait_up(self):
        return self._up

    def go_down(self, reason: str) -> bool:
        if not self.is_up:
            return False
        self.is_up = False
        self._up = self.env.event()
        ev, self._down = self._down, self.env.event()
        ev.succeed(reason)
        self.ctx.rec.event(self.env.now, self.owner.key, "DOWN", {"reason": reason})
        self.owner.on_health_change()
        return True

    def go_up(self) -> None:
        if self.is_up:
            return
        self.is_up = True
        self._up.succeed()
        self.owner.on_health_change()

    def start(self) -> None:
        if self.mtbf is not None:
            self.env.process(self._random_failures())

    def _random_failures(self):
        while True:
            yield self.env.timeout(self.mtbf())
            if self.go_down("RANDOM"):
                yield self.env.timeout(self.mttr())
                self.go_up()

    def sample(self, now) -> None:
        pass
