"""Regression tests cho các finding của lần review toàn nhánh."""
import pytest

from helpers import load_request, make_request
from sim_service import recommend as rec_mod
from sim_service.contract import ContractError, apply_overrides, validate_refs
from sim_service.engine import RepResult, run_replication
from sim_service.recommend import Candidate, rank


# --- C1: common random numbers ---------------------------------------------
def _events(res, subject, typ):
    return [t for t, s, ty, _ in res.events if s == subject and ty == typ]


def test_crn_fleet_change_does_not_shift_exogenous_randomness():
    base = load_request("denso_mini", horizon_s=7200)
    more = apply_overrides(base, [{"target": "TUGGER_A", "path": "/count", "value": 3}])
    a, b = run_replication(base, 0), run_replication(more, 0)
    assert _events(a, "SUPPLIER", "ARRIVAL") == _events(b, "SUPPLIER", "ARRIVAL")
    assert _events(a, "STAMP_3", "FAULT_ONSET") == _events(b, "STAMP_3", "FAULT_ONSET")


# --- C2: overlapping down reasons -------------------------------------------
FM = {"code": "bearing", "p_to_f": {"dist": "const", "value": 1000},
      "on_fail": {"mttr": {"dist": "const", "value": 500}}}


def _machine(injections, **params):
    return make_request(
        [{"key": "SRC", "archetype": "SOURCE",
          "params": {"arrivals": {"interarrival": 1}, "lots": [{"material": "X", "qty": 1}]}},
         {"key": "M", "archetype": "PROCESS", "params": {
             "recipes": [{"inputs": [{"material": "X", "qty": 1}], "outputs": [{"material": "Y", "qty": 1}]}],
             "cycle": 1, "failure_modes": [FM], **params}},
         {"key": "OUT", "archetype": "SINK", "params": {}}],
        [{"key": "SRC>M", "src": "SRC", "dst": "M", "material": "X"},
         {"key": "M>OUT", "src": "M", "dst": "OUT", "material": "Y"}],
        horizon_s=1990, injections=injections)


def test_random_and_mode_failure_overlap_keeps_machine_down_until_both_clear():
    # RANDOM down 1000–1300, bearing FAILURE at 1100 → repair đến 1600
    req = _machine([{"target": "M", "failure": "bearing", "at_s": 1100}], mtbf=1000, mttr=300)
    assert run_replication(req).kpis["processes"]["M"]["state_s"]["DOWN"] == pytest.approx(600)


def test_planned_stop_spanning_failure_time_prevents_failure():
    req = _machine([{"target": "M", "failure": "bearing", "at_s": 1100},
                    {"target": "M", "kind": "planned_stop", "at_s": 1000, "duration_s": 400}])
    res = run_replication(req)
    assert _events(res, "M", "FAILURE") == []
    assert res.kpis["processes"]["M"]["state_s"]["DOWN"] == pytest.approx(400)


# --- I1: recommend không đề xuất hành động làm tệ hơn ------------------------
def _fake(red, thr):
    return RepResult(0, {"red_minutes": red, "throughput": thr}, {}, {}, {}, [], [])


def test_rank_drops_candidates_that_increase_red_minutes(monkeypatch):
    req = load_request("denso_mini", replications=2)
    monkeypatch.setattr(rec_mod, "run_many", lambda r, w=1: [_fake(12.0, 99.0)] * 2)
    cand = Candidate({"type": "FLEET_SIZE", "target": "TUGGER_A", "cost": 1.0},
                     [{"target": "TUGGER_A", "path": "/count", "value": 3}])
    assert rank(req, [_fake(10.0, 50.0)] * 2, [cand]) == []


# --- I2 / I3 / I5: validate bắt lỗi cấu hình trước khi chạy -------------------
SRC_OK = {"key": "SRC", "archetype": "SOURCE",
          "params": {"arrivals": {"interarrival": 10}, "lots": [{"material": "X", "qty": 1}]}}


def _sink(**params):
    return {"key": "OUT", "archetype": "SINK", "params": params}


EDGE = {"key": "SRC>OUT", "src": "SRC", "dst": "OUT", "material": "X"}


@pytest.mark.parametrize("nodes,edges,key", [
    ([{**SRC_OK, "params": {**SRC_OK["params"], "arrivals": {"interarrival": 0}}}, _sink()], [EDGE], "SRC"),
    ([{**SRC_OK, "params": {**SRC_OK["params"], "arrivals": {"interarrival": {"dist": "exp"}}}}, _sink()], [EDGE], "SRC"),
    ([SRC_OK, _sink(demand=[{"kind": "TAKT", "material": "X", "takt": 0}])], [EDGE], "OUT"),
    ([SRC_OK, _sink(demand=[{"kind": "WHATEVER", "material": "X"}])], [EDGE], "OUT"),
    ([SRC_OK, _sink(buffer=2)], [{**EDGE, "lot": 5}], "SRC>OUT"),
    ([SRC_OK, _sink()], [{**EDGE, "material": "Z"}], "SRC"),
])
def test_validate_rejects_bad_params(nodes, edges, key):
    with pytest.raises(ContractError) as e:
        validate_refs(make_request(nodes, edges))
    assert e.value.key == key


def test_validate_rejects_bad_sensor_and_effect():
    def proc(**p):
        return {"key": "M", "archetype": "PROCESS", "params": {
            "recipes": [{"inputs": [{"material": "X", "qty": 1}], "outputs": [{"material": "Y", "qty": 1}]}], **p}}
    for p in ({"signals": [{"name": "v", "base": 1.0, "hz": 0}]},
              {"failure_modes": [{"code": "f", "effects": [{"signal": "v", "kind": "wobble"}]}]}):
        with pytest.raises(ContractError) as e:
            validate_refs(make_request([proc(**p)]))
        assert e.value.key == "M"


# --- I4: direct edge không giữ chỗ khi nguồn chưa có hàng ---------------------
def test_slow_feeder_does_not_starve_merge_point():
    req = make_request(
        [{"key": "FAST", "archetype": "SOURCE",
          "params": {"arrivals": {"interarrival": 10}, "lots": [{"material": "X", "qty": 1}]}},
         {"key": "SLOW", "archetype": "SOURCE",
          "params": {"arrivals": {"schedule_s": [3000]}, "lots": [{"material": "X", "qty": 1}]}},
         {"key": "P", "archetype": "PROCESS", "params": {
             "recipes": [{"inputs": [{"material": "X", "qty": 1}], "outputs": [{"material": "Y", "qty": 1}]}],
             "cycle": 1, "in_buffer": 1}},
         _sink()],
        [{"key": "SLOW>P", "src": "SLOW", "dst": "P", "material": "X"},  # khởi động trước → giữ chỗ
         {"key": "FAST>P", "src": "FAST", "dst": "P", "material": "X"},
         {"key": "P>OUT", "src": "P", "dst": "OUT", "material": "Y"}],
        horizon_s=3600)
    assert run_replication(req).kpis["throughput"] > 300
