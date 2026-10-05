"""Recommend: loại hành động định nghĩa sẵn × ứng viên sinh từ đồ thị × chấm bằng mô phỏng (CRN)."""
from __future__ import annotations

import json
import math
from collections import defaultdict
from dataclasses import dataclass, field

from sim_service.contract import EdgeSpec, Injection, RunRequest, apply_overrides
from sim_service.dists import mean_of
from sim_service.engine import RepResult
from sim_service.impact import mean_line_metrics, metric_delta
from sim_service.montecarlo import run_many
from sim_service.nodes.process import mean_cycle_s, process_material_rate

MAX_DEPTH = 8
REC_REPS = 20
MAX_SLOTS = 8
MIN_RATE_FACTOR = 0.5
THROUGHPUT_COLLAPSE = 0.5
MAX_WORSEN_FRACTION = 0.10
MAX_WORSEN_ABS = 1.0
MAX_STARVED_WORSEN_ABS_S = 60.0
MIN_SCORE_V2 = 0.0
MIN_MEANINGFUL_IMPROVEMENT = {
    "throughput": 1.0,
    "red_minutes": 1.0,
    "backorder": 1.0,
    "blocked_s": 60.0,
    "starved_s": 60.0,
    "wip_peak": 1.0,
}

# Mọi component là delta đã chia cho độ lớn baseline; weights tập trung ở đây để dễ tune cho demo/nghiệp vụ.
SCORE_WEIGHTS = {
    "throughput": 1.5,
    "red_minutes": 2.0,
    "backorder": 1.5,
    "blocked_s": 0.6,
    "starved_s": 0.4,
    "wip_peak": 0.5,
    "action_cost": 0.25,
}


@dataclass
class Candidate:
    action: dict
    overrides: list[dict] = field(default_factory=list)
    injections: list[Injection] | None = None
    reason: str | None = None
    evidence: dict = field(default_factory=dict)

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
    reason = f"{pool_key} có thời gian chờ nguồn lực cao; tăng một đơn vị được kiểm chứng bằng mô phỏng."
    return [Candidate(action, [{"target": pool_key, "path": "/count", "value": pool.count + 1}], reason=reason)]


def _scale_duration(spec, factor: float):
    """Giữ dạng phân phối cycle và nhân mọi tham số có đơn vị thời gian."""
    if isinstance(spec, (int, float)):
        return float(spec) * factor
    out = dict(spec)
    for key in ("value", "value_s", "mean", "mean_s", "sd", "sd_s", "min", "min_s", "mode", "mode_s",
                "max", "max_s", "scale", "scale_s"):
        if key in out:
            out[key] = float(out[key]) * factor
    return out


def _machine_candidates(req: RunRequest, insight: dict) -> list[Candidate]:
    nodes = {n.key: n for n in req.nodes}
    target = nodes.get(insight["subject_key"])
    if target is None or target.archetype != "PROCESS":
        return []
    evidence = dict(insight.get("payload", {}).get("evidence") or {})
    out: list[Candidate] = []
    slots = int(target.params.get("slots", 1))
    if slots < MAX_SLOTS and (evidence.get("utilization", 0.0) >= 0.75 or evidence.get("capacity_gap", 0.0) > 0):
        out.append(Candidate(
            {"type": "INCREASE_PROCESS_CAPACITY", "target": target.key, "delta": 1,
             "from_slots": slots, "to_slots": slots + 1, "cost": 5.0},
            [{"target": target.key, "path": "/slots", "value": slots + 1}],
            reason=(f"{target.key} giới hạn lưu lượng dây chuyền; mô phỏng thêm một slot để định lượng lợi ích "
                    "trước khi xác nhận tính khả thi về thiết bị và nhân lực."),
            evidence=evidence,
        ))

    incoming = [e for e in req.edges if e.dst == target.key and e.src in nodes and nodes[e.src].archetype == "PROCESS"]
    # Với nhiều upstream, model chưa biểu diễn allocation/routing; không tự chia capacity rồi giảm nhầm máy.
    if len(incoming) == 1:
        edge = incoming[0]
        upstream = nodes[edge.src]
        upstream_rate = process_material_rate(upstream.params, edge.material)
        target_rate = process_material_rate(target.params, edge.material, side="inputs")
        if target_rate <= 0 or upstream_rate <= target_rate * 1.05:
            return out
        if evidence.get("upstream_wip_growth", 0.0) <= 0 and evidence.get("capacity_gap", 0.0) <= 0:
            return out
        desired = max(target_rate * 1.05, upstream_rate * MIN_RATE_FACTOR)
        if math.isfinite(desired) and 0 < desired < upstream_rate:
            factor = upstream_rate / desired
            cycle = upstream.params.get("cycle", 1.0)
            out.append(Candidate(
                {"type": "REDUCE_MACHINE_RATE", "target": upstream.key, "from_rate": upstream_rate,
                 "to_rate": desired, "delta": desired - upstream_rate, "cost": 1.0},
                [{"target": upstream.key, "path": "/cycle", "value": _scale_duration(cycle, factor)}],
                reason=(f"{upstream.key} cấp {edge.material} nhanh hơn khả năng tiêu thụ của {target.key}; "
                        "giảm nhịp upstream để hạn chế WIP dồn trước điểm nghẽn."),
                evidence={**evidence, "upstream_rate": upstream_rate, "target_input_rate": target_rate},
            ))
    return out


