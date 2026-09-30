import copy

from feed_service.scale import Truth, apply_truth, scale_dist


def test_scale_dist_by_kind():
    assert scale_dist(None, 2) is None
    assert scale_dist(30, 2) == 60
    assert scale_dist({"dist": "const", "value": 10}, 1.5) == {"dist": "const", "value": 15}
    norm = scale_dist({"dist": "norm", "mean": 90, "sd": 15}, 1.1)
    assert norm["dist"] == "norm" and abs(norm["mean"] - 99) < 1e-9 and abs(norm["sd"] - 16.5) < 1e-9
    assert scale_dist({"dist": "exp", "mean": 100}, 2) == {"dist": "exp", "mean": 200}
    assert scale_dist({"dist": "lognorm", "mean": 100, "cv": 0.3}, 2) == {"dist": "lognorm", "mean": 200, "cv": 0.3}
    assert scale_dist({"dist": "tri", "min": 1, "mode": 2, "max": 4}, 2) == {"dist": "tri", "min": 2, "mode": 4, "max": 8}
    assert scale_dist({"dist": "uniform", "min": 1, "max": 3}, 2) == {"dist": "uniform", "min": 2, "max": 6}
    assert scale_dist({"dist": "weibull", "shape": 2, "scale": 10}, 3) == {"dist": "weibull", "shape": 2, "scale": 30}


def test_scale_dist_understands_seconds_suffix_and_does_not_mutate():
    src = {"dist": "norm", "mean_s": 60, "sd_s": 10}
    before = copy.deepcopy(src)
    out = scale_dist(src, 2)
    assert out == {"dist": "norm", "mean_s": 120, "sd_s": 20}
    assert src == before


def _req():
    return {
        "nodes": [
            {"key": "P", "archetype": "PROCESS", "params": {"cycle": {"dist": "norm", "mean": 60, "sd": 6}, "slots": 1}},
            {"key": "S", "archetype": "STORAGE", "params": {"stock": [{"material": "X", "initial": 5}]}},
            {"key": "OUT", "archetype": "SINK", "params": {"demand": [
                {"kind": "TAKT", "material": "X", "takt": {"dist": "exp", "mean": 100}},
                {"kind": "FORECAST", "material": "Y", "hourly_rate": [10, 20]}]}},
        ],
        "edges": [], "pools": [],
    }


def test_apply_truth_slows_machines_and_raises_demand_without_touching_input():
    req = _req()
    before = copy.deepcopy(req)
    out = apply_truth(req, Truth(cycle_factor=1.10, demand_factor=1.25))
    assert req == before
    cyc = out["nodes"][0]["params"]["cycle"]
    assert abs(cyc["mean"] - 66) < 1e-9 and abs(cyc["sd"] - 6.6) < 1e-9
    assert out["nodes"][1] == before["nodes"][1]
    takt = out["nodes"][2]["params"]["demand"][0]["takt"]
    assert abs(takt["mean"] - 80) < 1e-9  # nhu cầu ×1,25 → giãn cách ngắn lại còn 1/1,25
    assert out["nodes"][2]["params"]["demand"][1]["hourly_rate"] == [12.5, 25.0]


def test_truth_defaults_are_the_hidden_bias_from_the_spec():
    t = Truth()
    assert t.cycle_factor == 1.10 and t.demand_factor == 1.08
