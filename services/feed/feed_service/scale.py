"""Tham số ẩn của "thực tế": nhà máy thật không chạy đúng như mô hình danh nghĩa mà dự báo dùng."""
from __future__ import annotations

import copy
from dataclasses import dataclass

# Các khoá của dists.py có đơn vị cùng thang đo với chính đại lượng (thời gian / số lượng); cv, shape không co giãn.
_SCALED = {"value", "mean", "sd", "min", "mode", "max", "scale"}


def _base(key: str) -> str:
    return key[:-2] if key.endswith("_s") else key


def scale_dist(spec, k: float):
    """Nhân đại lượng của một phân phối với k, giữ nguyên hình dạng (cv, shape). Không sửa đối số."""
    if spec is None:
        return None
    if isinstance(spec, (int, float)):
        return spec * k
    out = {}
    for key, value in spec.items():
        if key != "dist" and _base(key) in _SCALED and isinstance(value, (int, float)):
            out[key] = value * k
        else:
            out[key] = copy.deepcopy(value)
    return out


@dataclass(frozen=True)
class Truth:
    """Độ lệch ẩn giữa thực tế và mô hình: máy chậm hơn 10%, nhu cầu cao hơn 8% (xem spec L2)."""
    cycle_factor: float = 1.10
    demand_factor: float = 1.08


def apply_truth(req: dict, truth: Truth) -> dict:
    """Trả bản sao của RunRequest (dict) với chu kỳ máy và nhu cầu bị lệch theo `truth`."""
    out = copy.deepcopy(req)
    for node in out.get("nodes", []):
        params = node.get("params", {})
        if node.get("archetype") == "PROCESS" and params.get("cycle") is not None:
            params["cycle"] = scale_dist(params["cycle"], truth.cycle_factor)
        if node.get("archetype") == "SINK":
            demands = params.get("demand", [])
            for d in [demands] if isinstance(demands, dict) else demands:
                if d.get("kind") == "TAKT" and d.get("takt") is not None:
                    d["takt"] = scale_dist(d["takt"], 1.0 / truth.demand_factor)
                elif d.get("kind") == "FORECAST" and "hourly_rate" in d:
                    d["hourly_rate"] = [r * truth.demand_factor for r in d["hourly_rate"]]
    return out
