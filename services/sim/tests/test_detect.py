from datetime import timedelta

import pytest

from helpers import SIM_START, load_request, make_request
from sim_service.detect import active_period_shares, active_periods, detect
from sim_service.engine import RepResult
from sim_service.montecarlo import run_many
from sim_service.recommend import candidate_request, generate, rank


def fake_rep(first_red=None, red_s=0.0, hook_wait=0.0, intervals=None):
    return RepResult(0, {
        "storages": {"FG": {"red_s": red_s, "first_red_s": first_red}},
        "edges": {"KHO_NVL>STAMP_1": {"wait_pool_mean": 0.0, "wait_hook_mean": hook_wait},
                  "KHO_NVL>STAMP_2": {"wait_pool_mean": 0.0, "wait_hook_mean": hook_wait},
                  "KHO_NVL>STAMP_3": {"wait_pool_mean": 0.0, "wait_hook_mean": hook_wait}},
    }, {}, intervals or {}, {}, [], [])


def test_active_periods_merge_active_states():
    ivs = [("RUNNING", 0, 10), ("DOWN", 10, 20), ("STARVED", 20, 30), ("RUNNING", 30, 40)]
    assert active_periods(ivs) == [(0, 20), (30, 40)]


def test_active_period_shares_picks_longest_active():
    shares = active_period_shares({"A": [(0, 100)], "B": [(0, 50), (60, 100)]}, horizon=100, step=10)
    assert shares["A"] == pytest.approx(1.0)
    assert "B" not in shares


def test_active_period_shares_splits_exact_and_near_ties():
    exact = active_period_shares({"A": [(0, 100)], "B": [(0, 100)]}, horizon=100, step=10)
    assert exact == pytest.approx({"A": 0.5, "B": 0.5})

    near = active_period_shares({"A": [(0, 100)], "B": [(0, 100.0000005)]}, horizon=100, step=10)
    assert near == pytest.approx({"A": 0.5, "B": 0.5})


def test_detect_marks_shared_bottleneck_ambiguous_and_generates_no_action():
    def process(key):
        return {"key": key, "archetype": "PROCESS", "params": {
            "cycle": 10, "recipes": [{"inputs": [], "outputs": [{"material": "X", "qty": 1}]}]}}

    req = make_request([process("A"), process("B")], horizon_s=100)
    rep = RepResult(0, {"processes": {}, "storages": {}, "edges": {}}, {}, {
        "A": [("RUNNING", 0, 100)], "B": [("RUNNING", 0, 100)],
    }, {}, [], [])
    bottleneck = next(i for i in detect(req, [rep]) if i["kind"] == "BOTTLENECK")
    assert bottleneck["payload"]["ambiguous"] is True
    assert bottleneck["payload"]["co_bottlenecks"] == ["A", "B"]
    assert bottleneck["probability"] == pytest.approx(0.5)
    assert generate(req, [bottleneck]) == []


def test_red_risk_probability_eta_and_severity():
    req = load_request("denso_mini")
    reps = [fake_rep(first_red=600, red_s=300), fake_rep(first_red=1200, red_s=100), fake_rep(), fake_rep()]
    red = [i for i in detect(req, reps) if i["kind"] == "RED_RISK"]
    assert len(red) == 1
    assert red[0]["subject_key"] == "FG"
    assert red[0]["probability"] == 0.5 and red[0]["severity"] == 3
    assert red[0]["eta"] == SIM_START + timedelta(seconds=900)  # median(600, 1200)


def test_hook_wait_bottleneck_deduplicated_per_pool():
    req = load_request("denso_mini")
    ins = detect(req, [fake_rep(hook_wait=200.0)])
    hooks = [i for i in ins if i["kind"] == "BOTTLENECK" and i["subject_key"] == "OPS_ZONE_B"]
    assert len(hooks) == 1
    assert hooks[0]["payload"]["mean_s"] == pytest.approx(200.0)


def test_detect_on_real_run_finds_process_bottleneck():
    req = load_request("denso_mini", horizon_s=7200, replications=2)
    ins = detect(req, run_many(req))
    procs = {n.key for n in req.nodes if n.archetype == "PROCESS"}
    assert any(i["kind"] == "BOTTLENECK" and i["subject_key"] in procs for i in ins)


def test_capacity_line_identifies_slowest_process_with_evidence():
    def process(key, rate):
        return {"key": key, "archetype": "PROCESS", "params": {
            "cycle": 3600 / rate, "in_buffer": 4, "out_buffer": 4,
            "recipes": [{"inputs": [{"material": "X", "qty": 1}],
                         "outputs": [{"material": "X", "qty": 1}]}]}}

    nodes = [{"key": "SRC", "archetype": "SOURCE", "params": {
        "arrivals": {"interarrival": 20}, "lots": [{"material": "X", "qty": 1}]}}]
    nodes += [process("A", 100), process("B", 70), process("C", 90), process("D", 100)]
    nodes += [{"key": "OUT", "archetype": "SINK", "params": {}}]
    keys = ["SRC", "A", "B", "C", "D", "OUT"]
    edges = [{"key": f"{a}>{b}", "src": a, "dst": b, "material": "X"} for a, b in zip(keys, keys[1:])]
    req = make_request(nodes, edges, horizon_s=4 * 3600, replications=2, raw_reps=(), sample_s=60)
    reps = run_many(req)
    bottleneck = next(i for i in detect(req, reps) if i["kind"] == "BOTTLENECK")
    assert bottleneck["subject_key"] == "B"
    assert bottleneck["payload"]["ambiguous"] is False
    assert bottleneck["payload"]["co_bottlenecks"] == ["B"]
    evidence = bottleneck["payload"]["evidence"]
    assert evidence["nominal_rate"] == pytest.approx(70)
    assert 0 <= evidence["utilization"] <= 1
    assert evidence["upstream_wip_growth"] > 0
    assert evidence["capacity_gap"] == pytest.approx(30)

    candidates = generate(req, [bottleneck])
    kinds = {c.action["type"] for c in candidates}
    assert {"INCREASE_PROCESS_CAPACITY", "REDUCE_MACHINE_RATE"} <= kinds
    for candidate in candidates:
        rerun = run_many(candidate_request(req, candidate))
        assert rerun[0].kpis["processes"]
    ranked = rank(req, reps, candidates)
    assert ranked
    assert all(c["action"]["type"] in kinds and c["expected_impact"]["delta"] for c in ranked)
