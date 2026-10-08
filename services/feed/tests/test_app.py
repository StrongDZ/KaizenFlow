import pytest
from fastapi.testclient import TestClient
from feed_service.app import create_app
from feed_service.runner import Runner, RunnerPool
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
    pool = RunnerPool(lambda model: Runner(lambda msgs: None, tick_s=0.02), max_runners=2)
    client = FakeClient(blueprint())
    yield TestClient(create_app(pool, client)), pool, client
    pool.shutdown()


M = {"model": "denso-mini"}


def test_start_status_speed_pause_resume_stop(env):
    c, _, _ = env
    assert c.get("/status", params=M).json()["state"] == "idle"
    r = c.post("/start", json={"model": "denso-mini", "speed": 60}).json()
    assert r["state"] == "running" and r["speed"] == 60 and r["truth"]["cycle_factor"] == 1.10 and r["has_map"]
    assert c.post("/speed", json={**M, "speed": 120}).json()["speed"] == 120
    assert c.post("/pause", json=M).json()["state"] == "paused"
    assert c.post("/resume", json=M).json()["state"] == "running"
    assert c.post("/stop", json=M).json()["state"] == "idle"


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
    r = c.post("/incidents", json={**M, "kind": "machine_down", "target": "STAMP_1"})
    assert r.status_code == 409  # chưa start
    c.post("/start", json={"model": "denso-mini", "speed": 10})
    r = c.post("/incidents", json={**M, "kind": "machine_down", "target": "STAMP_1", "duration_s": 900})
    assert r.status_code == 201 and r.json()["active"]
    iid = r.json()["id"]
    assert [i["id"] for i in c.get("/incidents", params=M).json()] == [iid]
    assert c.post("/incidents", json={**M, "kind": "machine_down", "target": "NOPE"}).status_code == 422
    assert c.post("/incidents", json={**M, "kind": "stock_drain", "target": "KHO_NVL", "material": "RAW-01", "fraction": 0.3}).status_code == 201
    assert c.delete(f"/incidents/{iid}", params=M).status_code == 204
    assert c.delete(f"/incidents/{iid}", params=M).status_code == 404


def test_reset_stops_and_asks_the_api_to_clear_live_data(env):
    c, _, client = env
    c.post("/start", json={"model": "denso-mini"})
    client.cleared.clear()  # bắt đầu cũng xoá dữ liệu cũ; ở đây chỉ kiểm riêng nút Đặt lại
    r = c.post("/reset", json=M).json()
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


def test_control_endpoints_demand_a_model(env):
    c, _, _ = env
    assert c.get("/status").status_code == 422
    for path in ("/pause", "/resume", "/stop", "/reset"):
        assert c.post(path, json={}).status_code == 422, path
    assert c.post("/speed", json={"speed": 5}).status_code == 422
    assert c.get("/incidents").status_code == 422
    assert c.delete("/incidents/1").status_code == 422


def test_two_models_run_together_and_each_command_touches_only_its_own(env, blueprint):
    c, _, client = env
    other = blueprint()
    other["model"] = "denso-two"
    bps = {"denso-mini": client.bp, "denso-two": other}
    client.blueprint = lambda model: bps[model]
    c.post("/start", json={"model": "denso-mini", "speed": 10})
    c.post("/start", json={"model": "denso-two", "speed": 20})
    assert {f["model"]: f["speed"] for f in c.get("/feeds").json()} == {"denso-mini": 10, "denso-two": 20}
    assert c.post("/pause", json=M).json()["state"] == "paused"
    assert c.get("/status", params={"model": "denso-two"}).json()["state"] == "running"
    c.post("/speed", json={"model": "denso-two", "speed": 99})
    assert c.get("/status", params=M).json()["speed"] == 10
    iid = c.post("/incidents", json={"model": "denso-two", "kind": "machine_down", "target": "STAMP_1", "duration_s": 600}).json()["id"]
    assert c.get("/incidents", params=M).json() == []
    assert c.delete(f"/incidents/{iid}", params=M).status_code == 404  # id của mô hình kia không xoá được từ mô hình này
    assert c.delete(f"/incidents/{iid}", params={"model": "denso-two"}).status_code == 204
    c.post("/reset", json=M)
    assert [f["model"] for f in c.get("/feeds").json()] == ["denso-two"]


def test_start_beyond_the_limit_says_which_models_to_stop(env, blueprint):
    c, _, client = env
    bps = {m: {**client.bp, "model": m} for m in ("m1", "m2", "m3")}
    client.blueprint = lambda model: bps[model]
    assert c.post("/start", json={"model": "m1"}).status_code == 200
    assert c.post("/start", json={"model": "m2"}).status_code == 200
    r = c.post("/start", json={"model": "m3"})
    assert r.status_code == 409 and "tối đa 2" in r.json()["detail"]
    assert c.post("/start", json={"model": "m1"}).status_code == 200  # chạy lại mô hình đang chạy thì được
