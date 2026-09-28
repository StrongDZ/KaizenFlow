"""Ghép: validate → Monte Carlo → Detect → Recommend → kết quả + CSV."""
from __future__ import annotations

import csv
import io
import json
from dataclasses import dataclass

from sim_service.contract import ENGINE_VERSION, RunRequest, validate_refs
from sim_service.detect import detect
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


def execute(req: RunRequest, workers: int = 1) -> RunResult:
    validate_refs(req)
    reps = run_many(req, workers)
    insights = detect(req, reps)
    if req.recommend:
        rec = recommend(req, reps, insights, workers)
        if rec is not None:
            insights.append(rec)
    signals = sorted(({"time": t, "run_id": req.run_id, "rep": r.rep, "subject": s, "name": n, "value": v}
                      for r in reps for t, s, n, v in r.signals), key=lambda x: x["time"])
    events = sorted(({"time": t, "run_id": req.run_id, "rep": r.rep, "subject": s, "type": typ, "payload": p}
                     for r in reps for t, s, typ, p in r.events), key=lambda x: x["time"])
    return RunResult(req.run_id, ENGINE_VERSION, aggregate_kpis(reps), bands(req, reps), insights, signals, events)


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
