import json
from datetime import datetime, timedelta, timezone

from feed_service.emitter import Emitter
from feed_service.world import World

BASE = datetime(2026, 10, 1, 8, 0, tzinfo=timezone(timedelta(hours=7)))


def by_source(msgs):
    return {m["source"]: m for m in msgs}


def make(blueprint, **kw):
    w = World(blueprint(**kw), base=BASE, seed=11)
    return w, Emitter(w)


def test_every_object_has_a_device_stream_with_realistic_names(blueprint):
    w, em = make(blueprint)
    w.step(1200)
    msgs = by_source(em.messages())
    for src in ("plc/prs-01/status", "plc/prs-03/status", "plc/asm/status", "wms/wh-raw/stock", "wms/wh-fg/stock",
                "dock/dock-in/count", "dock/dock-out/count", "fleet/tug-a/summary", "fleet/ops-zone-b/summary"):
        assert src in msgs, f"thiếu {src}: {sorted(msgs)}"
    assert "belt/wh-raw~prs-01/flow" in msgs
    assert all(m["desc"] for m in msgs.values())
    json.dumps(list(msgs.values()))  # phải serialize được


def test_process_status_payload_and_state_words(blueprint):
    w, em = make(blueprint)
    w.step(900)
    p = by_source(em.messages())["plc/prs-02/status"]["payload"]
    assert p["st"] in {"RUN", "WAIT_IN", "WAIT_OUT", "ALARM", "IDLE"}
    assert set(p["cnt"]) == {"in", "ok", "ng"} and isinstance(p["vib"], float)
    w.add_incident("machine_down", "STAMP_2", duration_s=3600)
    p = by_source(em.messages())["plc/prs-02/status"]["payload"]
    assert p["st"] == "ALARM" and p["vib"] > 0.6


def test_storage_stock_is_a_list_of_sku_quantities(blueprint):
    w, em = make(blueprint)
    items = by_source(em.messages())["wms/wh-raw/stock"]["payload"]["items"]
    assert items and all(set(i) == {"sku", "qty"} for i in items)
    assert {i["sku"] for i in items} == {"RAW-01"}
    assert items[0]["qty"] == w.ctx.nodes["KHO_NVL"].boxes["RAW-01"].level


def test_timestamps_are_virtual_time_and_monotonic(blueprint):
    w, em = make(blueprint)
    t1 = datetime.fromisoformat(em.messages()[0]["ts"])
    assert t1 == BASE
    w.step(600)
    t2 = datetime.fromisoformat(em.messages()[0]["ts"])
    assert t2 == BASE + timedelta(seconds=600)


def test_agv_positions_and_trips(blueprint):
    w, em = make(blueprint)
    w.step(1500)
    msgs = em.messages()
    pos = [m for m in msgs if m["source"].startswith("agv/tug-a/") and m["source"].endswith("/pos")]
    assert len(pos) == 2   # TUGGER_A có 2 xe
    for m in pos:
        p = m["payload"]
        assert {"id", "x", "y", "st", "seg", "load"} <= set(p) and p["id"].startswith("TUGGER-A-")
        assert p["st"] in {"IDLE", "LOADING", "MOVING", "WAITING"}
    trips = [m for m in msgs if m["source"].startswith("agv/trip/")]
    assert trips, "sau 25 phút phải có chuyến hoàn tất"
    t = trips[0]["payload"]
    assert set(t) == {"dur", "wait", "ideal", "appr"} and t["dur"] >= t["ideal"] - 0.11
    assert t["appr"] == 0.0, "xe kiểu cũ luôn nằm sẵn ở chỗ lấy hàng"
    # chuyến chỉ phát một lần
    assert not [m for m in em.messages() if m["source"].startswith("agv/trip/")]


def _pos(em, prefix):
    return [m["payload"] for m in em.messages() if m["source"].startswith(prefix) and m["source"].endswith("/pos")]


def test_every_vehicle_reports_speed_destination_and_route(blueprint):
    w, em = make(blueprint)
    w.step(1500)
    pos = _pos(em, "agv/tug-a/")
    assert pos
    for p in pos:
        assert isinstance(p["v"], float) and p["v"] >= 0
        assert isinstance(p["dst"], str) and isinstance(p["route"], list)
        assert "batt" not in p, "xe kéo không mô hình hoá pin"
    assert any(p["v"] > 0 and p["dst"] and p["route"] for p in pos) or any(p["st"] != "MOVING" for p in pos)


def test_amr_reports_battery_and_charges_when_the_map_has_a_charger(blueprint):
    bp = blueprint()
    bp["run_request"]["pools"][0]["kind"] = "AMR"
    bp["agv_map"]["points"].append({"id": "CH", "x": 15, "y": 10, "kind": "charger"})
    bp["agv_map"]["lanes"] += [{"id": "L90", "from": "J1", "to": "CH", "capacity": 2}, {"id": "L91", "from": "CH", "to": "J1", "capacity": 2}]
    w = World(bp, base=BASE, seed=11)
    em = Emitter(w)
    w.step(1500)
    pos = _pos(em, "agv/tug-a/")
    assert len(pos) == 2
    for p in pos:
        assert 2.0 <= p["batt"] <= 100.0
        assert p["st"] in {"IDLE", "LOADING", "MOVING", "WAITING", "CHARGING"}


def test_no_map_means_no_agv_streams(blueprint):
    w, em = make(blueprint, with_map=False)
    w.step(600)
    assert not [m for m in em.messages() if m["source"].startswith("agv/")]


def test_agv_positions_in_controller_frame_have_heading_and_no_lane(blueprint):
    import numpy as np
    from feed_service.frame import ControllerFrame
    w, em = make(blueprint)
    w.frame = ControllerFrame(dx=-4.0, dy=52.0, rot_deg=90, scale=0.001, noise_m=0.05)
    w.step(1500)
    pos = [m for m in em.messages() if m["source"].startswith("agv/") and m["source"].endswith("/pos")]
    assert pos
    now = w.ctx.env.now
    truth = {v.id: w.fleet.xy(v, now) for vs in w.fleet.vehicles.values() for v in vs}
    for m in pos:
        p = m["payload"]
        assert "seg" not in p and "th" in p
        mx, my = w.frame.to_map(p["x"], p["y"])
        tx, ty = truth[p["id"]]
        assert abs(mx - tx) < 0.5 and abs(my - ty) < 0.5, "đổi ngược khung phải về đúng vị trí (nhiễu ≤ vài chục cm)"
        assert abs(p["x"]) > 100, "toạ độ hãng xe phải là mm, khác hệ bản đồ"
