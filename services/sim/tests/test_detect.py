from datetime import timedelta

import pytest

from helpers import SIM_START, load_request
from sim_service.detect import active_period_shares, active_periods, detect
from sim_service.engine import RepResult
from sim_service.montecarlo import run_many


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
