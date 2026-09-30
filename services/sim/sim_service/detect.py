"""Detect: bottleneck theo active period method (Roser) + chờ pool; RED_RISK cho STORAGE."""
from __future__ import annotations

from collections import defaultdict
from datetime import timedelta

import numpy as np

from sim_service.contract import RunRequest
from sim_service.engine import RepResult

ACTIVE = frozenset({"RUNNING", "DOWN", "SETUP"})
WAIT_THRESHOLD_S = 120.0


def _insight(kind, subject, eta, probability, severity, payload) -> dict:
    return {"kind": kind, "subject_key": subject, "eta": eta, "probability": float(probability),
            "severity": int(severity), "payload": payload}


def active_periods(intervals) -> list[tuple[float, float]]:
    periods: list[tuple[float, float]] = []
    cur: list[float] | None = None
    for st, a, b in sorted(intervals, key=lambda x: x[1]):
        if st in ACTIVE:
            if cur is not None and abs(cur[1] - a) < 1e-9:
                cur[1] = b
            else:
                if cur is not None:
                    periods.append((cur[0], cur[1]))
                cur = [a, b]
        elif cur is not None:
            periods.append((cur[0], cur[1]))
            cur = None
    if cur is not None:
        periods.append((cur[0], cur[1]))
    return periods


def active_period_shares(periods: dict, horizon: float, step: float = 60.0) -> dict[str, float]:
    """Tỉ lệ mốc thời gian mà mỗi node giữ khoảng hoạt động dài nhất (hoà thì node đứng trước). Vector hoá bằng numpy."""
    ticks = np.arange(0.0, horizon, step)
    if len(ticks) == 0 or not periods:
        return {}
    subjects = list(periods)
    lengths = np.zeros((len(subjects), len(ticks)))
    for i, subject in enumerate(subjects):
        ps = periods[subject]
        if not ps:
            continue
        starts = np.fromiter((a for a, _ in ps), dtype=float, count=len(ps))
        ends = np.fromiter((b for _, b in ps), dtype=float, count=len(ps))
        idx = np.searchsorted(starts, ticks, side="right") - 1  # khoảng có a ≤ t gần nhất
        valid = idx >= 0
        safe = np.where(valid, idx, 0)
        covered = valid & (ticks < ends[safe])
        lengths[i] = np.where(covered, (ends - starts)[safe], 0.0)
    best = lengths.argmax(axis=0)  # argmax lấy phần tử đầu khi hoà, như bản duyệt tuần tự
    has = lengths.max(axis=0) > 0
    counts = np.bincount(best[has], minlength=len(subjects))
    return {subjects[i]: int(c) / len(ticks) for i, c in enumerate(counts) if c > 0}


def detect(req: RunRequest, reps: list[RepResult]) -> list[dict]:
    insights: list[dict] = []
    procs = [n.key for n in req.nodes if n.archetype == "PROCESS"]
    if procs and any(r.intervals for r in reps):
        total: dict[str, float] = defaultdict(float)
        for r in reps:
            periods = {k: active_periods(r.intervals.get(k, [])) for k in procs}
            for k, v in active_period_shares(periods, req.horizon_s).items():
                total[k] += v
        shares = {k: total[k] / len(reps) for k in procs}
        top = max(shares, key=shares.get)
        if shares[top] > 0:
            insights.append(_insight("BOTTLENECK", top, None, shares[top], 2,
                                     {"method": "active_period", "shares": shares}))

    pool_waits: dict[str, dict] = {}
    for e in req.edges:
        if e.mode != "POOL" or e.key not in reps[0].kpis["edges"]:
            continue
        for name, subject in (("wait_hook_mean", e.hook_pool), ("wait_pool_mean", e.pool)):
            if subject is None:
                continue
            mean = float(np.mean([r.kpis["edges"][e.key][name] for r in reps]))
            if mean > WAIT_THRESHOLD_S and mean > pool_waits.get(subject, {}).get("mean_s", 0.0):
                pool_waits[subject] = {"method": name, "edge": e.key, "mean_s": mean}
    for subject, payload in pool_waits.items():
        insights.append(_insight("BOTTLENECK", subject, None, 1.0, 2, payload))

    for n in req.nodes:
        if n.archetype != "STORAGE" or n.key not in reps[0].kpis["storages"]:
            continue
        stats = [r.kpis["storages"][n.key] for r in reps]
        hits = [s["first_red_s"] for s in stats if s["first_red_s"] is not None]
        p = len(hits) / len(reps)
        if p > 0:
            eta = req.sim_start + timedelta(seconds=float(np.median(hits)))
            sev = 3 if p >= 0.5 else 2 if p >= 0.2 else 1
            insights.append(_insight("RED_RISK", n.key, eta, p, sev,
                                     {"red_s_mean": float(np.mean([s["red_s"] for s in stats]))}))
    return insights
