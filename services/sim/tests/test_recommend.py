from helpers import SIM_START, load_request
from sim_service.montecarlo import run_many
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
    scores = [r["score"] for r in ranked]
    assert scores == sorted(scores, reverse=True)
    assert [r["rank"] for r in ranked] == list(range(1, len(ranked) + 1))
    out = recommend(req, base, [RED_FG])
    if ranked:
        assert out["kind"] == "RECOMMENDATION" and out["subject_key"] == "FG"
        assert len(out["payload"]["candidates"]) == len(ranked)
    else:
        assert out is None
    assert recommend(req, base, []) is None
