"""Recommend: loại hành động định nghĩa sẵn × ứng viên sinh từ đồ thị × chấm bằng mô phỏng (CRN)."""
from __future__ import annotations

import json
import math
from collections import defaultdict
from dataclasses import dataclass, field

import numpy as np

from sim_service.contract import EdgeSpec, Injection, RunRequest, apply_overrides
from sim_service.dists import mean_of
from sim_service.engine import RepResult
from sim_service.montecarlo import run_many

MAX_DEPTH = 8
REC_REPS = 20


@dataclass
class Candidate:
    action: dict
    overrides: list[dict] = field(default_factory=list)
    injections: list[Injection] | None = None

    def fingerprint(self) -> str:
        inj = [i.model_dump() for i in self.injections] if self.injections is not None else None
        return json.dumps({"o": self.overrides, "i": inj}, sort_keys=True)


def upstream(req: RunRequest, key: str, depth: int = MAX_DEPTH) -> tuple[set[str], list[EdgeSpec]]:
    into: dict[str, list[EdgeSpec]] = defaultdict(list)
    for e in req.edges:
        into[e.dst].append(e)
    seen, edges, frontier = {key}, [], [key]
    for _ in range(depth):
        nxt = []
        for k in frontier:
            for e in into[k]:
                edges.append(e)
                if e.src not in seen:
                    seen.add(e.src)
                    nxt.append(e.src)
        frontier = nxt
    return seen, edges


def _pool_candidates(req: RunRequest, pool_key: str) -> list[Candidate]:
    pool = next(p for p in req.pools if p.key == pool_key)
    operator = pool.kind == "OPERATOR"
    action = {"type": "REALLOCATE_OPERATOR" if operator else "FLEET_SIZE", "target": pool_key,
              "delta": 1, "cost": 1.0 if operator else 3.0}
    return [Candidate(action, [{"target": pool_key, "path": "/count", "value": pool.count + 1}])]


def generate(req: RunRequest, insights: list[dict]) -> list[Candidate]:
    out: dict[str, Candidate] = {}
    nodes = {n.key: n for n in req.nodes}
    pools = {p.key for p in req.pools}

    def add(c: Candidate) -> None:
        out.setdefault(c.fingerprint(), c)

    for ins in insights:
        subject = ins["subject_key"]
        if ins["kind"] == "BOTTLENECK" and subject in pools:
            for c in _pool_candidates(req, subject):
                add(c)
            continue
        if ins["kind"] not in ("RED_RISK", "BOTTLENECK") or subject not in nodes:
            continue
        up_nodes, up_edges = upstream(req, subject)
        for e in up_edges:
            if e.mode == "POOL":
                for pk in (e.hook_pool, e.pool):
                    if pk:
                        for c in _pool_candidates(req, pk):
                            add(c)
        for k in sorted(up_nodes):
            rp = nodes[k].params.get("replenish", {})
            if nodes[k].archetype == "STORAGE" and rp.get("policy") == "REORDER_POINT":
                new = math.ceil(float(rp.get("rop", 0)) * 1.5) or 1
                add(Candidate({"type": "REPLENISH", "target": k, "rop": new, "cost": 1.0},
                              [{"target": k, "path": "/replenish/rop", "value": new}]))
        for inj in req.injections:
            if inj.kind != "failure" or inj.target not in up_nodes:
                continue
            mode = next(m for m in nodes[inj.target].params["failure_modes"] if m["code"] == inj.failure)
            dur = max(60.0, 0.5 * mean_of(mode.get("on_fail", {}).get("mttr")))
            for t in (0.0, inj.at_s / 2.0):
                stop = Injection(target=inj.target, kind="planned_stop", at_s=t, duration_s=dur)
                add(Candidate({"type": "PLANNED_STOP", "target": inj.target, "at_s": t,
                               "duration_s": dur, "cost": 2.0}, [], [*req.injections, stop]))
    return list(out.values())


def candidate_request(req: RunRequest, cand: Candidate) -> RunRequest:
    r = apply_overrides(req, cand.overrides)
    update = {"recommend": False, "replications": min(req.replications, REC_REPS),
              "outputs": r.outputs.model_copy(update={"raw_reps": []})}
    if cand.injections is not None:
        update["injections"] = cand.injections
    return r.model_copy(update=update)


def _mean(reps: list[RepResult], key: str) -> float:
    return float(np.mean([r.kpis[key] for r in reps]))


def rank(req: RunRequest, baseline: list[RepResult], cands: list[Candidate],
         workers: int = 1, top: int = 3) -> list[dict]:
    base = baseline[:min(req.replications, REC_REPS)]
    b_red, b_thr = _mean(base, "red_minutes"), _mean(base, "throughput")
    scored = []
    for c in cands:
        reps = run_many(candidate_request(req, c), workers)
        d_red = b_red - _mean(reps, "red_minutes")
        d_thr = _mean(reps, "throughput") - b_thr
        if d_red <= 0 and d_thr <= 0:
            continue
        scored.append({"action": c.action, "overrides": c.overrides,
                       "injections": [i.model_dump() for i in c.injections] if c.injections is not None else None,
                       "delta_kpi": {"red_minutes": d_red, "throughput": d_thr},
                       "score": d_red / c.action["cost"]})
    scored.sort(key=lambda s: (s["score"], s["delta_kpi"]["throughput"]), reverse=True)
    best = scored[:top]
    for i, s in enumerate(best, 1):
        s["rank"] = i
    return best


def recommend(req: RunRequest, baseline: list[RepResult], insights: list[dict], workers: int = 1) -> dict | None:
    targets = [i for i in insights if i["kind"] in ("RED_RISK", "BOTTLENECK")]
    if not targets:
        return None
    ranked = rank(req, baseline, generate(req, targets), workers)
    if not ranked:
        return None
    lead = max(targets, key=lambda i: (i["severity"], i["probability"]))
    return {"kind": "RECOMMENDATION", "subject_key": lead["subject_key"], "eta": lead["eta"],
            "probability": None, "severity": lead["severity"], "payload": {"candidates": ranked}}
