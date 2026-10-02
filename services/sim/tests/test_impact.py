import pytest

from helpers import make_request
from sim_service.engine import RepResult, run_replication
from sim_service.impact import failure_impacts, mean_line_metrics
from sim_service.recommend import candidate_request, generate, rank


def serial_failure_request(with_stop=True, duration_s=1800):
    def process(key):
        return {"key": key, "archetype": "PROCESS", "params": {
            "cycle": 10, "in_buffer": 2, "out_buffer": 2,
            "recipes": [{"inputs": [{"material": "X", "qty": 1}],
                         "outputs": [{"material": "X", "qty": 1}]}]}}

    nodes = [{"key": "SRC", "archetype": "SOURCE", "params": {
        "arrivals": {"interarrival": 5}, "lots": [{"material": "X", "qty": 1}]}}]
    nodes += [process(k) for k in "ABCD"]
    nodes += [{"key": "OUT", "archetype": "SINK", "params": {}}]
    keys = ["SRC", "A", "B", "C", "D", "OUT"]
    edges = [{"key": f"{a}>{b}", "src": a, "dst": b, "material": "X"} for a, b in zip(keys, keys[1:])]
    injections = [{"target": "B", "kind": "planned_stop", "at_s": 900, "duration_s": duration_s}] if with_stop else []
    return make_request(nodes, edges, horizon_s=5400, sample_s=30, raw_reps=(), injections=injections)


def test_failure_impact_uses_observed_propagation_and_counterfactual():
    failed_req = serial_failure_request()
    failed = [run_replication(failed_req)]
    reference = [run_replication(serial_failure_request(with_stop=False))]
    impact = failure_impacts(failed_req, failed, reference)[0]
    assert impact["failed_machine"] == "B"
    assert impact["failure_at"] == 900
    assert impact["downtime_s"] == pytest.approx(1800)
    assert impact["upstream_blocked_s"] > 0
    assert impact["downstream_starved_s"] > 0
    assert impact["upstream_blocked_s"] == impact["additional_upstream_blocked_s"]
    assert impact["downstream_starved_s"] == impact["additional_downstream_starved_s"]
    assert impact["caused_upstream_blocked_s"] == pytest.approx(
        impact["failed_upstream_blocked_s"] - impact["reference_upstream_blocked_s"])
    assert impact["caused_downstream_starved_s"] == pytest.approx(
        impact["failed_downstream_starved_s"] - impact["reference_downstream_starved_s"])
    assert impact["time_to_first_upstream_block"] >= 0
    assert impact["time_to_first_downstream_starve"] >= 0
    assert impact["throughput_loss"] > 0
    assert impact["throughput_loss_pct"] > 0
    assert impact["lost_output"] == impact["throughput_loss"]
    assert "WIP_peak_delta" in impact

    candidates = generate(failed_req, [], [impact])
    kinds = {c.action["type"] for c in candidates}
    assert kinds == {"STOP_MACHINE"}
    for candidate in candidates:
        rerun = run_replication(candidate_request(failed_req, candidate))
        assert rerun.kpis["processes"][candidate.action["target"]]["nominal_rate"] > 0
    ranked = rank(failed_req, failed, candidates)
    assert ranked
    assert all(c["action"]["type"] != "REDUCE_MACHINE_RATE" for c in ranked)
    assert all(c["action"]["type"] in kinds for c in ranked)

    no_block = {**impact, "additional_upstream_blocked_s": 0}
    assert generate(failed_req, [], [no_block]) == []


def test_failure_impact_zero_reference_throughput_and_no_observed_recovery():
    failed_req = serial_failure_request(duration_s=5000)
    failed = [run_replication(failed_req)]
    reference = [run_replication(serial_failure_request(with_stop=False))]
    failed[0].kpis["throughput"] = reference[0].kpis["throughput"] = 0
    impact = failure_impacts(failed_req, failed, reference)[0]
    assert impact["throughput_loss_pct"] is None
    assert "recovery_time" not in impact


def test_line_wip_peak_uses_simultaneous_samples_not_sum_of_per_process_peaks():
    kpis = {"throughput": 1, "red_minutes": 0, "backorder": 0, "processes": {
        "A": {"blocked_s": 0, "starved_s": 0, "input_wip_end": 0, "output_wip_end": 0},
        "B": {"blocked_s": 0, "starved_s": 0, "input_wip_end": 0, "output_wip_end": 0},
    }}
    series = {("A", "out:X"): [(0, 10), (60, 0)], ("B", "in:X"): [(0, 0), (60, 10)]}
    rep = RepResult(0, kpis, series, {}, {}, [], [])
    assert mean_line_metrics([rep])["wip_peak"] == 10


def test_failure_impact_subtracts_reference_state_after_failure_only():
    req = serial_failure_request()

    def result(intervals, throughput):
        processes = {key: {"down_s": 1800 if key == "B" else 0, "blocked_s": 0, "starved_s": 0,
                           "input_wip_end": 0, "output_wip_end": 0} for key in "ABCD"}
        kpis = {"throughput": throughput, "red_minutes": 0, "backorder": 0, "processes": processes}
        series = {("A", "out:X"): [(0, 0), (5400, 0)]}
        return RepResult(0, kpis, series, intervals, {}, [], [])

    failed = result({
        "A": [("BLOCKED", 100, 200), ("BLOCKED", 1000, 1200)],
        "C": [("STARVED", 100, 200), ("STARVED", 1000, 1300)],
    }, 90)
    reference = result({
        "A": [("BLOCKED", 100, 200), ("BLOCKED", 1000, 1100)],
        "C": [("STARVED", 100, 200), ("STARVED", 1000, 1250)],
    }, 100)
    impact = failure_impacts(req, [failed], [reference])[0]
    assert impact["failed_upstream_blocked_s"] == 200
    assert impact["reference_upstream_blocked_s"] == 100
    assert impact["caused_upstream_blocked_s"] == 100
    assert impact["failed_downstream_starved_s"] == 300
    assert impact["reference_downstream_starved_s"] == 250
    assert impact["caused_downstream_starved_s"] == 50
    assert impact["time_to_first_upstream_block"] == 100
    assert impact["time_to_first_downstream_starve"] == 100
