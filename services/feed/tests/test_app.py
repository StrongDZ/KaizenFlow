import pytest
from fastapi.testclient import TestClient
from feed_service.app import create_app
from feed_service.runner import Runner
from feed_service.sinks import ApiError


class FakeClient:
    def __init__(self, bp):
        self.bp, self.cleared, self.error = bp, [], None

    def blueprint(self, model):
        if self.error:
            raise self.error
        return self.bp

    def clear_live(self, model):
        self.cleared.append(model)


@pytest.fixture
def env(blueprint):
    runner = Runner(lambda msgs: None, tick_s=0.02)
    client = FakeClient(blueprint())
    yield TestClient(create_app(runner, client)), runner, client
    runner.shutdown()


def test_start_status_speed_pause_resume_stop(env):
    c, runner, _ = env
    assert c.get("/status").json()["state"] == "idle"
    r = c.post("/start", json={"model": "denso-mini", "speed": 60}).json()
    assert r["state"] == "running" and r["speed"] == 60 and r["truth"]["cycle_factor"] == 1.10 and r["has_map"]
    assert c.post("/speed", json={"speed": 120}).json()["speed"] == 120
    assert c.post("/pause").json()["state"] == "paused"
    assert c.post("/resume").json()["state"] == "running"
    assert c.post("/stop").json()["state"] == "idle"


def test_start_uses_custom_hidden_truth(env):
    c, _, _ = env
    r = c.post("/start", json={"model": "denso-mini", "cycle_factor": 1.3, "demand_factor": 1.0}).json()
    assert r["truth"] == {"cycle_factor": 1.3, "demand_factor": 1.0}


def test_start_reports_api_problems_in_plain_words(env):
    c, _, client = env
    client.error = ApiError(409, "mô hình chưa có version nào đã Publish")
    r = c.post("/start", json={"model": "x"})
    assert r.status_code == 409 and "Publish" in r.json()["detail"]
    client.error = ApiError(502, "không nối được API: refused")
    assert c.post("/start", json={"model": "x"}).status_code == 502


def test_incident_lifecycle_and_validation(env):
    c, _, _ = env
    r = c.post("/incidents", json={"kind": "machine_down", "target": "STAMP_1"})
    assert r.status_code == 409  # chưa start
    c.post("/start", json={"model": "denso-mini", "speed": 10})
    r = c.post("/incidents", json={"kind": "machine_down", "target": "STAMP_1", "duration_s": 900})
    assert r.status_code == 201 and r.json()["active"]
    iid = r.json()["id"]
    assert [i["id"] for i in c.get("/incidents").json()] == [iid]
    assert c.post("/incidents", json={"kind": "machine_down", "target": "NOPE"}).status_code == 422
    assert c.post("/incidents", json={"kind": "stock_drain", "target": "KHO_NVL", "material": "RAW-01", "fraction": 0.3}).status_code == 201
    assert c.delete(f"/incidents/{iid}").status_code == 204
    assert c.delete(f"/incidents/{iid}").status_code == 404


def test_reset_stops_and_asks_the_api_to_clear_live_data(env):
    c, _, client = env
    c.post("/start", json={"model": "denso-mini"})
    client.cleared.clear()  # bắt đầu cũng xoá dữ liệu cũ; ở đây chỉ kiểm riêng nút Đặt lại
    r = c.post("/reset", json={"model": "denso-mini"}).json()
    assert r["state"] == "idle" and client.cleared == ["denso-mini"]


def test_start_clears_old_live_data_first_because_virtual_time_restarts(env):
    c, _, client = env
    c.post("/start", json={"model": "denso-mini"})
    assert client.cleared == ["denso-mini"]
    c.post("/start", json={"model": "denso-mini"})
    assert client.cleared == ["denso-mini", "denso-mini"]


def test_start_with_controller_frame_is_reported_in_status(env):
    c, _, _ = env
    assert c.post("/start", json={"model": "denso-mini"}).json()["frame"] is None
    r = c.post("/start", json={"model": "denso-mini", "frame": {"dx": -4, "dy": 52, "rot_deg": 90, "scale": 0.001}}).json()
    assert r["frame"] == {"dx": -4, "dy": 52, "rot_deg": 90, "scale": 0.001, "flip_y": False, "noise_m": 0.05}
    assert c.post("/start", json={"model": "denso-mini", "frame": {"scale": 0}}).status_code == 422
