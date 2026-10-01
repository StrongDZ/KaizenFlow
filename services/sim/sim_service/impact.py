"""Đo tác động line/failure từ kết quả simulation, không mô phỏng propagation riêng."""
from __future__ import annotations

from collections import defaultdict
import math
from statistics import mean

from sim_service.contract import RunRequest
from sim_service.engine import RepResult


def mean_line_metrics(reps: list[RepResult]) -> dict[str, float]:
    """Các đại lượng cùng định nghĩa cho baseline/candidate, dùng bởi impact và ranking."""
    if not reps:
        return {}

    out: dict[str, float] = {}

    def add(name, getter) -> None:
        try:
            values = [float(getter(r)) for r in reps]
        except (KeyError, TypeError, ValueError):
            return  # metric không có trong result cũ/test double: bỏ khỏi score, không giả là 0
        if not all(math.isfinite(value) for value in values):
            return
        out[name] = float(mean(values))

    def line_wip_peak(rep: RepResult) -> float:
        processes = set(rep.kpis["processes"])
        by_time: dict[float, float] = defaultdict(float)
        for (subject, metric), values in rep.series.items():
            if subject in processes and metric.startswith(("in:", "out:")):
                for at, value in values:
                    by_time[at] += value
        if not by_time:
            raise KeyError("process WIP series")
        # Samples are aligned by the recorder; include the exact end state exposed by each process KPI.
        final_wip = sum(p["input_wip_end"] + p["output_wip_end"] for p in rep.kpis["processes"].values())
        return max(max(by_time.values()), final_wip)

    add("throughput", lambda r: r.kpis["throughput"])
    add("red_minutes", lambda r: r.kpis["red_minutes"])
    add("backorder", lambda r: r.kpis["backorder"] if "backorder" in r.kpis else r.kpis["backorder_end"])
    add("blocked_s", lambda r: sum(p["blocked_s"] for p in r.kpis["processes"].values()))
    add("starved_s", lambda r: sum(p["starved_s"] for p in r.kpis["processes"].values()))
    add("wip_peak", line_wip_peak)
    return out


def metric_delta(baseline: dict[str, float], candidate: dict[str, float]) -> dict[str, float]:
    """Delta theo quy ước candidate - baseline; giảm red/backorder/state/WIP sẽ là số âm."""
    return {key: candidate[key] - baseline[key] for key in baseline.keys() & candidate.keys()}


def _reachable_processes(req: RunRequest, target: str, *, reverse: bool) -> set[str]:
    processes = {n.key for n in req.nodes if n.archetype == "PROCESS"}
    links: dict[str, list[str]] = defaultdict(list)
    for edge in req.edges:
        src, dst = (edge.dst, edge.src) if reverse else (edge.src, edge.dst)
        links[src].append(dst)
    seen, todo = {target}, [target]
    while todo:
        cur = todo.pop()
        for nxt in links[cur]:
            if nxt not in seen:
                seen.add(nxt)
                todo.append(nxt)
    return (seen - {target}) & processes


def _state_total(rep: RepResult, subjects: set[str], state: str) -> float:
    return sum(end - start for subject in subjects for st, start, end in rep.intervals.get(subject, []) if st == state)


def _first_state_after(rep: RepResult, subjects: set[str], state: str, after: float) -> float | None:
    starts = [max(start, after) for subject in subjects for st, start, end in rep.intervals.get(subject, [])
              if st == state and end > after]
    return min(starts) - after if starts else None


def _mean_defined(values: list[float | None]) -> float | None:
    present = [v for v in values if v is not None]
    return float(mean(present)) if present else None


def failure_impacts(req: RunRequest, failed: list[RepResult], reference: list[RepResult] | None = None) -> list[dict]:
    """Tóm tắt propagation quan sát được cho từng PROCESS có injection.

    Nếu có ``reference`` (cùng seed, bỏ injection tương ứng), các delta counterfactual được bổ sung. Field không đo được
    bị bỏ thay vì điền một ước lượng giả.
    """
    by_target: dict[str, list] = defaultdict(list)
    for injection in req.injections:
        if injection.at_s >= req.horizon_s:
            continue
        by_target[injection.target].append(injection)
    out: list[dict] = []
    ref_metrics = mean_line_metrics(reference or [])
    failed_metrics = mean_line_metrics(failed)
    for target, injections in by_target.items():
        at_s = min(i.at_s for i in injections)
        upstream = _reachable_processes(req, target, reverse=True)
        downstream = _reachable_processes(req, target, reverse=False)
        row: dict = {
            "failed_machine": target,
            "failure_at": at_s,
            "downtime_s": float(mean(r.kpis["processes"][target].get("down_s", 0.0) for r in failed)),
            "upstream_blocked_s": float(mean(_state_total(r, upstream, "BLOCKED") for r in failed)),
            "downstream_starved_s": float(mean(_state_total(r, downstream, "STARVED") for r in failed)),
        }
        first_block = _mean_defined([_first_state_after(r, upstream, "BLOCKED", at_s) for r in failed])
        first_starve = _mean_defined([_first_state_after(r, downstream, "STARVED", at_s) for r in failed])
        if first_block is not None:
            row["time_to_first_upstream_block"] = first_block
        if first_starve is not None:
            row["time_to_first_downstream_starve"] = first_starve

        planned = [i for i in injections if i.kind == "planned_stop" and i.duration_s is not None]
        if planned:
            expected_up = min(i.at_s + i.duration_s for i in planned)
            recovery = _mean_defined([_first_state_after(r, {target}, "RUNNING", expected_up) for r in failed])
            if recovery is not None:
                row["recovery_time"] = recovery

        # Một reference bỏ tất cả injection chỉ quy trách nhiệm chính xác khi chúng cùng một target.
        if ref_metrics and len(by_target) == 1:
            throughput_loss = ref_metrics["throughput"] - failed_metrics["throughput"]
            row.update({
                "throughput_loss": throughput_loss,
                "throughput_loss_pct": throughput_loss / ref_metrics["throughput"] if ref_metrics["throughput"] > 0 else None,
                "lost_output": throughput_loss,
                "backorder_delta": failed_metrics["backorder"] - ref_metrics["backorder"],
                "WIP_peak_delta": failed_metrics["wip_peak"] - ref_metrics["wip_peak"],
            })
        out.append(row)
    return out