def _immediate_upstream(req: RunRequest, target: str) -> list:
    nodes = {n.key: n for n in req.nodes}
    return [nodes[e.src] for e in req.edges if e.dst == target and e.src in nodes and nodes[e.src].archetype == "PROCESS"]


def _failure_candidates(req: RunRequest, impacts: list[dict]) -> list[Candidate]:
    out: list[Candidate] = []
    for impact in impacts:
        failed = impact["failed_machine"]
        duration = float(impact.get("downtime_s", 0.0))
        at_s = float(impact.get("failure_at", 0.0))
        caused_blocked = impact.get("additional_upstream_blocked_s")
        if duration <= 0 or caused_blocked is None or float(caused_blocked) <= 0:
            continue
        for upstream in _immediate_upstream(req, failed):
            evidence = {k: impact[k] for k in ("downtime_s", "additional_upstream_blocked_s",
                                                "additional_downstream_starved_s",
                                                "caused_upstream_blocked_s", "caused_downstream_starved_s",
                                                "throughput_loss", "throughput_loss_pct") if k in impact}
            # Không dùng override cycle cho recovery: override đó tác động toàn horizon, không chỉ cửa sổ downtime.
            stop = Injection(target=upstream.key, kind="planned_stop", at_s=at_s, duration_s=duration)
            out.append(Candidate(
                {"type": "STOP_MACHINE", "target": upstream.key, "at_s": at_s, "duration_s": duration,
                 "cost": 2.0, "safety_reason": "failure_recovery"},
                [], [*req.injections, stop],
                reason=f"Tạm dừng {upstream.key} trong thời gian {failed} phục hồi để tránh sản xuất WIP không thể đi tiếp.",
                evidence=evidence,
            ))
    return out


def generate(req: RunRequest, insights: list[dict], failure_impacts: list[dict] | None = None) -> list[Candidate]:
    out: dict[str, Candidate] = {}
    nodes = {n.key: n for n in req.nodes}
    pools = {p.key for p in req.pools}

    def add(c: Candidate) -> None:
        out.setdefault(c.fingerprint(), c)

    for ins in insights:
        subject = ins["subject_key"]
        if ins["kind"] == "BOTTLENECK" and ins.get("payload", {}).get("ambiguous"):
            continue
        if ins["kind"] == "BOTTLENECK":
            for c in _machine_candidates(req, ins):
                add(c)
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
                              [{"target": k, "path": "/replenish/rop", "value": new}],
                              reason=f"{k} nằm trên đường cấp cho rủi ro hiện tại; tăng reorder point để bổ sung sớm hơn."))
        for inj in req.injections:
            if inj.kind != "failure" or inj.target not in up_nodes:
                continue
            mode = next(m for m in nodes[inj.target].params["failure_modes"] if m["code"] == inj.failure)
            dur = max(60.0, 0.5 * mean_of(mode.get("on_fail", {}).get("mttr")))
            for t in (0.0, inj.at_s / 2.0):
                stop = Injection(target=inj.target, kind="planned_stop", at_s=t, duration_s=dur)
                add(Candidate({"type": "PLANNED_STOP", "target": inj.target, "at_s": t,
                               "duration_s": dur, "cost": 2.0}, [], [*req.injections, stop],
                              reason=f"Bảo trì {inj.target} trước failure dự kiến và kiểm chứng tác động bằng mô phỏng."))
    for c in _failure_candidates(req, failure_impacts or []):
        add(c)
    return list(out.values())


def candidate_request(req: RunRequest, cand: Candidate) -> RunRequest:
    r = apply_overrides(req, cand.overrides)
    update = {"recommend": False, "replications": min(req.replications, REC_REPS),
              "outputs": r.outputs.model_copy(update={"raw_reps": []})}
    if cand.injections is not None:
        update["injections"] = cand.injections
    return r.model_copy(update=update)


def _valid_candidate(req: RunRequest, cand: Candidate) -> bool:
    try:
        cost = float(cand.action.get("cost", 1.0))
        if not math.isfinite(cost) or cost <= 0:
            return False
        changed = apply_overrides(req, cand.overrides)
        for node in changed.nodes:
            if node.archetype == "PROCESS":
                if int(node.params.get("slots", 1)) <= 0 or mean_cycle_s(node.params) <= 0:
                    return False
        return True
    except (KeyError, TypeError, ValueError):
        return False


def _too_much_worse(base: float, candidate: float, absolute: float = MAX_WORSEN_ABS) -> bool:
    return candidate - base > max(absolute, abs(base) * MAX_WORSEN_FRACTION)


def _meaningful_improvement(delta: dict[str, float]) -> bool:
    for name, threshold in MIN_MEANINGFUL_IMPROVEMENT.items():
        value = delta.get(name)
        if value is None:
            continue
        benefit = value if name == "throughput" else -value
        if benefit >= threshold:
            return True
    return False


