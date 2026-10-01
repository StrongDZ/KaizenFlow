import pytest

from helpers import SIM_START, load_request, make_request
from sim_service import recommend as rec_mod
from sim_service.dists import mean_of
from sim_service.montecarlo import run_many
from sim_service.nodes.process import process_material_rate
from sim_service.recommend import candidate_request, generate, rank, recommend, upstream

RED_FG = {"kind": "RED_RISK", "subject_key": "FG", "eta": SIM_START, "probability": 0.6,
          "severity": 3, "payload": {}}


def test_upstream_reaches_tugger_edges():
    nodes, edges = upstream(load_request("denso_mini"), "FG")
    assert {"STAMP_3", "KHO_NVL"} <= nodes
    assert "KHO_NVL>STAMP_3" in {e.key for e in edges}


def test_generate_catalog_for_red_fg():
    req = load_request("denso_mini")
    acts = [(c.action["type"], c.action["target"]) for c in generate(req, [RED_FG])]
    assert ("REALLOCATE_OPERATOR", "OPS_ZONE_B") in acts
    assert ("FLEET_SIZE", "TUGGER_A") in acts
    stops = [c for c in generate(req, [RED_FG]) if c.action["type"] == "PLANNED_STOP"]
    assert sorted(c.action["at_s"] for c in stops) == [0.0, 1800.0]
    assert len(acts) == len(set(acts)) + 1  # hai PLANNED_STOP cùng target, còn lại không trùng


def test_pool_bottleneck_generates_pool_action():
    req = load_request("denso_mini")
    ins = {"kind": "BOTTLENECK", "subject_key": "OPS_ZONE_B", "eta": None, "probability": 1.0,
           "severity": 2, "payload": {}}
    assert [c.action["type"] for c in generate(req, [ins])] == ["REALLOCATE_OPERATOR"]


def test_candidate_request_applies_changes():
    req = load_request("denso_mini", replications=50)
    c = next(c for c in generate(req, [RED_FG]) if c.action["type"] == "REALLOCATE_OPERATOR")
    r = candidate_request(req, c)
    assert next(p for p in r.pools if p.key == "OPS_ZONE_B").count == 2
    assert r.replications == 20 and r.recommend is False and r.outputs.raw_reps == []
    stop = next(c for c in generate(req, [RED_FG]) if c.action["type"] == "PLANNED_STOP")
    assert any(i.kind == "planned_stop" for i in candidate_request(req, stop).injections)


def test_rank_sorted_and_recommend_shape():
    req = load_request("denso_mini", horizon_s=3600, replications=2)
    base = run_many(req)
    ranked = rank(req, base, generate(req, [RED_FG]))
    scores = [r["score_v2"] for r in ranked]
    assert scores == sorted(scores, reverse=True)
    assert [r["rank"] for r in ranked] == list(range(1, len(ranked) + 1))
    out = recommend(req, base, [RED_FG])
    if ranked:
        assert out["kind"] == "RECOMMENDATION" and out["subject_key"] == "FG"
        assert len(out["payload"]["candidates"]) == len(ranked)
        assert out["payload"]["source_kind"] == "RED_RISK"
        candidate = out["payload"]["candidates"][0]
        assert candidate["reason"] and candidate["expected_impact"]["baseline"]
    else:
        assert out is None
    assert recommend(req, base, []) is None


def test_machine_bottleneck_candidates_are_valid_and_can_rerun():
    req = load_request("denso_mini", horizon_s=1800, replications=1)
    evidence = {"nominal_rate": 70.0, "utilization": 0.97, "upstream_wip_growth": 10.0, "capacity_gap": 30.0}
    insight = {"kind": "BOTTLENECK", "subject_key": "STAMP_1", "eta": None, "probability": 0.9,
               "severity": 2, "payload": {"evidence": evidence}}
    candidates = generate(req, [insight])
    assert all(c.action["type"] != "REDUCE_MACHINE_RATE" for c in candidates)  # upstream là STORAGE, không giảm nhầm STAMP_1
    capacity = [c for c in candidates if c.action["type"] == "INCREASE_PROCESS_CAPACITY"]
    assert capacity and capacity[0].action["delta"] == 1
    rerun = run_many(candidate_request(req, capacity[0]))
    assert rerun[0].kpis["processes"]["STAMP_1"]["nominal_rate"] > 0
    ranked = rank(req, run_many(req), candidates)
    assert all(c["reason"] and "expected_impact" in c and "score_v2" in c for c in ranked)


def test_reduce_rate_targets_single_upstream_and_respects_recipe_quantity():
    def process(key, cycle, input_qty, output_qty):
        return {"key": key, "archetype": "PROCESS", "params": {
            "cycle": cycle, "recipes": [{"inputs": [{"material": "X", "qty": input_qty}],
                                           "outputs": [{"material": "X", "qty": output_qty}]}]}}

    nodes = [process("A", 36, 1, 2), process("B", 3600 / 70, 2, 1)]
    req = make_request(nodes, [{"key": "A>B", "src": "A", "dst": "B", "material": "X"}])
    insight = {"kind": "BOTTLENECK", "subject_key": "B", "payload": {
        "evidence": {"utilization": 1.0, "upstream_wip_growth": 10.0, "capacity_gap": 60.0}}}
    candidate = next(c for c in generate(req, [insight]) if c.action["type"] == "REDUCE_MACHINE_RATE")
    assert candidate.action["target"] == "A"
    assert candidate.action["from_rate"] == pytest.approx(200)
    assert candidate.action["to_rate"] == pytest.approx(147)  # B consumes 2 × 70/h, plus 5% guard.
    changed = candidate_request(req, candidate)
    upstream = next(n for n in changed.nodes if n.key == "A")
    assert process_material_rate(upstream.params, "X") == pytest.approx(147)

    extra = process("A2", 36, 1, 2)
    multi = make_request([*nodes, extra], [
        {"key": "A>B", "src": "A", "dst": "B", "material": "X"},
        {"key": "A2>B", "src": "A2", "dst": "B", "material": "X"},
    ])
    assert all(c.action["type"] != "REDUCE_MACHINE_RATE" for c in generate(multi, [insight]))


@pytest.mark.parametrize("cycle", [
    {"dist": "const", "value": 30},
    {"dist": "exp", "mean": 30},
    {"dist": "norm", "mean": 30, "sd": 4},
    {"dist": "lognorm", "mean": 30, "cv": 0.2},
    {"dist": "tri", "min": 20, "mode": 30, "max": 40},
    {"dist": "uniform", "min": 20, "max": 40},
    {"dist": "weibull", "shape": 2, "scale": 30},
])
def test_rate_override_scales_every_supported_cycle_distribution(cycle):
    scaled = rec_mod._scale_duration(cycle, 1.4)
    assert mean_of(scaled) == pytest.approx(mean_of(cycle) * 1.4)
