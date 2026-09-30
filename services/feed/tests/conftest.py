import copy
import json
from pathlib import Path

import pytest

FIXTURE = Path(__file__).parents[2] / "sim" / "tests" / "fixtures" / "denso_mini.json"

# Bản đồ vòng một chiều cho denso-mini: kho ở góc trái-trên, 3 trạm máy dập thò xuống giữa hai hành lang.
MINI_MAP = {
    "unit_m": 2.0, "speed_mps": 1.2,
    "points": [
        {"id": "KHO", "x": 5, "y": 10, "kind": "station", "node_key": "KHO_NVL"},
        {"id": "J1", "x": 25, "y": 10, "kind": "junction"}, {"id": "J2", "x": 45, "y": 10, "kind": "junction"},
        {"id": "J3", "x": 65, "y": 10, "kind": "junction"}, {"id": "NE", "x": 85, "y": 10, "kind": "junction"},
        {"id": "SE", "x": 85, "y": 40, "kind": "junction"},
        {"id": "B3", "x": 65, "y": 40, "kind": "junction"}, {"id": "B2", "x": 45, "y": 40, "kind": "junction"},
        {"id": "B1", "x": 25, "y": 40, "kind": "junction"}, {"id": "SW", "x": 5, "y": 40, "kind": "junction"},
        {"id": "S1", "x": 25, "y": 25, "kind": "station", "node_key": "STAMP_1"},
        {"id": "S2", "x": 45, "y": 25, "kind": "station", "node_key": "STAMP_2"},
        {"id": "S3", "x": 65, "y": 25, "kind": "station", "node_key": "STAMP_3"},
    ],
    "lanes": [{"id": f"L{i + 1:02d}", "from": a, "to": b, "capacity": 2} for i, (a, b) in enumerate([
        ("KHO", "J1"), ("J1", "J2"), ("J2", "J3"), ("J3", "NE"), ("NE", "SE"), ("SE", "B3"), ("B3", "B2"), ("B2", "B1"),
        ("B1", "SW"), ("SW", "KHO"), ("J1", "S1"), ("S1", "B1"), ("J2", "S2"), ("S2", "B2"), ("J3", "S3"), ("S3", "B3"),
    ])],
}


@pytest.fixture
def blueprint():
    def make(with_map=True):
        req = json.loads(FIXTURE.read_text())
        names = {n["key"]: n["key"].replace("_", " ").title() for n in req["nodes"]}
        names.update({p["key"]: p["key"].replace("_", " ").title() for p in req["pools"]})
        return {"model": "denso-mini", "version_id": 1, "version": 1, "run_request": req, "names": names,
                "agv_map": copy.deepcopy(MINI_MAP) if with_map else None}
    return make
