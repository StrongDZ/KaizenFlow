"""Đồ thị bản đồ AGV: điểm, làn có hướng, tìm đường ngắn nhất theo chi phí động."""
from __future__ import annotations

import heapq
import math
from dataclasses import dataclass
from typing import Callable


@dataclass(frozen=True)
class Point:
    id: str
    x: float
    y: float
    kind: str
    node_key: str | None = None


@dataclass(frozen=True)
class Lane:
    id: str
    frm: str
    to: str
    capacity: int
    length_m: float


class MapGraph:
    def __init__(self, data: dict):
        self.unit_m = float(data.get("unit_m") or 1.0)
        self.speed_mps = float(data.get("speed_mps") or 0.0)
        if self.speed_mps <= 0:
            raise ValueError("map: speed_mps phải lớn hơn 0")
        self.points: dict[str, Point] = {}
        for p in data.get("points", []):
            self.points[p["id"]] = Point(p["id"], float(p["x"]), float(p["y"]), p.get("kind", "junction"), p.get("node_key") or None)
        self.lanes: dict[str, Lane] = {}
        self.out: dict[str, list[Lane]] = {pid: [] for pid in self.points}
        for l in data.get("lanes", []):
            if l["from"] not in self.points or l["to"] not in self.points:
                raise ValueError(f"lane {l['id']}: nối tới điểm không tồn tại")
            a, b = self.points[l["from"]], self.points[l["to"]]
            lane = Lane(l["id"], a.id, b.id, max(1, int(l.get("capacity", 1))), math.hypot(a.x - b.x, a.y - b.y) * self.unit_m)
            self.lanes[lane.id] = lane
            self.out[a.id].append(lane)

    def station_of(self, node_key: str) -> str | None:
        for p in self.points.values():
            if p.node_key == node_key:
                return p.id
        return None

    def xy_of(self, point_id: str) -> tuple[float, float]:
        p = self.points[point_id]
        return (p.x, p.y)

    def xy_on_lane(self, lane_id: str, frac: float) -> tuple[float, float]:
        lane = self.lanes[lane_id]
        f = min(1.0, max(0.0, frac))
        (x1, y1), (x2, y2) = self.xy_of(lane.frm), self.xy_of(lane.to)
        return (x1 + (x2 - x1) * f, y1 + (y2 - y1) * f)

    def shortest(self, src: str, dst: str, cost: Callable[[Lane], float]) -> list[Lane] | None:
        """Dijkstra. cost(lane) = inf nghĩa là làn không đi được. Trả danh sách làn ([] nếu đã ở đích), None nếu không có đường."""
        if src not in self.points or dst not in self.points:
            return None
        if src == dst:
            return []
        best: dict[str, float] = {src: 0.0}
        prev: dict[str, Lane] = {}
        heap = [(0.0, src)]
        while heap:
            d, u = heapq.heappop(heap)
            if u == dst:
                break
            if d > best.get(u, math.inf):
                continue
            for lane in self.out[u]:
                c = cost(lane)
                if not math.isfinite(c):
                    continue
                nd = d + c
                if nd < best.get(lane.to, math.inf):
                    best[lane.to] = nd
                    prev[lane.to] = lane
                    heapq.heappush(heap, (nd, lane.to))
        if dst not in prev:
            return None
        path: list[Lane] = []
        cur = dst
        while cur != src:
            lane = prev[cur]
            path.append(lane)
            cur = lane.frm
        return path[::-1]
