"""Xe chạy trên bản đồ: thời gian chuyến theo bản đồ, kẹt xe, chặn làn đổi đường, chờ khi hết đường, chen sau khi kẹt lâu."""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parents[2] / "sim" / "tests"))

import pytest  # noqa: E402
from feed_service.agv import Fleet  # noqa: E402
from feed_service.mapgraph import MapGraph  # noqa: E402
from helpers import make_request  # noqa: E402
from sim_service.engine import build  # noqa: E402

LOOP = {
    "unit_m": 1, "speed_mps": 2.0,
    "points": [
        {"id": "PA", "x": 0, "y": 0, "kind": "station", "node_key": "A"},
        {"id": "PB", "x": 100, "y": 0, "kind": "station", "node_key": "B"},
    ],
    "lanes": [
        {"id": "AB", "from": "PA", "to": "PB", "capacity": 1},
        {"id": "BA", "from": "PB", "to": "PA", "capacity": 1},
    ],
}

# hai đường A→B: ngắn qua S (60 m), dài qua T (200 m)
DETOUR = {
    "unit_m": 1, "speed_mps": 2.0,
    "points": [
        {"id": "PA", "x": 0, "y": 0, "kind": "station", "node_key": "A"},
        {"id": "PB", "x": 60, "y": 0, "kind": "station", "node_key": "B"},
        {"id": "S", "x": 30, "y": 0, "kind": "junction"},
        {"id": "T", "x": 30, "y": 70, "kind": "junction"},
    ],
    "lanes": [
        {"id": "AS", "from": "PA", "to": "S", "capacity": 2}, {"id": "SB", "from": "S", "to": "PB", "capacity": 2},
        {"id": "AT", "from": "PA", "to": "T", "capacity": 2}, {"id": "TB", "from": "T", "to": "PB", "capacity": 2},
        {"id": "BA", "from": "PB", "to": "PA", "capacity": 2},
    ],
}


# kho A có hai chỗ đỗ: PA ở xa B (100 m), PA2 ở gần B (10 m)
TWO_DOCKS = {
    "unit_m": 1, "speed_mps": 2.0,
    "points": [
        {"id": "PA", "x": 0, "y": 0, "kind": "station", "node_key": "A"},
        {"id": "PA2", "x": 90, "y": 0, "kind": "station", "node_key": "A"},
        {"id": "PB", "x": 100, "y": 0, "kind": "station", "node_key": "B"},
    ],
    "lanes": [
        {"id": "AB", "from": "PA", "to": "PB", "capacity": 1}, {"id": "BA", "from": "PB", "to": "PA", "capacity": 1},
        {"id": "A2B", "from": "PA2", "to": "PB", "capacity": 1}, {"id": "BA2", "from": "PB", "to": "PA2", "capacity": 1},
    ],
}


# PA ⇄ PC ⇄ PB, chỗ sạc PC nằm giữa đường (mỗi nửa 50 m)
CHARGE_MAP = {
    "unit_m": 1, "speed_mps": 2.0,
    "points": [
        {"id": "PA", "x": 0, "y": 0, "kind": "station", "node_key": "A"},
        {"id": "PC", "x": 50, "y": 0, "kind": "charger"},
        {"id": "PB", "x": 100, "y": 0, "kind": "station", "node_key": "B"},
    ],
    "lanes": [{"id": i, "from": a, "to": b, "capacity": 2} for i, (a, b) in
              [("AC", ("PA", "PC")), ("CA", ("PC", "PA")), ("CB", ("PC", "PB")), ("BC", ("PB", "PC"))]],
}


def world(map_data, count=1, lot=10, kind="TUGGER", **fleet_kw):
    nodes = [
        {"key": "SRC", "archetype": "SOURCE", "params": {"arrivals": {"interarrival": 10}, "lots": [{"material": "X", "qty": 20}]}},
        {"key": "A", "archetype": "STORAGE", "params": {"stock": [{"material": "X", "initial": 5000, "max": 100000}]}},
        {"key": "B", "archetype": "STORAGE", "params": {"stock": [{"material": "X", "max": 100000}]}},
        {"key": "OUT", "archetype": "SINK", "params": {"buffer": 100000}},
    ]
    edges = [
        {"key": "SRC>A", "src": "SRC", "dst": "A", "material": "X"},
        {"key": "A>B", "src": "A", "dst": "B", "material": "X", "mode": "POOL", "pool": "TUG", "lot": lot,
         "travel": {"dist": "const", "value": 10}},
        {"key": "B>OUT", "src": "B", "dst": "OUT", "material": "X"},
    ]
    req = make_request(nodes, edges, [{"key": "TUG", "kind": kind, "count": count}], horizon_s=100000)
    fleet = Fleet(MapGraph(map_data), jitter=0.0, seed=1, **fleet_kw)
    ctx = build(req, 0, fleet.make_edge)
    for o in ctx.objects():
        o.start()
    return ctx, fleet


