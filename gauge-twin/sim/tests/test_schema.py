"""Tests for the Python code generated from schemas/proto (run `make proto` first)."""

import json
from pathlib import Path

from denso.gauge.v1 import config_pb2, telemetry_pb2
from google.protobuf import json_format

STATION_CONFIG = Path(__file__).parents[2] / "schemas" / "testdata" / "station_config.json"


def test_station_config_matches_spec_json():
    raw = STATION_CONFIG.read_text()

    cfg = json_format.Parse(raw, config_pb2.StationConfig())

    assert cfg.config_version == 7
    assert [g.type for g in cfg.gauges] == ["analog_dial", "seg7", "timer_mmss", "rolling_counter"]
    assert cfg.gauges[0].calib.HasField("min_val")
    assert not cfg.gauges[2].HasField("rules")
    round_trip = json_format.MessageToDict(cfg, preserving_proto_field_name=True)
    assert round_trip == json.loads(raw)


def test_measurement_value_presence():
    msg = telemetry_pb2.Telemetry(edge_id="edge-1", seq=42)
    msg.measurements.add(gauge_id="UNREADABLE", flags=[telemetry_pb2.FLAG_BLUR])
    msg.measurements.add(gauge_id="ZERO", value=0.0, quality=0.9)

    out = telemetry_pb2.Telemetry.FromString(msg.SerializeToString())

    assert out.seq == 42
    assert not out.measurements[0].HasField("value")
    assert out.measurements[1].HasField("value")
    assert out.measurements[1].value == 0.0
