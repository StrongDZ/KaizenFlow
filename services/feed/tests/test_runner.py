import time

import pytest
from feed_service.runner import Runner


class Sink:
    def __init__(self):
        self.batches = []
        self.fail = False

    def __call__(self, messages):
        if self.fail:
            raise ConnectionError("api down")
        self.batches.append(messages)


def wait_for(cond, timeout=3.0):
    end = time.time() + timeout
    while time.time() < end:
        if cond():
            return True
        time.sleep(0.02)
    return False


@pytest.fixture
def runner():
    sink = Sink()
    r = Runner(sink, tick_s=0.02)
    r.sink = sink
    yield r
    r.shutdown()


def test_idle_until_started(runner):
    st = runner.status()
    assert st["state"] == "idle" and st["model"] is None
    time.sleep(0.1)
    assert runner.sink.batches == []


def test_start_streams_batches_and_advances_virtual_time(runner, blueprint):
    runner.start(blueprint(), speed=300.0)
    assert runner.status()["state"] == "running"
    assert wait_for(lambda: len(runner.sink.batches) >= 5)
    t1 = runner.status()["virtual_now"]
    assert wait_for(lambda: runner.status()["virtual_now"] > t1)
    assert runner.status()["model"] == "denso-mini" and runner.status()["sent"] > 0


def test_pause_stops_the_stream_and_resume_continues_without_time_jump(runner, blueprint):
    runner.start(blueprint(), speed=300.0)
    assert wait_for(lambda: len(runner.sink.batches) >= 3)
    runner.pause()
    time.sleep(0.1)
    n = len(runner.sink.batches)
    t_paused = runner.status()["virtual_now"]
    time.sleep(0.2)
    assert len(runner.sink.batches) == n
    runner.resume()
    assert wait_for(lambda: len(runner.sink.batches) > n)
    from datetime import datetime
    gap = (datetime.fromisoformat(runner.status()["virtual_now"]) - datetime.fromisoformat(t_paused)).total_seconds()
    assert gap < 300 * 1.5, "nghỉ 0,3 giây thực không được làm giờ ảo nhảy"


def test_speed_is_clamped_and_reported(runner, blueprint):
    runner.start(blueprint(), speed=10.0)
    runner.set_speed(50)
    assert runner.status()["speed"] == 50
    runner.set_speed(10_000)
    assert runner.status()["speed"] == 2000
    runner.set_speed(0)
    assert runner.status()["speed"] == 0.1


def test_sink_failures_are_counted_not_fatal(runner, blueprint):
    runner.sink.fail = True
    runner.start(blueprint(), speed=100.0)
    assert wait_for(lambda: runner.status()["send_errors"] >= 2)
    assert "api down" in runner.status()["last_error"]
    runner.sink.fail = False
    n = len(runner.sink.batches)
    assert wait_for(lambda: len(runner.sink.batches) > n)
    assert runner.status()["state"] == "running"
    assert runner.status()["last_error"] is None, "hết lỗi thì không được hiện lỗi cũ"
    assert runner.status()["send_errors"] >= 2


def test_incidents_go_through_the_runner_and_stop_resets(runner, blueprint):
    runner.start(blueprint(), speed=100.0)
    inc = runner.add_incident("machine_down", "STAMP_3", duration_s=600)
    assert inc["active"] and runner.list_incidents()[0]["id"] == inc["id"]
    assert runner.clear_incident(inc["id"]) is True
    runner.stop()
    st = runner.status()
    assert st["state"] == "idle" and st["model"] is None
    with pytest.raises(RuntimeError, match="chưa chạy"):
        runner.add_incident("machine_down", "STAMP_3")


def test_starting_again_replaces_the_world(runner, blueprint):
    runner.start(blueprint(), speed=100.0)
    runner.add_incident("machine_down", "STAMP_1", duration_s=6000)
    runner.start(blueprint(), speed=100.0)
    assert runner.list_incidents() == []