def _meaningful_safety_benefit(delta: dict[str, float]) -> bool:
    return (delta.get("blocked_s", 0.0) <= -MIN_MEANINGFUL_IMPROVEMENT["blocked_s"]
            or delta.get("wip_peak", 0.0) <= -MIN_MEANINGFUL_IMPROVEMENT["wip_peak"]
            or delta.get("starved_s", 0.0) <= -MIN_MEANINGFUL_IMPROVEMENT["starved_s"])


def _normalized_score(base: dict[str, float], candidate: dict[str, float], cost: float) -> tuple[float, dict]:
    components: dict[str, float] = {}
    for name in ("throughput", "red_minutes", "backorder", "blocked_s", "starved_s", "wip_peak"):
        if name not in base or name not in candidate:
            continue
        delta = candidate[name] - base[name]
        benefit = delta if name == "throughput" else -delta
        components[name] = benefit / max(abs(base[name]), 1.0)
    components["action_cost"] = -cost / 10.0
    weight_total = sum(abs(SCORE_WEIGHTS[name]) for name in components)
    score = sum(SCORE_WEIGHTS[name] * value for name, value in components.items()) / weight_total
    return score, components


def rank(req: RunRequest, baseline: list[RepResult], cands: list[Candidate],
         workers: int = 1, top: int = 3) -> list[dict]:
    base = baseline[:min(req.replications, REC_REPS)]
    base_metrics = mean_line_metrics(base)
    b_red, b_thr = base_metrics["red_minutes"], base_metrics["throughput"]
    scored = []
    for c in cands:
        if not _valid_candidate(req, c):
            continue
        try:
            reps = run_many(candidate_request(req, c), workers)
        except (KeyError, TypeError, ValueError):
            continue
        candidate_metrics = mean_line_metrics(reps)
        d_red = b_red - candidate_metrics["red_minutes"]
        d_thr = candidate_metrics["throughput"] - b_thr
        safety = bool(c.action.get("safety_reason"))
        if d_red < 0:
            continue  # giữ hard constraint cũ: không đề xuất hành động làm tăng phút Đỏ
        if "backorder" in base_metrics and "backorder" in candidate_metrics and _too_much_worse(base_metrics["backorder"], candidate_metrics["backorder"]):
            continue
        if "starved_s" in base_metrics and "starved_s" in candidate_metrics and _too_much_worse(
                base_metrics["starved_s"], candidate_metrics["starved_s"], MAX_STARVED_WORSEN_ABS_S):
            continue
        delta = metric_delta(base_metrics, candidate_metrics)
        if b_thr > 0 and candidate_metrics["throughput"] < b_thr * THROUGHPUT_COLLAPSE \
                and not (safety and _meaningful_safety_benefit(delta)):
            continue
        secondary = any(delta.get(k, 0.0) < 0 for k in ("backorder", "blocked_s", "starved_s", "wip_peak"))
        if d_red == 0 and d_thr <= 0 and not secondary:
            continue
        if not _meaningful_improvement(delta):
            continue
        cost = float(c.action.get("cost", 1.0))
        score_v2, components = _normalized_score(base_metrics, candidate_metrics, cost)
        if score_v2 <= MIN_SCORE_V2:
            continue
        scored.append({"action": c.action, "overrides": c.overrides,
                       "injections": [i.model_dump() for i in c.injections] if c.injections is not None else None,
                       "delta_kpi": {"red_minutes": d_red, "throughput": d_thr},
                       "reason": c.reason, "evidence": c.evidence,
                       "expected_impact": {"baseline": base_metrics, "candidate": candidate_metrics, "delta": delta},
                       "score": d_red / cost, "score_v2": score_v2, "score_components": components})
    scored.sort(key=lambda s: (s["score_v2"], s["delta_kpi"]["throughput"]), reverse=True)
    best = scored[:top]
    for i, s in enumerate(best, 1):
        s["rank"] = i
    return best


def recommend(req: RunRequest, baseline: list[RepResult], insights: list[dict], workers: int = 1,
              failure_impact: list[dict] | None = None) -> dict | None:
    targets = [i for i in insights if i["kind"] in ("RED_RISK", "BOTTLENECK")]
    if not targets and not failure_impact:
        return None
    ranked = rank(req, baseline, generate(req, targets, failure_impact), workers)
    if not ranked:
        return None
    if targets:
        lead = max(targets, key=lambda i: (i["severity"], i["probability"]))
    else:
        impact = failure_impact[0]
        lead = {"kind": "FAILURE_IMPACT", "subject_key": impact["failed_machine"],
                "eta": req.sim_start, "severity": 3, "probability": 1.0}
    return {"kind": "RECOMMENDATION", "subject_key": lead["subject_key"], "eta": lead["eta"],
            "probability": None, "severity": lead["severity"],
            "payload": {"candidates": ranked, "source_event": lead["kind"],
                        "source_kind": lead["kind"], "source_subject": lead["subject_key"],
                        "failure_impacts": failure_impact or []}}
