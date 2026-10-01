from helpers import load_request
from sim_service.contract import validate_refs
from sim_service.engine import run_replication
from sim_service.montecarlo import aggregate_kpis, bands, run_many


def test_fixture_is_valid():
    validate_refs(load_request("denso_mini"))


def test_same_rep_is_deterministic_and_reps_differ():
    req = load_request("denso_mini", horizon_s=3600)
    a, b, c = run_replication(req, 0), run_replication(req, 0), run_replication(req, 1)
    assert a.kpis == b.kpis
    assert a.kpis != c.kpis


def test_aggregate_and_bands_shape():
    req = load_request("denso_mini", horizon_s=3600, replications=3)
    reps = run_many(req)
    agg = aggregate_kpis(reps)
    assert agg["throughput"]["p10"] <= agg["throughput"]["p50"] <= agg["throughput"]["p90"]
    assert 0.0 <= agg["storages"]["FG"]["red_probability"] <= 1.0
    assert set(agg["pools"]) == {"TUGGER_A", "OPS_ZONE_B"}
    assert agg["backorder"]["p50"] == agg["backorder_end"]["p50"]
    assert 0.0 <= agg["service_level"]["p50"] <= 1.0
    process = agg["processes"]["STAMP_1"]
    for name in ("nominal_rate", "effective_throughput", "utilization", "running_s", "blocked_s",
                 "starved_s", "down_s", "idle_s", "blocked_ratio", "starved_ratio", "down_ratio",
                 "count_in", "count_ok", "count_ng", "input_wip_peak", "output_wip_peak",
                 "input_wip_end", "output_wip_end", "wip_growth"):
        assert set(process[name]) == {"p10", "p50", "p90", "mean"}
    rows = bands(req, reps)
    fg = [r for r in rows if r["subject"] == "FG" and r["metric"] == "coverage_h"]
    assert len(fg) == 60
    assert all(r["p10"] <= r["p50"] <= r["p90"] for r in rows)
    assert fg[0]["producer"] == "SIM" and fg[0]["ref_id"] == req.run_id


def test_parallel_equals_sequential():
    req = load_request("denso_mini", horizon_s=1800, replications=2)
    seq = [r.kpis for r in run_many(req, workers=1)]
    par = [r.kpis for r in run_many(req, workers=2)]
    assert seq == par


def test_raw_reps_beyond_replications_ignored():
    req = load_request("denso_mini", horizon_s=1800, replications=2,
                       outputs={"raw_reps": [0, 5], "sample_s": 60})
    reps = run_many(req)
    assert len(reps) == 2 and reps[1].signals == []