def moved(ctx):
    return next(e for e in ctx.edges if e.key == "A>B").moved


def test_trip_time_follows_the_map_not_the_nominal_travel():
    ctx, fleet = world(LOOP)
    ctx.env.run(until=1000)
    trips = fleet.drain_trips()
    assert len(trips) >= 4
    for t in trips:
        assert t["edge"] == "A>B"
        assert t["dur"] == pytest.approx(50.0)   # 100 m ÷ 2 m/s, không phải 10 s danh nghĩa
        assert t["ideal"] == pytest.approx(50.0)
        assert t["wait"] == pytest.approx(0.0)
    assert fleet.drain_trips() == []


def test_a_node_with_two_docks_uses_the_closest_one():
    ctx, fleet = world(TWO_DOCKS)
    ctx.env.run(until=500)
    trips = fleet.drain_trips()
    assert trips
    for t in trips:
        assert t["dur"] == pytest.approx(5.0)    # 10 m ÷ 2 m/s từ chỗ đỗ gần, không phải 50 s từ chỗ đỗ đầu tiên
        assert t["ideal"] == pytest.approx(5.0)


def test_second_vehicle_waits_for_a_full_lane():
    ctx, fleet = world(LOOP, count=2)
    ctx.env.run(until=1500)
    trips = fleet.drain_trips()
    assert any(t["wait"] > 10 for t in trips), "làn sức chứa 1: xe thứ hai phải chờ"
    assert all(t["dur"] >= t["ideal"] - 1e-9 for t in trips)


def test_vehicle_position_interpolates_along_its_lane():
    ctx, fleet = world(LOOP)
    ctx.env.run(until=100)
    veh = fleet.vehicles["TUG"][0]
    # tìm một thời điểm xe đang chạy có hàng
    for now in range(101, 400):
        ctx.env.run(until=now)
        if veh.state == "MOVING" and veh.lane == "AB":
            break
    frac = (ctx.env.now - veh.t0) / veh.dur
    x, y = fleet.xy(veh, ctx.env.now)
    assert x == pytest.approx(100 * frac) and y == 0
    assert veh.load == 10


def test_blocked_lane_makes_vehicles_take_the_detour():
    ctx, fleet = world(DETOUR)
    fleet.block("AS", until=10_000)
    ctx.env.run(until=2000)
    trips = fleet.drain_trips()
    assert trips
    # đường dài: AT (76,2 m) + TB (76,2 m) ≈ 152,4 m ÷ 2 = 76,2 s; đường ngắn chỉ 30 s
    for t in trips:
        assert t["dur"] == pytest.approx((70**2 + 30**2) ** 0.5 * 2 / 2.0, rel=1e-6)


def test_no_route_means_waiting_then_resuming_after_unblock():
    ctx, fleet = world(LOOP)
    fleet.block("AB", until=400)
    ctx.env.run(until=300)
    assert moved(ctx) == 0
    veh = fleet.vehicles["TUG"][0]
    assert veh.state == "WAITING"
    ctx.env.run(until=1500)
    assert moved(ctx) > 0


def test_stuck_too_long_squeezes_through_and_counts_the_break():
    ctx, fleet = world(LOOP, deadlock_s=30.0)
    fleet.block("AB", until=10_000, avoid=False)  # giữ chỗ nhưng chi phí không phải vô hạn → xe xếp hàng chờ làn
    ctx.env.run(until=400)
    assert fleet.deadlock_breaks >= 1
    assert moved(ctx) > 0


def test_fleet_ignores_edges_without_stations_on_the_map():
    only_a = {**LOOP, "points": [LOOP["points"][0], {"id": "PX", "x": 5, "y": 5, "kind": "junction"}],
              "lanes": []}
    ctx, fleet = world(only_a)
    ctx.env.run(until=500)
    assert fleet.drain_trips() == []   # edge dùng travel danh nghĩa (10 s), không qua bản đồ
    assert moved(ctx) > 0


def test_unblock_frees_the_lane_immediately():
    ctx, fleet = world(LOOP)
    fleet.block("AB", until=10_000)
    ctx.env.run(until=200)
    assert moved(ctx) == 0
    fleet.unblock("AB")
    ctx.env.run(until=600)
    assert moved(ctx) > 0
    assert "AB" not in fleet.blocked


# --- AGV (băng từ, tuyến cố định) và AMR (tự hành, FMS điều phối) ------------------------------------------


def test_agv_keeps_its_fixed_route_and_waits_at_the_obstacle():
    ctx, fleet = world(DETOUR, kind="AGV")
    fleet.block("SB", until=10_000)
    ctx.env.run(until=300)
    assert fleet.drain_trips() == [], "AGV không đi vòng: chặn làn trên tuyến thì phải đứng chờ"
    assert [v.state for v in fleet.vehicles["TUG"]] == ["WAITING"]


