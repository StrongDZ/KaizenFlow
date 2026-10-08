import time

import pytest
from feed_service.runner import PoolFull, Runner, RunnerPool


class Sink:
    def __init__(self):
        self.batches = []

    def __call__(self, messages):
        self.batches.append(messages)


def wait_for(cond, timeout=3.0):
    end = time.time() + timeout
    while time.time() < end:
        if cond():
            return True
        time.sleep(0.02)
    return False


@pytest.fixture
def pool():
    sinks = {}

    def make(model):
        sinks[model] = Sink()
        return Runner(sinks[model], tick_s=0.02)

    p = RunnerPool(make, max_runners=2)
    p.sinks = sinks
    yield p
    p.shutdown()


def bp_of(blueprint, model):
    bp = blueprint()
    bp["model"] = model
    return bp


def test_models_run_side_by_side_each_with_its_own_clock_and_sink(pool, blueprint):
    pool.start("a", bp_of(blueprint, "a"), speed=300.0)
    pool.start("b", bp_of(blueprint, "b"), speed=30.0)
    assert wait_for(lambda: len(pool.sinks["a"].batches) >= 3 and len(pool.sinks["b"].batches) >= 3)
    sa, sb = pool.status("a"), pool.status("b")
    assert (sa["state"], sa["model"], sa["speed"]) == ("running", "a", 300.0)
    assert (sb["state"], sb["model"], sb["speed"]) == ("running", "b", 30.0)
    assert sa["virtual_now"] != sb["virtual_now"]
    assert {s["model"] for s in pool.statuses()} == {"a", "b"}


def test_pausing_or_stopping_one_model_leaves_the_other_running(pool, blueprint):
    pool.start("a", bp_of(blueprint, "a"), speed=300.0)
    pool.start("b", bp_of(blueprint, "b"), speed=300.0)
    assert wait_for(lambda: len(pool.sinks["b"].batches) >= 2)
    pool.pause("a")
    assert pool.status("a")["state"] == "paused" and pool.status("b")["state"] == "running"
    n = len(pool.sinks["b"].batches)
    assert wait_for(lambda: len(pool.sinks["b"].batches) > n)
    pool.stop("a")
    assert pool.status("a")["state"] == "idle"
    n = len(pool.sinks["b"].batches)
    assert wait_for(lambda: len(pool.sinks["b"].batches) > n), "B phải chạy tiếp sau khi dừng A"
    assert [s["model"] for s in pool.statuses()] == ["b"]


def test_speed_is_per_model(pool, blueprint):
    pool.start("a", bp_of(blueprint, "a"), speed=10.0)
    pool.start("b", bp_of(blueprint, "b"), speed=10.0)
    pool.set_speed("a", 120.0)
    assert pool.status("a")["speed"] == 120.0 and pool.status("b")["speed"] == 10.0


def test_status_of_a_model_that_never_started_is_idle(pool):
    st = pool.status("nobody")
    assert st["state"] == "idle" and st["model"] == "nobody" and st["incidents"] == []
    pool.pause("nobody")
    pool.resume("nobody")
    pool.stop("nobody")  # không có gì để dừng thì không phải lỗi
    assert pool.statuses() == []


def test_limit_on_concurrent_models_but_restarting_one_is_always_allowed(pool, blueprint):
    pool.start("a", bp_of(blueprint, "a"))
    pool.start("b", bp_of(blueprint, "b"))
    with pytest.raises(PoolFull):
        pool.start("c", bp_of(blueprint, "c"))
    pool.start("a", bp_of(blueprint, "a"), speed=60.0)  # chạy lại mô hình đang chạy: không tốn thêm chỗ
    assert pool.status("a")["speed"] == 60.0
    pool.stop("b")
    pool.start("c", bp_of(blueprint, "c"))  # dừng bớt thì có chỗ
    assert {s["model"] for s in pool.statuses()} == {"a", "c"}


def test_failed_start_of_a_new_model_does_not_take_a_slot(pool, blueprint):
    bad = bp_of(blueprint, "bad")
    bad["run_request"] = {}
    with pytest.raises(Exception):
        pool.start("bad", bad)
    assert pool.statuses() == []
    pool.start("a", bp_of(blueprint, "a"))
    pool.start("b", bp_of(blueprint, "b"))  # nếu mô hình hỏng còn giữ chỗ thì dòng này nổ PoolFull


def test_incidents_belong_to_their_own_model(pool, blueprint):
    pool.start("a", bp_of(blueprint, "a"))
    pool.start("b", bp_of(blueprint, "b"))
    inc = pool.add_incident("a", "machine_down", "STAMP_1", 900)
    assert [i["id"] for i in pool.list_incidents("a")] == [inc["id"]]
    assert pool.list_incidents("b") == []
    assert pool.status("a")["incidents"] and pool.status("b")["incidents"] == []
    assert pool.clear_incident("b", inc["id"]) is False  # id của A không xoá được từ B
    assert pool.clear_incident("a", inc["id"]) is True


def test_incident_on_a_model_that_is_not_running_is_refused(pool):
    with pytest.raises(RuntimeError, match="chưa chạy"):
        pool.add_incident("a", "machine_down", "STAMP_1", 900)
    assert pool.list_incidents("a") == []
