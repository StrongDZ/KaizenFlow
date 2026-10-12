from gauge_bridge.bridge import MIN_QUALITY, messages_from, source_of


def station(machine="LO_HOI_05", gauges=None, plant="NHA_MAY_1", line="XUONG_A"):
    return {"machine_id": machine, "plant": plant, "line": line, "gauges": gauges or []}


def gauge(gid="AP_SUAT", ts="2026-10-12T06:00:00Z", value=6.1, quality=0.95, unit="bar"):
    return {"gauge_id": gid, "ts": ts, "value": value, "quality": quality, "unit": unit}


def test_nguon_la_topic_edge_da_publish():
    assert source_of(station()) == "denso/NHA_MAY_1/XUONG_A/LO_HOI_05/telemetry"


def test_moi_may_mot_ban_tin_cac_dong_ho_nam_trong_payload():
    msgs = messages_from([station(gauges=[gauge(), gauge("NHIET_DO", value=64.0, unit="degC")])])
    assert len(msgs) == 1
    m = msgs[0]
    assert m["source"] == "denso/NHA_MAY_1/XUONG_A/LO_HOI_05/telemetry"
    assert m["payload"]["machine_id"] == "LO_HOI_05"
    assert m["payload"]["gauges"]["AP_SUAT"]["value"] == 6.1
    assert m["payload"]["gauges"]["NHIET_DO"]["unit"] == "degC"
    # Ghép nối sẽ trỏ tới gauges.<mã đồng hồ>.value
    assert set(m["payload"]["gauges"]["AP_SUAT"]) == {"value", "unit", "quality"}


def test_bo_so_doc_chat_luong_thap():
    msgs = messages_from([station(gauges=[gauge(quality=MIN_QUALITY - 0.01)])])
    assert msgs == [], "ảnh mờ / kim bị che thì không được đẩy vào twin như một số đo"


def test_chi_gui_so_doc_moi():
    seen: dict[str, str] = {}
    first = messages_from([station(gauges=[gauge()])], seen)
    assert len(first) == 1
    # Cùng mốc thời gian: không gửi lại, nếu không twin tính tốc độ bị lệch.
    assert messages_from([station(gauges=[gauge()])], seen) == []
    # Mốc mới thì gửi.
    again = messages_from([station(gauges=[gauge(ts="2026-10-12T06:00:10Z", value=6.3)])], seen)
    assert len(again) == 1 and again[0]["payload"]["gauges"]["AP_SUAT"]["value"] == 6.3
    assert again[0]["ts"] == "2026-10-12T06:00:10Z"


def test_bo_qua_tram_khong_co_so_doc_dung_duoc():
    msgs = messages_from([
        station("MAY_A", [{"gauge_id": "X", "ts": "2026-10-12T06:00:00Z", "value": None, "quality": 0.9}]),
        station("MAY_B", [gauge()]),
    ])
    assert [m["payload"]["machine_id"] for m in msgs] == ["MAY_B"]