def test_agv_manager_steps_in_after_the_waiting_limit():
    ctx, fleet = world(DETOUR, kind="AGV", deadlock_s=30.0)
    fleet.block("SB", until=10_000)
    ctx.env.run(until=400)
    assert fleet.deadlock_breaks >= 1, "quá thời gian chờ quy định: người quản lý xử lý (đếm lại)"
    assert moved(ctx) > 0


def test_amr_reroutes_around_the_obstacle_and_reports_its_route():
    ctx, fleet = world(DETOUR, kind="AMR")
    fleet.block("SB", until=10_000)
    veh = fleet.vehicles["TUG"][0]
    seen = []
    for now in range(1, 200):
        ctx.env.run(until=now)
        if veh.state == "MOVING" and veh.dest:
            seen.append((veh.dest, tuple(veh.route), round(veh.speed, 3)))
    trips = fleet.drain_trips()
    assert trips and trips[0]["dur"] == pytest.approx((70**2 + 30**2) ** 0.5 * 2 / 2.0, rel=1e-6)
    assert ("PB", ("PB",), 2.0) in seen and any(d == "PB" and "T" in r for d, r, _ in seen), "đang chạy: báo đích, các điểm còn phải qua và tốc độ"


def test_amr_is_dispatched_by_distance_but_legacy_pools_take_the_first_idle_vehicle():
    for kind, want in (("AMR", "TUG-02"), ("TUGGER", "TUG-01")):
        ctx, fleet = world(LOOP, count=2, kind=kind)
        v1, v2 = fleet.vehicles["TUG"]
        v1.point, v2.point = "PB", "PA"   # xe 1 ở xa chỗ lấy hàng PA, xe 2 ở ngay đó
        assert fleet.pick("TUG", "PA").id == want
        v1.busy = v2.busy = True
        assert fleet.pick("TUG", "PA") is None


def test_amr_stays_where_it_dropped_the_load_and_drives_empty_to_the_next_pickup():
    ctx, fleet = world(LOOP, kind="AMR")
    ctx.env.run(until=500)
    trips = fleet.drain_trips()
    assert len(trips) >= 3
    assert trips[0]["appr"] == pytest.approx(0.0), "xe nằm sẵn ở nguồn lúc đầu"
    for t in trips[1:]:
        assert t["appr"] == pytest.approx(50.0), "xe ở lại điểm trả hàng nên chạy rỗng 100 m ÷ 2 m/s về chỗ lấy hàng"
        assert t["dur"] == pytest.approx(50.0), "thời gian chuyến chỉ tính chặng có hàng"


def test_legacy_vehicle_still_returns_to_the_source_and_has_no_approach():
    ctx, fleet = world(LOOP)
    ctx.env.run(until=500)
    assert all(t["appr"] == 0.0 for t in fleet.drain_trips())


def test_amr_drains_battery_by_distance_loaded_drains_more():
    ctx, fleet = world(CHARGE_MAP, kind="AMR", drain_per_m=0.1, battery_range=(100.0, 100.0), low_pct=0.0)
    veh = fleet.vehicles["TUG"][0]
    assert veh.battery == 100.0
    ctx.env.run(until=51)   # chuyến có hàng 100 m xong: 100 × 0,1 × 1,3 = 13 %
    assert veh.battery == pytest.approx(87.0, abs=0.01)


def test_amr_goes_to_charge_when_low_and_is_unavailable_meanwhile():
    ctx, fleet = world(CHARGE_MAP, kind="AMR", drain_per_m=0.4, battery_range=(100.0, 100.0),
                       low_pct=25.0, full_pct=95.0, charge_pct_per_s=1.0)
    veh = fleet.vehicles["TUG"][0]
    seen = []
    for now in range(1, 700):
        ctx.env.run(until=now)
        seen.append((veh.state, veh.busy, veh.battery))
    assert any(st == "CHARGING" for st, _, _ in seen)
    assert fleet.charges >= 1
    assert all(busy for st, busy, _ in seen if st == "CHARGING"), "xe đang sạc không nhận chuyến"
    assert any(b == 95.0 for _, _, b in seen), "sạc xong tới mức đầy đặt trước"
    assert all(b >= 2.0 for _, _, b in seen)


def test_battery_is_not_modelled_without_a_charger_on_the_map():
    ctx, fleet = world(LOOP, kind="AMR")
    ctx.env.run(until=200)
    assert fleet.vehicles["TUG"][0].battery is None


def test_other_kinds_have_no_battery_even_with_a_charger():
    ctx, fleet = world(CHARGE_MAP, kind="TUGGER")
    ctx.env.run(until=100)
    assert fleet.vehicles["TUG"][0].battery is None
