"""Ghép: validate → Monte Carlo → Detect → Recommend → kết quả + CSV."""
from __future__ import annotations

import csv
import io
import json
from dataclasses import dataclass, field

from sim_service.aggregate import export_warehouse_series
from sim_service.contract import ENGINE_VERSION, RunRequest, validate_refs
from sim_service.detect import detect
from sim_service.impact import failure_impacts
from sim_service.montecarlo import aggregate_kpis, bands, run_many
from sim_service.recommend import recommend


@dataclass
class RunResult:
    run_id: int
    engine_version: str
    kpis: dict
    bands: list[dict]
    insights: list[dict]
    signals: list[dict]
    events: list[dict]
    warehouse_series_log: list[dict] = field(default_factory=list)


def execute(req: RunRequest, workers: int = 1) -> RunResult:
    validate_refs(req)
    reps = run_many(req, workers)
    insights = detect(req, reps)
    if req.recommend:
        impacts = []
        active_injections = [i for i in req.injections if i.at_s < req.horizon_s]
        if active_injections:
            reference = None
            if len({i.target for i in active_injections}) == 1:
                reference_req = req.model_copy(update={
                    "injections": [], "recommend": False, "replications": min(req.replications, 20),
                    "outputs": req.outputs.model_copy(update={"raw_reps": []}),
                })
                reference = run_many(reference_req, workers)
            impacts = failure_impacts(req, reps[:min(req.replications, 20)], reference)
        rec = recommend(req, reps, insights, workers, impacts)
        if rec is not None:
            insights.append(rec)
    signals = sorted(({"time": t, "run_id": req.run_id, "rep": r.rep, "subject": s, "name": n, "value": v}
                      for r in reps for t, s, n, v in r.signals), key=lambda x: x["time"])
    events = sorted(({"time": t, "run_id": req.run_id, "rep": r.rep, "subject": s, "type": typ, "payload": p}
                     for r in reps for t, s, typ, p in r.events), key=lambda x: x["time"])
    wh_log: list[dict] = []
    if reps:
        primary = reps[0]
        try:
            wh_log = export_warehouse_series(primary, req.nodes)
        except Exception:
            wh_log = []
    return RunResult(req.run_id, ENGINE_VERSION, aggregate_kpis(reps), bands(req, reps), insights,
                     signals, events, wh_log)


def to_csv(result: RunResult) -> str:
    buf = io.StringIO()
    w = csv.writer(buf, lineterminator="\n")
    w.writerow(["kind", "time", "rep", "subject", "name", "value"])
    for s in result.signals:
        w.writerow(["signal", s["time"].isoformat(), s["rep"], s["subject"], s["name"], f"{s['value']:.6g}"])
    for e in result.events:
        w.writerow(["event", e["time"].isoformat(), e["rep"], e["subject"], e["type"],
                    json.dumps(e["payload"], default=str)])
    return buf.getvalue()
