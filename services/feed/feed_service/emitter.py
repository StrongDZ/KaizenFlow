"""Chuyển trạng thái của World thành bản tin thô kiểu thiết bị (PLC, WMS, dock, đội xe, băng chuyền, AGV)."""
from __future__ import annotations

import numpy as np

from feed_service.alias import alias_of, edge_slug
from feed_service.world import World

# Từ trạng thái của engine sang "từ ngữ" của PLC: bước mapping phải đổi lại (RUN → RUNNING…).
_PLC_STATE = {"RUNNING": "RUN", "STARVED": "WAIT_IN", "BLOCKED": "WAIT_OUT", "DOWN": "ALARM", "IDLE": "IDLE"}


def _process_state(node) -> str:
    """Giống Process._update_state của sim: DOWN nếu máy hỏng, còn lại ưu tiên RUNNING > BLOCKED > STARVED."""
    if not node.health.is_up:
        return "DOWN"
    return next((s for s in ("RUNNING", "BLOCKED", "STARVED") if s in node.slot_state), "IDLE")


class Emitter:
    def __init__(self, world: World, seed: int = 1):
        self.w = world
        self.rng = np.random.default_rng(seed)
        self.arche = {n.key: n.archetype for n in world.req.nodes}

    def _name(self, key: str) -> str:
        return self.w.names.get(key) or key

    def _vib(self, state: str) -> float:
        base = {"RUNNING": 0.30, "DOWN": 0.95}.get(state, 0.08)
        return round(max(0.0, float(self.rng.normal(base, 0.02 if state != "DOWN" else 0.05))), 3)

    def messages(self) -> list[dict]:
        ctx = self.w.ctx
        ts = self.w.virtual_now().isoformat()
        out: list[dict] = []

        def add(source: str, desc: str, payload: dict) -> None:
            out.append({"source": source, "ts": ts, "desc": desc, "payload": payload})

        for key, node in ctx.nodes.items():
            alias, desc, kind = alias_of(key), self._name(key), self.arche[key]
            if kind == "PROCESS":
                st = _process_state(node)
                add(f"plc/{alias}/status", desc, {
                    "st": _PLC_STATE[st],
                    "cnt": {"in": int(node.counts["count_in"]), "ok": int(node.counts["count_ok"]), "ng": int(node.counts["count_ng"])},
                    "vib": self._vib(st)})
            elif kind == "STORAGE":
                add(f"wms/{alias}/stock", desc, {"items": [{"sku": m, "qty": round(b.level, 1)} for m, b in node.boxes.items()]})
            elif kind == "SOURCE":
                add(f"dock/{alias}/count", desc, {"arrived": int(sum(node.arrived.values()))})
            elif kind == "SINK":
                add(f"dock/{alias}/count", desc, {"demand": int(node.demanded), "shipped": int(node.fulfilled),
                                                  "backlog": int(node.backorder())})
        for key, pool in ctx.pools.items():
            add(f"fleet/{alias_of(key)}/summary", self._name(key),
                {"busy": int(pool.res.count), "queue": len(pool.res.queue), "total": int(pool.count)})
        for e in ctx.edges:
            add(f"belt/{edge_slug(e.key)}/flow", self._edge_desc(e), {"moved": int(e.moved), "in_transit": int(e.in_transit)})
        out.extend(self._agv(ts))
        out.extend(self._trips(ts))
        return out

    def _edge_desc(self, e) -> str:
        return f"{self._name(e.spec.src)} → {self._name(e.spec.dst)} ({e.spec.material})"

    def _agv(self, ts: str) -> list[dict]:
        fleet = self.w.fleet
        if fleet is None:
            return []
        out = []
        now = self.w.ctx.env.now
        for pool_key, vehicles in fleet.vehicles.items():
            for i, v in enumerate(vehicles):
                xy = fleet.xy(v, now)
                if xy is None:
                    continue
                out.append({"source": f"agv/{alias_of(pool_key)}/{i + 1:02d}/pos", "ts": ts,
                            "desc": f"{self._name(pool_key)} — xe {i + 1}",
                            "payload": {"id": v.id, "x": round(xy[0], 2), "y": round(xy[1], 2), "st": v.state,
                                        "seg": v.lane or "", "load": v.load}})
        return out

    def _trips(self, ts: str) -> list[dict]:
        fleet = self.w.fleet
        if fleet is None:
            return []
        edges = {e.key: e for e in self.w.ctx.edges}
        return [{"source": f"agv/trip/{edge_slug(t['edge'])}", "ts": ts,
                 "desc": f"Chuyến xe: {self._edge_desc(edges[t['edge']])}",
                 "payload": {"dur": round(t["dur"], 1), "wait": round(t["wait"], 1), "ideal": round(t["ideal"], 1)}}
                for t in fleet.drain_trips()]
