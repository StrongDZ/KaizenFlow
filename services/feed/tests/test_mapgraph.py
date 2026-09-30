import math

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
