from datetime import datetime, timedelta, timezone

import pytest
from feed_service.scale import Truth
from feed_service.world import World

BASE = datetime(2026, 10, 1, 8, 0, tzinfo=timezone(timedelta(hours=7)))


def stamp_ok(world):
    return sum(world.ctx.nodes[k].counts["count_ok"] for k in ("STAMP_1", "STAMP_2", "STAMP_3"))


def test_world_is_warm_at_go_live_and_virtual_clock_starts_at_base(blueprint):
    w = World(blueprint(), base=BASE)
    assert w.virtual_now() == BASE
    assert w.ctx.env.now == pytest.approx(3600.0)     # đã chạy ấm 1 giờ, chưa phát gì
    assert w.ctx.nodes["KHO_NVL"].boxes["RAW-01"].level > 0


def test_step_advances_virtual_time_and_production(blueprint):
    w = World(blueprint(), base=BASE)
    before = stamp_ok(w)
    w.step(1800)
    assert w.virtual_now() == BASE + timedelta(seconds=1800)
    assert stamp_ok(w) > before


def test_scripted_injections_of_the_blueprint_are_dropped(blueprint):
    bp = blueprint()
    assert bp["run_request"]["injections"], "fixture phải có injection để test này có nghĩa"
    w = World(bp, base=BASE)
    assert w.req.injections == []


def test_hidden_truth_makes_machines_slower(blueprint):
    nominal = World(blueprint(), truth=Truth(cycle_factor=1.0, demand_factor=1.0), base=BASE, seed=3)
    slow = World(blueprint(), truth=Truth(cycle_factor=1.6, demand_factor=1.0), base=BASE, seed=3)
    for w in (nominal, slow):
        w.step(4 * 3600)
    assert stamp_ok(slow) < stamp_ok(nominal)


def test_machine_down_incident_stops_the_machine_then_recovers(blueprint):
    w = World(blueprint(), base=BASE)
    inc = w.add_incident("machine_down", "STAMP_2", duration_s=1200)
    assert inc["kind"] == "machine_down" and inc["active"]
    assert not w.ctx.nodes["STAMP_2"].health.is_up
    w.step(600)
    assert not w.ctx.nodes["STAMP_2"].health.is_up
    assert any(i["id"] == inc["id"] and i["active"] for i in w.list_incidents())
    w.step(700)
    assert w.ctx.nodes["STAMP_2"].health.is_up
    assert not any(i["active"] for i in w.list_incidents())


def test_clear_incident_restores_immediately(blueprint):
    w = World(blueprint(), base=BASE)
    inc = w.add_incident("machine_down", "STAMP_1", duration_s=10_000)
    assert w.clear_incident(inc["id"]) is True
    assert w.ctx.nodes["STAMP_1"].health.is_up
    assert w.clear_incident(inc["id"]) is False
    assert w.clear_incident(9999) is False


def test_stock_drain_removes_a_fraction_of_the_stock(blueprint):
    w = World(blueprint(), base=BASE)
    box = w.ctx.nodes["KHO_NVL"].boxes["RAW-01"]
    before = box.level
    w.add_incident("stock_drain", "KHO_NVL", material="RAW-01", fraction=0.5)
    w.step(1)
    assert box.level <= before * 0.5 + 25   # nguồn có thể nạp thêm một lô trong 1 giây


def test_lane_block_slows_the_fleet(blueprint):
    free = World(blueprint(), base=BASE, seed=5)
    jam = World(blueprint(), base=BASE, seed=5)
    for lane in ("L01", "L02", "L03"):   # chặn hành lang trên: xe không tới được STAMP_2, STAMP_3 (trừ khi chen)
        jam.add_incident("lane_block", lane, duration_s=3 * 3600)
    for w in (free, jam):
        w.step(2 * 3600)
    done = lambda w: sum(e.moved for e in w.ctx.edges if e.key.startswith("KHO_NVL>"))  # noqa: E731
    assert done(jam) < done(free)


def test_invalid_incidents_are_rejected_with_a_reason(blueprint):
    w = World(blueprint(), base=BASE)
    for args, kw in [(("machine_down", "NOPE"), {}), (("machine_down", "KHO_NVL"), {}), (("lane_block", "L99"), {}),
                     (("stock_drain", "STAMP_1"), {"material": "RAW-01"}), (("stock_drain", "KHO_NVL"), {"material": "ZZZ"}),
                     (("explode", "X"), {})]:
        with pytest.raises(ValueError):
            w.add_incident(*args, **kw)
    no_map = World(blueprint(with_map=False), base=BASE)
    with pytest.raises(ValueError, match="bản đồ"):
        no_map.add_incident("lane_block", "L01")


def test_world_without_map_uses_nominal_travel(blueprint):
    w = World(blueprint(with_map=False), base=BASE)
    assert w.fleet is None
    w.step(1800)
    assert sum(e.moved for e in w.ctx.edges) > 0
