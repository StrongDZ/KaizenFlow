import math

from helpers import make_request
from sim_service.aggregate import export_warehouse_series
from sim_service.engine import run_replication


def _storage_2sku(initial_a=100, initial_b=50, cap_a=200, cap_b=200, key="WH1"):
    return {
        "key": key, "archetype": "STORAGE",
        "params": {
            "capacity": 500,
            "stock": [
                {"material": "A", "initial": initial_a, "max": cap_a},
                {"material": "B", "initial": initial_b, "max": cap_b},
            ],
            "coverage_thresholds": {"red_h": 1.0, "yellow_low_h": 4.0, "yellow_high_h": 12.0},
        },
    }


def test_tr23_every_entry_has_7_fields():
    req = make_request(
        [_storage_2sku(),
         {"key": "OUT", "archetype": "SINK", "params": {"buffer": 1}}],
        [{"key": "WH>OUT", "src": "WH1", "dst": "OUT", "material": "A"}],
        horizon_s=7200, sample_s=3600, warmup_s=0, seed=42,
    )
    rep = run_replication(req)
    log = export_warehouse_series(rep, req.nodes)
    assert len(log) > 0
    for entry in log:
        assert set(entry.keys()) == {"ts_s", "sku", "node_key", "level", "capacity", "coverage_h", "color"}
        for k in ("ts_s", "level", "capacity", "coverage_h"):
            assert isinstance(entry[k], (int, float))
        assert isinstance(entry["sku"], str) and entry["sku"] != ""
        assert isinstance(entry["node_key"], str) and entry["node_key"] != ""
        assert entry["color"] in {"GREEN", "YELLOW", "RED"}


def test_tr22_time_bounds_warmup_zero():
    horizon = 604800.0
    step = 3600.0
    req = make_request(
        [_storage_2sku(),
         {"key": "OUT", "archetype": "SINK", "params": {
             "buffer": 1,
             "demand": [{"kind": "TAKT", "material": "A", "takt": {"dist": "const", "value": 7200}}],
         }}],
        [{"key": "WH>OUT", "src": "WH1", "dst": "OUT", "material": "A"}],
        horizon_s=horizon, sample_s=step, warmup_s=0, seed=42,
    )
    rep = run_replication(req)
    log = export_warehouse_series(rep, req.nodes)
    tss = [e["ts_s"] for e in log]
    assert min(tss) == 0.0
    assert max(tss) <= horizon


def test_tr21_count_match_formula():
    n_storages = 1
    n_sku = 2
    horizon = 604800.0
    step = 3600.0
    expected_per_series = horizon / step
    req = make_request(
        [_storage_2sku(),
         {"key": "OUT", "archetype": "SINK", "params": {
             "buffer": 1,
             "demand": [{"kind": "TAKT", "material": "A", "takt": {"dist": "const", "value": 10_000}}],
         }}],
        [{"key": "WH>OUT", "src": "WH1", "dst": "OUT", "material": "A"}],
        horizon_s=horizon, sample_s=step, warmup_s=0, seed=42, replications=1,
    )
    rep = run_replication(req)
    log = export_warehouse_series(rep, req.nodes)
    expected_total = n_storages * n_sku * expected_per_series
    ratio = len(log) / expected_total
    assert 0.99 <= ratio <= 1.01, f"got {len(log)}, expected ~{expected_total}, ratio {ratio:.3f}"


def test_capacity_maps_per_sku_max():
    req = make_request(
        [_storage_2sku(cap_a=123, cap_b=456, key="WHX"),
         {"key": "OUT", "archetype": "SINK", "params": {"buffer": 1}}],
        [{"key": "W>OUT", "src": "WHX", "dst": "OUT", "material": "A"}],
        horizon_s=1200, sample_s=600, warmup_s=0, seed=42,
    )
    rep = run_replication(req)
    log = export_warehouse_series(rep, req.nodes)
    caps = {(e["node_key"], e["sku"]): e["capacity"] for e in log}
    assert caps[("WHX", "A")] == 123.0
    assert caps[("WHX", "B")] == 456.0
