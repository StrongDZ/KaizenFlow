"""Aggregate helpers: extract warehouse_series_log from Recorder output."""
from __future__ import annotations

from dataclasses import dataclass
from typing import Iterable

from sim_service.engine import RepResult
from sim_service.contract import NodeSpec


@dataclass
class WarehouseSeriesEntry:
    ts_s: float
    sku: str
    node_key: str
    level: float
    capacity: float
    coverage_h: float
    color: str


def _storage_capacities(node: NodeSpec) -> tuple[str, dict]:
    """Return (node_key, {sku: max_capacity}) for a STORAGE node."""
    p = node.params or {}
    default_cap = float(p.get("capacity", float("inf")))
    caps: dict[str, float] = {}
    for s in p.get("stock", []) or []:
        sku = s.get("material")
        if not sku:
            continue
        caps[sku] = float(s.get("max", default_cap))
    return node.key, caps


def _color_at(intervals: list[tuple], ts: float, default: str = "GREEN") -> str:
    for state, a, b in intervals:
        if a <= ts < b:
            return state
    if intervals:
        last = intervals[-1]
        if ts >= last[2]:
            return last[0]
    return default


def export_warehouse_series(rep: RepResult, nodes: Iterable[NodeSpec]) -> list[dict]:
    """Map RepResult (Recorder finalize output) + nodes to warehouse_series_log.

    Returns list[dict] each with: ts_s, sku, node_key, level, capacity, coverage_h, color.
    Reuses existing Recorder series/intervals (no duplicate logging).
    """
    storage_caps: dict[str, dict[str, float]] = {}
    for n in nodes:
        if n.archetype != "STORAGE":
            continue
        key, caps = _storage_capacities(n)
        if caps:
            storage_caps[key] = caps

    out: list[dict] = []
    for node_key, sku_caps in storage_caps.items():
        node_intervals = rep.intervals.get(node_key, [])
        cov_series = rep.series.get((node_key, "coverage_h"))
        cov_by_ts: dict[float, float] = {}
        if cov_series:
            cov_by_ts = {t: v for t, v in cov_series}

        for sku, cap in sku_caps.items():
            level_key = (node_key, f"level:{sku}")
            level_series = rep.series.get(level_key)
            if not level_series:
                continue
            for ts, level in level_series:
                cov = cov_by_ts.get(ts, 0.0)
                color = _color_at(node_intervals, ts)
                out.append({
                    "ts_s": float(ts),
                    "sku": sku,
                    "node_key": node_key,
                    "level": float(level),
                    "capacity": float(cap),
                    "coverage_h": float(cov),
                    "color": color,
                })
    out.sort(key=lambda x: (x["ts_s"], x["node_key"], x["sku"]))
    return out
