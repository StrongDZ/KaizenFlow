from helpers import SIM_START, at
from sim_service.recorder import Recorder


def test_ts_and_recording_window():
    r = Recorder(SIM_START, record_from=100.0, keep_raw=True)
    assert r.ts(160) == at(60)
    r.signal(50, "M", "vibration", 1.0)
    r.signal(150, "M", "vibration", 2.0)
    assert r.signals == [(at(50), "M", "vibration", 2.0)]


def test_no_raw_but_series_kept():
    r = Recorder(SIM_START, record_from=0.0, keep_raw=False)
    r.sample(10, "S", "level:X", 5)
    assert r.signals == []
    assert r.series[("S", "level:X")] == [(10.0, 5.0)]


def test_state_intervals_clipped_and_finalized():
    r = Recorder(SIM_START, record_from=100.0, keep_raw=True)
    r.state(0, "M", "IDLE")
    r.state(150, "M", "RUNNING")
    r.state(150, "M", "RUNNING")  # không đổi → bỏ qua
    r.finalize(400)
    assert r.intervals["M"] == [("IDLE", 0.0, 50.0), ("RUNNING", 50.0, 300.0)]
    assert [e[3]["state"] for e in r.events if e[2] == "STATE"] == ["RUNNING"]


def test_state_custom_event_type():
    r = Recorder(SIM_START, record_from=0.0, keep_raw=True)
    r.state(5, "S", "RED", etype="COLOR_CHANGE")
    assert r.events == [(at(5), "S", "COLOR_CHANGE", {"state": "RED"})]


def test_tally():
    r = Recorder(SIM_START, record_from=10.0, keep_raw=True)
    r.tally(5, "e", "WAIT_HOOK", 30)
    r.tally(20, "e", "WAIT_HOOK", 40)
    assert r.tallies[("e", "WAIT_HOOK")] == [40.0]
    assert r.events[-1] == (at(10), "e", "WAIT_HOOK", {"duration_s": 40.0})
