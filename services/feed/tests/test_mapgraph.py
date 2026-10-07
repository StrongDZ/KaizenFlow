import math

import pytest

from feed_service.mapgraph import MapGraph

MAP = {
    "unit_m": 1, "speed_mps": 2.0,
    "points": [
        {"id": "A", "x": 0, "y": 0, "kind": "station", "node_key": "KHO"},
        {"id": "B", "x": 10, "y": 0, "kind": "junction"},
        {"id": "C", "x": 10, "y": 10, "kind": "junction"},
        {"id": "D", "x": 20, "y": 0, "kind": "station", "node_key": "STAMP"},
    ],
    "lanes": [
        {"id": "AB", "from": "A", "to": "B", "capacity": 1},
        {"id": "BD", "from": "B", "to": "D", "capacity": 1},
        {"id": "BC", "from": "B", "to": "C", "capacity": 1},
        {"id": "CD", "from": "C", "to": "D", "capacity": 1},
        {"id": "DA", "from": "D", "to": "A", "capacity": 1},
    ],
}


def test_lane_length_and_station_lookup():
    g = MapGraph(MAP)
    assert g.lanes["AB"].length_m == 10
    assert math.isclose(g.lanes["BC"].length_m, 10)
    assert g.station_of("KHO") == "A" and g.station_of("STAMP") == "D" and g.station_of("NOPE") is None
    assert g.speed_mps == 2.0


def test_shortest_path_respects_direction_and_cost():
    g = MapGraph(MAP)
    path = g.shortest("A", "D", lambda lane: lane.length_m)
    assert [l.id for l in path] == ["AB", "BD"]
    back = g.shortest("D", "A", lambda lane: lane.length_m)
    assert [l.id for l in back] == ["DA"]
    assert g.shortest("A", "A", lambda lane: 1.0) == []


def test_infinite_cost_blocks_a_lane_and_forces_the_detour():
    g = MapGraph(MAP)
    cost = lambda lane: math.inf if lane.id == "BD" else lane.length_m  # noqa: E731
    assert [l.id for l in g.shortest("A", "D", cost)] == ["AB", "BC", "CD"]
    blocked_all = lambda lane: math.inf if lane.id in ("BD", "CD") else lane.length_m  # noqa: E731
    assert g.shortest("A", "D", blocked_all) is None
    assert g.shortest("A", "ZZ", lambda lane: 1.0) is None


def test_point_on_lane_interpolates():
    g = MapGraph(MAP)
    assert g.xy_on_lane("AB", 0.0) == (0, 0)
    assert g.xy_on_lane("AB", 0.5) == (5, 0)
    assert g.xy_on_lane("AB", 1.5) == (10, 0)  # kẹp trong [0, 1]
    assert g.xy_of("C") == (10, 10)


def test_bad_map_is_rejected_with_a_clear_message():
    import pytest
    with pytest.raises(ValueError, match="lane XX"):
        MapGraph({"speed_mps": 1, "points": [{"id": "A", "x": 0, "y": 0, "kind": "junction"}],
                  "lanes": [{"id": "XX", "from": "A", "to": "Z", "capacity": 1}]})


def test_v2_lane_is_a_polyline_with_arc_length_pose():
    import math
    g = MapGraph({"v": 2, "speed_mps": 1.0,
                  "points": [{"id": "A", "x": 0, "y": 0, "kind": "junction"}, {"id": "B", "x": 10, "y": 0, "kind": "junction"}],
                  "lanes": [{"id": "L", "from": "A", "to": "B", "capacity": 1, "path": [{"x": 5, "y": 5}]}]})
    assert g.lanes["L"].length_m == pytest.approx(2 * math.hypot(5, 5))
    x, y, th = g.pose_on_lane("L", 0.5)
    assert (x, y) == pytest.approx((5, 5))
    assert g.pose_on_lane("L", 0.25)[2] == pytest.approx(45)
    assert g.pose_on_lane("L", 0.75)[2] == pytest.approx(315)  # đi xuống-phải rồi lên-phải: 45° rồi -45°, chuẩn hoá về [0,360)
    assert g.xy_on_lane("L", 1.0) == pytest.approx((10, 0))
    assert g.pose_on_lane("L", 5.0)[:2] == pytest.approx((10, 0))  # ngoài [0,1] bị kẹp


def test_v1_map_is_converted_to_meters_on_load():
    g = MapGraph({"unit_m": 2.0, "speed_mps": 1.0,
                  "points": [{"id": "A", "x": 0, "y": 0, "kind": "junction"}, {"id": "B", "x": 10, "y": 5, "kind": "junction"}],
                  "lanes": [{"id": "L", "from": "A", "to": "B", "capacity": 1}]})
    assert g.xy_of("B") == pytest.approx((20, 10))
    assert g.lanes["L"].length_m == pytest.approx((20 ** 2 + 10 ** 2) ** 0.5)


def test_zero_length_lane_has_a_pose():
    g = MapGraph({"v": 2, "speed_mps": 1.0,
                  "points": [{"id": "A", "x": 3, "y": 4, "kind": "junction"}, {"id": "B", "x": 3, "y": 4, "kind": "junction"}],
                  "lanes": [{"id": "L", "from": "A", "to": "B", "capacity": 1}]})
    assert g.pose_on_lane("L", 0.5)[:2] == pytest.approx((3, 4))
