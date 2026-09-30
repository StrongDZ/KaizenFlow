from helpers import make_request
from sim_service.engine import run_replication


def base_nodes(dst_params=None, out_params=None):
    return [
        {"key": "SRC", "archetype": "SOURCE",
         "params": {"arrivals": {"interarrival": 10}, "lots": [{"material": "X", "qty": 20}]}},
        {"key": "A", "archetype": "STORAGE", "params": {}},
        {"key": "B", "archetype": "STORAGE", "params": dst_params or {}},
        {"key": "OUT", "archetype": "SINK", "params": out_params or {"buffer": 1000}},
    ]


def pool_edge(**kw):
    return {"key": "A>B", "src": "A", "dst": "B", "material": "X", "mode": "POOL", "pool": "TUG",
            "travel": {"dist": "const", "value": 10}, "lot": 20, **kw}


EDGES_IN = [{"key": "SRC>A", "src": "SRC", "dst": "A", "material": "X"}]
EDGE_OUT = [{"key": "B>OUT", "src": "B", "dst": "OUT", "material": "X"}]


def test_single_hook_operator_creates_wait():
    req = make_request(base_nodes(), [*EDGES_IN, pool_edge(hook_pool="OPS"), *EDGE_OUT],
                       [{"key": "TUG", "kind": "TUGGER", "count": 3},
                        {"key": "OPS", "kind": "OPERATOR", "count": 1, "service": {"dist": "const", "value": 100}}],
                       horizon_s=3600)
    k = run_replication(req).kpis
    assert k["edges"]["A>B"]["wait_hook_mean"] > 50
    assert k["pools"]["OPS"]["util"] > 0.9
    assert k["pools"]["TUG"]["util"] > 0


def test_fleet_size_limits_throughput():
    def thr(count):
        req = make_request(base_nodes(), [*EDGES_IN, pool_edge(lot=1, travel={"dist": "const", "value": 50}), *EDGE_OUT],
                           [{"key": "TUG", "kind": "TUGGER", "count": count}], horizon_s=3600)
        return run_replication(req).kpis["throughput"]
    assert thr(3) > 2.5 * thr(1)


def test_reorder_point_caps_destination_level():
    req = make_request(
        base_nodes(dst_params={"stock": [{"material": "X", "max": 100}],
                               "replenish": {"policy": "REORDER_POINT", "rop": 5, "qty": 10}},
                   out_params={"buffer": 1, "demand": [{"kind": "TAKT", "material": "X", "takt": 60}]}),
        [*EDGES_IN, pool_edge(), *EDGE_OUT],
        [{"key": "TUG", "kind": "TUGGER", "count": 2}], horizon_s=3600, sample_s=10)
    levels = [v for _, v in run_replication(req).series[("B", "level:X")]]
    assert max(levels) <= 15
    assert max(levels) >= 10


def test_edge_records_cumulative_units_moved():
    req = make_request(base_nodes(), [*EDGES_IN, pool_edge(lot=10), *EDGE_OUT],
                       [{"key": "TUG", "kind": "TUGGER", "count": 3}], horizon_s=3600, sample_s=60)
    values = [v for _, v in run_replication(req).series[("A>B", "moved")]]
    assert values == sorted(values)
    assert values[-1] > 0
    assert values[-1] % 10 == 0  # chỉ đếm theo lô đã giao tới nơi


def test_instant_edge_still_reports_flow_when_nothing_is_ever_in_transit():
    req = make_request(base_nodes(), [*EDGES_IN, pool_edge(lot=10), *EDGE_OUT],
                       [{"key": "TUG", "kind": "TUGGER", "count": 3}], horizon_s=3600, sample_s=60)
    series = run_replication(req).series
    assert max(v for _, v in series[("SRC>A", "in_transit")]) == 0
    assert series[("SRC>A", "moved")][-1][1] > 0


def test_moved_counts_only_the_recorded_window_not_the_warmup():
    req = make_request(base_nodes(), [*EDGES_IN, *EDGE_OUT], horizon_s=3600, warmup_s=1800, sample_s=60)
    total = run_replication(req).series[("SRC>A", "moved")][-1][1]
    assert 0 < total <= 7300  # nguồn cấp 20 đơn vị mỗi 10 giây = 7200 trong 3600 giây; tính cả warm-up sẽ ~10800
