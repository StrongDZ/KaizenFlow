"""World: nhà máy "thật" của demo = engine sim + tham số ẩn + bản đồ AGV + sự cố bơm tay, chạy từng bước theo giờ ảo."""
from __future__ import annotations

from datetime import datetime, timedelta

from sim_service.contract import RunRequest
from sim_service.engine import build
from sim_service.transport import Transfer

from feed_service.agv import Fleet
from feed_service.frame import ControllerFrame
from feed_service.mapgraph import MapGraph
from feed_service.scale import Truth, apply_truth

DEFAULT_WARMUP_S = 3600.0
DEFAULT_DOWN_S = 1800.0


def _now_minute() -> datetime:
    return datetime.now().astimezone().replace(second=0, microsecond=0)


class World:
    def __init__(self, blueprint: dict, truth: Truth | None = None, seed: int = 7, warmup_s: float = DEFAULT_WARMUP_S,
                 base: datetime | None = None):
        self.truth = truth or Truth()
        self.base = base or _now_minute()
        self.names: dict[str, str] = dict(blueprint.get("names") or {})
        data = apply_truth(blueprint["run_request"], self.truth)
        data.update(seed=seed, sim_start=self.base.isoformat(), injections=[], recommend=False,
                    initial_state={"mode": "WARMUP", "warmup_s": warmup_s},
                    outputs={"raw_reps": [], "sample_s": 3600.0, "sensors": False})
        self.req = RunRequest.model_validate(data)
        agv = blueprint.get("agv_map")
        self.frame: ControllerFrame | None = None  # hệ toạ độ hãng xe giả lập; None = phát thẳng toạ độ bản đồ
        self.fleet: Fleet | None = Fleet(MapGraph(agv), seed=seed) if agv and agv.get("lanes") else None
        self.ctx = build(self.req, 0, self.fleet.make_edge if self.fleet else Transfer)
        for obj in self.ctx.objects():
            obj.start()
        self.ctx.env.run(until=warmup_s)  # nhà máy đã "ấm" khi bắt đầu phát
        self._t0 = self.ctx.env.now
        self._incidents: dict[int, dict] = {}
        self._undo: dict[int, callable] = {}
        self._next_id = 1

    # --- thời gian ------------------------------------------------------------------------------
    def step(self, dt_s: float) -> None:
        if dt_s > 0:
            self.ctx.env.run(until=self.ctx.env.now + dt_s)

    def virtual_now(self) -> datetime:
        return self.base + timedelta(seconds=self.ctx.env.now - self._t0)

    def _iso(self, sim_t: float) -> str:
        return (self.base + timedelta(seconds=sim_t - self._t0)).isoformat()

    # --- sự cố ----------------------------------------------------------------------------------
    def add_incident(self, kind: str, target: str, duration_s: float | None = None, **params) -> dict:
        env = self.ctx.env
        inc = {"id": self._next_id, "kind": kind, "target": target, "started": self._iso(env.now), "params": params}
        if kind == "machine_down":
            node = self.ctx.nodes.get(target)
            if node is None or not hasattr(node, "health"):
                raise ValueError(f"'{target}' không phải máy (PROCESS) trong mô hình")
            dur = float(duration_s or DEFAULT_DOWN_S)
            node.health.go_down("INCIDENT")
            self._end_after(dur, lambda: node.health.go_up("INCIDENT"))
            self._undo[inc["id"]] = lambda: node.health.go_up("INCIDENT")
            inc["until_t"] = env.now + dur
        elif kind == "lane_block":
            if self.fleet is None:
                raise ValueError("mô hình chưa có bản đồ AGV nên không chặn làn được")
            if target not in self.fleet.res:
                raise ValueError(f"không có làn '{target}' trên bản đồ")
            dur = float(duration_s or DEFAULT_DOWN_S)
            self.fleet.block(target, until=env.now + dur)
            self._undo[inc["id"]] = lambda: self.fleet.unblock(target)
            inc["until_t"] = env.now + dur
        elif kind == "stock_drain":
            node = self.ctx.nodes.get(target)
            box = getattr(node, "boxes", {}).get(params.get("material", "")) if node is not None else None
            if box is None or not hasattr(node, "coverage_h"):
                raise ValueError(f"'{target}' không phải kho có vật tư '{params.get('material')}'")
            frac = min(1.0, max(0.0, float(params.get("fraction", 0.8))))
            amount = box.level * frac
            if amount > 0:
                env.process(self._take(box, amount))
            inc["until_t"] = env.now  # rút một lần, xong ngay
        else:
            raise ValueError(f"không có loại sự cố '{kind}'")
        self._incidents[inc["id"]] = inc
        self._next_id += 1
        return self._view(inc)

    def _take(self, box, amount: float):
        yield box.get(amount)

    def _end_after(self, dur: float, fn) -> None:
        def proc():
            yield self.ctx.env.timeout(dur)
            fn()
        self.ctx.env.process(proc())

    def clear_incident(self, incident_id: int) -> bool:
        inc = self._incidents.get(incident_id)
        undo = self._undo.pop(incident_id, None)
        if inc is None or undo is None or inc["until_t"] <= self.ctx.env.now:
            return False
        undo()
        inc["until_t"] = self.ctx.env.now
        return True

    def _view(self, inc: dict) -> dict:
        out = {k: v for k, v in inc.items() if k != "until_t"}
        out["until"] = self._iso(inc["until_t"])
        out["active"] = inc["until_t"] > self.ctx.env.now
        return out

    def list_incidents(self) -> list[dict]:
        return [self._view(i) for i in self._incidents.values()]
