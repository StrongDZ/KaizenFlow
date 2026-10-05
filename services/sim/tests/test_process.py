import numpy as np
import pytest

from helpers import make_request
from sim_service.engine import run_replication


def proc(key="M", inputs=(("X", 1),), outputs=(("Y", 1, "OK"),), **params):
    return {"key": key, "archetype": "PROCESS", "params": {
        "recipes": [{"inputs": [{"material": m, "qty": q} for m, q in inputs],
                     "outputs": [{"material": m, "qty": q, "port": p} for m, q, p in outputs]}],
        **params}}


def source(key, material, **arrivals):
    return {"key": key, "archetype": "SOURCE",
            "params": {"arrivals": arrivals, "lots": [{"material": material, "qty": 1}]}}


def sink(key="OUT", **params):
    return {"key": key, "archetype": "SINK", "params": params}


def edge(src, dst, m):
    return {"key": f"{src}>{dst}", "src": src, "dst": dst, "material": m}


def test_mm1_queue_matches_theory():
    # ρ = 45/60 = 0.75 → Lq = ρ²/(1−ρ) = 2.25
    req = make_request(
        [source("SRC", "X", interarrival={"dist": "exp", "mean": 60}),
         proc(cycle={"dist": "exp", "mean": 45}, in_buffer=1e9, out_buffer=1e9),
         sink()],
        [edge("SRC", "M", "X"), edge("M", "OUT", "Y")],
        horizon_s=3_000_000, warmup_s=5000, raw_reps=(), sample_s=30, seed=3)
    res = run_replication(req)
    lq = np.mean([v for _, v in res.series[("M", "in:X")]])
    assert lq == pytest.approx(2.25, rel=0.15)


def test_ng_split_mass_balance():
    req = make_request(
        [source("SRC", "X", schedule_s=[0] * 100),
         proc(outputs=(("Y", 1, "OK"), ("Z", 1, "NG")), cycle=5, ng_rate=0.2),
         sink("OUT"), sink("SCRAP", throughput=False)],
        [edge("SRC", "M", "X"), edge("M", "OUT", "Y"), edge("M", "SCRAP", "Z")],
        horizon_s=5000)
    k = run_replication(req).kpis
    m = k["processes"]["M"]
    assert m["count_ok"] + m["count_ng"] == 100
    assert 5 <= m["count_ng"] <= 40
    assert k["sinks"]["OUT"]["fulfilled"] + k["sinks"]["SCRAP"]["fulfilled"] == 100
    assert k["throughput"] == k["sinks"]["OUT"]["fulfilled"]


def test_assembly_consumes_bom():
    req = make_request(
        [source("A", "A", schedule_s=[0] * 100), source("B", "B", schedule_s=[0] * 200),
         proc("ASSY", inputs=(("A", 1), ("B", 2)), outputs=(("S", 1, "OK"),), cycle=1), sink()],
        [edge("A", "ASSY", "A"), edge("B", "ASSY", "B"), edge("ASSY", "OUT", "S")],
        horizon_s=3000)
    assert run_replication(req).kpis["sinks"]["OUT"]["fulfilled"] == 100


def test_mtbf_failures_create_down_state():
    req = make_request(
        [source("SRC", "X", interarrival=1), proc(cycle=1, mtbf=1000, mttr=100), sink()],
        [edge("SRC", "M", "X"), edge("M", "OUT", "Y")],
        horizon_s=10000)
    down = run_replication(req).kpis["processes"]["M"]["state_s"]["DOWN"]
    assert down == pytest.approx(900, abs=1)


def test_blocked_when_output_full_and_run_still_ends():
    req = make_request(
        [source("SRC", "X", interarrival=1), proc(cycle=1, out_buffer=2),
         sink(buffer=1, demand=[{"kind": "TAKT", "material": "Y", "takt": 1000}])],
        [edge("SRC", "M", "X"), edge("M", "OUT", "Y")],
        horizon_s=5000)
    st = run_replication(req).kpis["processes"]["M"]["state_s"]
    assert st["BLOCKED"] > 2500


def test_process_kpis_expose_capacity_state_counts_and_wip():
    req = make_request(
        [source("SRC", "X", interarrival=1),
         proc(cycle={"dist": "tri", "min": 45, "mode": 60, "max": 75}, slots=2,
              outputs=(("Y", 2, "OK"),), in_buffer=20, out_buffer=10),
         sink()],
        [edge("SRC", "M", "X"), edge("M", "OUT", "Y")],
        horizon_s=3600, sample_s=60)
    k = run_replication(req).kpis["processes"]["M"]
    assert k["nominal_rate"] == pytest.approx(240.0)  # 2 slots × 2 units × 3600 / mean(45,60,75)
    assert k["effective_throughput"] == pytest.approx(k["count_ok"] * 2)
    assert k["utilization"] == k["util"]
    assert k["running_s"] == k["state_s"].get("RUNNING", 0.0)
    assert k["blocked_ratio"] == pytest.approx(k["blocked_s"] / 3600)
    assert k["starved_ratio"] == pytest.approx(k["starved_s"] / 3600)
    assert k["down_ratio"] == pytest.approx(k["down_s"] / 3600)
    assert sum(k[f"{state.lower()}_s"] for state in ("RUNNING", "BLOCKED", "STARVED", "DOWN", "IDLE")) == pytest.approx(3600)
    assert k["input_wip_peak"] >= k["input_wip_end"] >= 0
    assert k["output_wip_peak"] >= k["output_wip_end"] >= 0
