import pytest

from helpers import at, make_request
from sim_service.engine import run_replication

FM = {"code": "bearing", "p_to_f": {"dist": "const", "value": 1000},
      "effects": [{"signal": "vibration", "kind": "ramp", "delta": 5.0}],
      "on_fail": {"state": "DOWN", "mttr": {"dist": "const", "value": 500}}}
SIG = [{"name": "vibration", "base": {"dist": "const", "value": 1.0}, "hz": 0.1}]


def model(injections, raw_reps=(0,), horizon_s=5000):
    return make_request(
        [{"key": "SRC", "archetype": "SOURCE",
          "params": {"arrivals": {"interarrival": 1}, "lots": [{"material": "X", "qty": 1}]}},
         {"key": "M", "archetype": "PROCESS", "params": {
             "recipes": [{"inputs": [{"material": "X", "qty": 1}], "outputs": [{"material": "Y", "qty": 1}]}],
             "cycle": 1, "failure_modes": [FM], "signals": SIG}},
         {"key": "OUT", "archetype": "SINK", "params": {}}],
        [{"key": "SRC>M", "src": "SRC", "dst": "M", "material": "X"},
         {"key": "M>OUT", "src": "M", "dst": "OUT", "material": "Y"}],
        horizon_s=horizon_s, sample_s=100, raw_reps=raw_reps, injections=injections)


def events_of(res, *types):
    return [(t, typ) for t, s, typ, _ in res.events if s == "M" and typ in types]


def test_injected_failure_follows_pf_curve():
    res = run_replication(model([{"target": "M", "failure": "bearing", "at_s": 3000}]))
    assert events_of(res, "FAULT_ONSET", "FAILURE", "REPAIRED") == [
        (at(2000), "FAULT_ONSET"), (at(3000), "FAILURE"), (at(3500), "REPAIRED")]
    assert res.kpis["processes"]["M"]["state_s"]["DOWN"] == pytest.approx(500)


def test_labels_and_sensor_values():
    res = run_replication(model([{"target": "M", "failure": "bearing", "at_s": 3000}]))
    label = dict(res.series[("M", "label_fault")])
    rul = dict(res.series[("M", "rul_s")])
    assert label[1900.0] == 0.0 and label[2100.0] == 1.0 and label[3200.0] == 1.0 and label[3600.0] == 0.0
    assert rul[2500.0] == pytest.approx(500)
    vib = {t: v for t, s, n, v in res.signals if s == "M" and n == "vibration"}
    assert vib[at(1000)] == pytest.approx(1.0)
    assert vib[at(2500)] == pytest.approx(3.5)


def test_planned_stop_prevents_failure():
    res = run_replication(model([
        {"target": "M", "failure": "bearing", "at_s": 3000},
        {"target": "M", "kind": "planned_stop", "at_s": 1500, "duration_s": 200}]))
    assert events_of(res, "FAILURE") == []
    assert res.kpis["processes"]["M"]["state_s"]["DOWN"] == pytest.approx(200)
    assert events_of(res, "PLANNED_STOP", "PLANNED_STOP_END") == [
        (at(1500), "PLANNED_STOP"), (at(1700), "PLANNED_STOP_END")]
    start_payload = next(payload for _, subject, typ, payload in res.events
                         if subject == "M" and typ == "PLANNED_STOP")
    assert start_payload["ends_at"] == at(1700).isoformat()


def test_injection_beyond_horizon_is_harmless():
    res = run_replication(model([{"target": "M", "failure": "bearing", "at_s": 99999}]))
    assert events_of(res, "FAILURE") == []
    assert "DOWN" not in res.kpis["processes"]["M"]["state_s"]


def test_non_raw_rep_keeps_labels_but_no_signals():
    res = run_replication(model([{"target": "M", "failure": "bearing", "at_s": 3000}], raw_reps=()))
    assert res.signals == [] and res.events == []
    assert ("M", "label_fault") in res.series
