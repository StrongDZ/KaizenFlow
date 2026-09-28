"""Chạy nhiều replication, gộp KPI và dải p10/p50/p90."""
from __future__ import annotations

from concurrent.futures import ProcessPoolExecutor
from datetime import timedelta

import numpy as np

from sim_service.contract import RunRequest
from sim_service.engine import RepResult, run_replication


def run_many(req: RunRequest, workers: int = 1) -> list[RepResult]:
    reps = list(range(req.replications))
    if workers <= 1 or len(reps) == 1:
        return [run_replication(req, r) for r in reps]
    with ProcessPoolExecutor(max_workers=workers) as ex:
        return list(ex.map(run_replication, [req] * len(reps), reps))


def _pct(values) -> dict:
    a = np.asarray(values, dtype=float)
    p10, p50, p90 = np.percentile(a, [10, 50, 90])
    return {"p10": float(p10), "p50": float(p50), "p90": float(p90), "mean": float(a.mean())}


def aggregate_kpis(reps: list[RepResult]) -> dict:
    first = reps[0].kpis
    out = {k: _pct([r.kpis[k] for r in reps]) for k in ("throughput", "red_minutes", "backorder_end")}
    out["storages"] = {}
    for key in first["storages"]:
        reds = [r.kpis["storages"][key]["red_s"] for r in reps]
        out["storages"][key] = {"red_probability": float(np.mean([x > 0 for x in reds])), "red_s": _pct(reds)}
    for cat in ("processes", "pools"):
        out[cat] = {key: {"util": _pct([r.kpis[cat][key]["util"] for r in reps])} for key in first[cat]}
    out["edges"] = {key: {name: _pct([r.kpis["edges"][key][name] for r in reps])
                          for name in ("wait_pool_mean", "wait_hook_mean")}
                    for key in first["edges"]}
    return out


def bands(req: RunRequest, reps: list[RepResult]) -> list[dict]:
    keys = set(reps[0].series)
    for r in reps[1:]:
        keys &= set(r.series)
    rows: list[dict] = []
    for key in sorted(keys):
        seqs = [r.series[key] for r in reps]
        times = [t for t, _ in seqs[0]]
        if not times or any([t for t, _ in s] != times for s in seqs):
            continue
        vals = np.array([[v for _, v in s] for s in seqs])
        p10, p50, p90 = np.percentile(vals, [10, 50, 90], axis=0)
        for j, t in enumerate(times):
            rows.append({"issued_at": req.sim_start, "target_time": req.sim_start + timedelta(seconds=t),
                         "producer": "SIM", "ref_id": req.run_id, "subject": key[0], "metric": key[1],
                         "p10": float(p10[j]), "p50": float(p50[j]), "p90": float(p90[j])})
    return rows
