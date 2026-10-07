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
    poly: tuple[tuple[float, float], ...] = ()   # đầu, các điểm uốn, cuối (mét)


def _poly_len(poly) -> float:
    return sum(math.hypot(poly[i][0] - poly[i - 1][0], poly[i][1] - poly[i - 1][1]) for i in range(1, len(poly)))


class MapGraph:
    """Bản đồ v2 tính bằng mét, làn có `path` là các điểm uốn. Bản v1 (không có `v`) tính bằng đơn vị vẽ × unit_m nên được đổi sang mét khi nạp."""

    def __init__(self, data: dict):
        k = 1.0 if int(data.get("v") or 1) >= 2 else float(data.get("unit_m") or 1.0)
        self.unit_m = 1.0  # toạ độ trong đối tượng này luôn là mét
        self.speed_mps = float(data.get("speed_mps") or 0.0)
        if self.speed_mps <= 0:
            raise ValueError("map: speed_mps phải lớn hơn 0")
        self.points: dict[str, Point] = {}
        for p in data.get("points", []):
            self.points[p["id"]] = Point(p["id"], float(p["x"]) * k, float(p["y"]) * k, p.get("kind", "junction"), p.get("node_key") or None)
        self.lanes: dict[str, Lane] = {}
        self.out: dict[str, list[Lane]] = {pid: [] for pid in self.points}
        for l in data.get("lanes", []):
            if l["from"] not in self.points or l["to"] not in self.points:
                raise ValueError(f"lane {l['id']}: nối tới điểm không tồn tại")
            a, b = self.points[l["from"]], self.points[l["to"]]
            via = tuple((float(q["x"]) * k, float(q["y"]) * k) for q in l.get("path") or [])
            poly = ((a.x, a.y), *via, (b.x, b.y))
            lane = Lane(l["id"], a.id, b.id, max(1, int(l.get("capacity", 1))), _poly_len(poly), poly)
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

    def pose_on_lane(self, lane_id: str, frac: float) -> tuple[float, float, float]:
        """Vị trí và hướng (độ, atan2(dy, dx), trong [0, 360)) tại tỉ lệ `frac` của độ dài làn, đo dọc đường gấp khúc."""
        poly = self.lanes[lane_id].poly
        total = _poly_len(poly)
        target = min(1.0, max(0.0, frac)) * total
        run = 0.0
        last_heading = 0.0
        for i in range(1, len(poly)):
            (x1, y1), (x2, y2) = poly[i - 1], poly[i]
            seg = math.hypot(x2 - x1, y2 - y1)
            if seg == 0:
                continue
            last_heading = math.degrees(math.atan2(y2 - y1, x2 - x1)) % 360.0
            if target <= run + seg or i == len(poly) - 1:
                t = min(1.0, max(0.0, (target - run) / seg))
                return (x1 + (x2 - x1) * t, y1 + (y2 - y1) * t, last_heading)
            run += seg
        x, y = poly[-1] if poly else (0.0, 0.0)
        return (x, y, last_heading)

    def xy_on_lane(self, lane_id: str, frac: float) -> tuple[float, float]:
        x, y, _ = self.pose_on_lane(lane_id, frac)
        return (x, y)

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
