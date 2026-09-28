import pytest

from helpers import make_request
from sim_service.contract import ContractError
from sim_service.engine import run_replication


def src(key="SRC", material="X", **arr):
    return {"key": key, "archetype": "SOURCE",
            "params": {"arrivals": arr, "lots": [{"material": material, "qty": 1}]}}


def test_source_storage_sink_mass_balance():
    req = make_request(
        [src(schedule_s=[i * 10 for i in range(50)]),
         {"key": "S", "archetype": "STORAGE", "params": {}},
         {"key": "OUT", "archetype": "SINK", "params": {}}],
        [{"key": "SRC>S", "src": "SRC", "dst": "S", "material": "X"},
         {"key": "S>OUT", "src": "S", "dst": "OUT", "material": "X"}],
        horizon_s=2000)
    k = run_replication(req).kpis
    assert k["sources"]["SRC"]["arrived"] == {"X": 50.0}
    assert k["sinks"]["OUT"]["fulfilled"] == 50.0
    assert k["throughput"] == 50.0


def test_storage_turns_red_when_drained():
    req = make_request(
        [{"key": "S", "archetype": "STORAGE", "params": {"stock": [{"material": "X", "initial": 10}]}},
         {"key": "OUT", "archetype": "SINK", "params": {
             "buffer": 1, "demand": [{"kind": "TAKT", "material": "X", "takt": {"dist": "const", "value": 360}}]}}],
        [{"key": "S>OUT", "src": "S", "dst": "OUT", "material": "X"}],
        horizon_s=7200)
    k = run_replication(req).kpis
    s = k["storages"]["S"]
    assert s["red_s"] > 0
    assert s["first_red_s"] <= 3700
    assert k["red_minutes"] == pytest.approx(s["red_s"] / 60)
    assert k["sinks"]["OUT"]["backorder_end"] > 0


def test_conveyor_keeps_items_in_transit():
    req = make_request(
        [src(schedule_s=[0]), {"key": "OUT", "archetype": "SINK", "params": {"buffer": 100}}],
        [{"key": "SRC>OUT", "src": "SRC", "dst": "OUT", "material": "X", "mode": "CONVEYOR",
          "travel": {"dist": "const", "value": 100}, "max_in_transit": 5}],
        horizon_s=300, sample_s=10)
    req.nodes[0].params["lots"][0]["qty"] = 5
    res = run_replication(req)
    series = dict(res.series[("SRC>OUT", "in_transit")])
    assert series[50.0] == 5.0
    assert res.kpis["sinks"]["OUT"]["fulfilled"] == 5.0


def test_forecast_demand_rate_and_zero_rate():
    def sink(rates):
        return {"key": "OUT", "archetype": "SINK",
                "params": {"demand": [{"kind": "FORECAST", "material": "X", "hourly_rate": rates}]}}
    busy = run_replication(make_request([sink([60.0])], horizon_s=3600, sample_s=3599)).series
    demanded = busy[("OUT", "demand")][-1][1]
    assert 35 <= demanded <= 90
    idle = run_replication(make_request([sink([0.0, 0.0])], horizon_s=3600)).series
    assert idle[("OUT", "demand")][-1][1] == 0.0


def test_unknown_material_raises():
    req = make_request(
        [src(schedule_s=[0]), {"key": "OUT", "archetype": "SINK", "params": {}}],
        [{"key": "SRC>OUT", "src": "SRC", "dst": "OUT", "material": "Y"}])
    with pytest.raises(ContractError) as e:
        run_replication(req)
    assert e.value.key == "SRC"
