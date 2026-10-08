import json

from fastapi.testclient import TestClient

from helpers import FIXTURES
from sim_service.api import app

client = TestClient(app)


def payload(**update):
    data = json.loads((FIXTURES / "denso_mini.json").read_text())
    data.update({"horizon_s": 3600, "replications": 2, "recommend": True, **update})
    return data


def test_run_lifecycle_and_export():
    r = client.post("/runs", json=payload(run_id=101))
    assert r.status_code == 202 and r.json()["run_id"] == 101
    body = client.get("/runs/101").json()
    assert body["status"] == "DONE", body
    assert body["engine_version"] == "0.1.0"
    assert "throughput" in body["kpis"] and body["bands_count"] > 0
    assert any(i["kind"] == "BOTTLENECK" for i in body["insights"])
    csv = client.get("/runs/101/export.csv")
    assert csv.status_code == 200 and csv.headers["content-type"].startswith("text/csv")
    lines = csv.text.splitlines()
    assert lines[0] == "kind,time,rep,subject,name,value"
    assert any(",STAMP_3,vibration," in l for l in lines)
    assert any(",STAMP_3,rul_s," in l for l in lines)  # nhãn RUL có trong export


def test_bad_reference_returns_422_with_key():
    bad = payload(run_id=102)
    bad["edges"].append({"key": "X>Y", "src": "X", "dst": "Y", "material": "BOX"})
    r = client.post("/runs", json=bad)
    assert r.status_code == 422 and r.json()["detail"]["key"] == "X>Y"


def test_unknown_run_and_not_ready():
    assert client.get("/runs/999").status_code == 404
    assert client.get("/runs/999/export.csv").status_code == 404


def test_validate_endpoint():
    assert client.post("/validate", json=payload(run_id=201)).json() == {"ok": True}
    bad = payload(run_id=202)
    bad["edges"].append({"key": "X>Y", "src": "X", "dst": "Y", "material": "BOX"})
    r = client.post("/validate", json=bad)
    assert r.status_code == 422 and r.json()["detail"]["key"] == "X>Y"


def test_result_endpoint_returns_full_result():
    client.post("/runs", json=payload(run_id=203, recommend=False))
    body = client.get("/runs/203/result").json()
    assert set(body) == {"run_id", "engine_version", "kpis", "bands", "insights", "signals", "events", "warehouse_series_log"}
    assert body["run_id"] == 203 and len(body["bands"]) > 0 and len(body["signals"]) > 0
    assert body["bands"][0]["target_time"].startswith("2026-10-01T")
    assert client.get("/runs/9999/result").status_code == 404
