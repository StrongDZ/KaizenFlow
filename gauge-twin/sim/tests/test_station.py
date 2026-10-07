"""Station layout and the exported station_config match the rendered image."""

import cv2
import numpy as np
import pytest
from denso.gauge.v1 import config_pb2
from gauge_renderer import geometry
from gauge_renderer.gauges import DialGauge, RollingCounterGauge, Seg7Gauge
from gauge_renderer.noise import FrameNoise
from gauge_renderer.render import CONFIG_FILENAME
from gauge_renderer.station import Station
from google.protobuf import json_format

SEED = 42
RECT = 256
CLEAN = FrameNoise()


@pytest.fixture(scope="module")
def stations() -> list[Station]:
    # "high" allows the full 30 degree tilt; frames are drawn without the
    # per-frame disturbances so only the perspective is in play.
    return [Station(SEED, i, "high") for i in range(16)]


def rectify(frame: np.ndarray, quad: np.ndarray) -> np.ndarray:
    matrix = geometry.quad_to_rect_homography(quad, RECT)
    return cv2.warpPerspective(frame, matrix, (RECT, RECT)).astype(float)


def default_states(station: Station) -> dict:
    states = {}
    for g in station.gauges:
        if isinstance(g, DialGauge):
            states[g.gauge_id] = (g.min_val, "")
        elif isinstance(g, Seg7Gauge):
            states[g.gauge_id] = (0.0, "8" * g.digits)
        else:
            states[g.gauge_id] = (1234.2, "")
    return states


def test_exported_config_follows_proto(rendered):
    for result in rendered:
        config = json_format.Parse(
            (result.directory / CONFIG_FILENAME).read_text(), config_pb2.StationConfig()
        )
        assert config.machine_id == result.machine_id
        assert config.camera.url.endswith(result.machine_id)
        assert 3 <= len(config.gauges) <= 5
        for gauge in config.gauges:
            assert gauge.type in {"analog_dial", "seg7", "timer_mmss", "rolling_counter"}
            assert gauge.rect_size == RECT
            assert len(gauge.quad) == 4 and len(gauge.roi) == 4
            x, y, w, h = gauge.roi
            for point in gauge.quad:
                assert x <= point.x <= x + w and y <= point.y <= y + h
            assert 0 <= x and 0 <= y and x + w <= 1920 and y + h <= 1080


def test_stations_cover_every_type_and_display_variant(stations):
    gauges = [g for s in stations for g in s.gauges]

    assert all(3 <= len(s.gauges) <= 5 for s in stations)
    assert {g.type for g in gauges} == {"analog_dial", "seg7", "timer_mmss", "rolling_counter"}
    colors = {g.color for g in gauges if isinstance(g, Seg7Gauge) and g.type == "seg7"}
    assert colors == {"red_led", "green_led", "lcd"}
    assert max(abs(s.profile.yaw_deg) for s in stations) > 10.0
    assert all(np.hypot(s.profile.yaw_deg, s.profile.pitch_deg) <= 30.0 for s in stations)


def test_quads_are_ordered_tl_tr_br_bl_and_do_not_overlap(stations):
    for station in stations:
        for quad in station.quads:
            edges = np.roll(quad, -1, axis=0) - quad
            following = np.roll(edges, -1, axis=0)
            cross = edges[:, 0] * following[:, 1] - edges[:, 1] * following[:, 0]
            assert (cross > 0).all(), "quad must be convex and clockwise on screen"
            assert np.argmin(quad.sum(axis=1)) == 0, "first point must be the top-left corner"
        boxes = station.rois
        for i, (ax, ay, aw, ah) in enumerate(boxes):
            for bx, by, bw, bh in boxes[i + 1 :]:
                assert ax + aw <= bx or bx + bw <= ax or ay + ah <= by or by + bh <= ay


def test_dial_reads_correctly_through_quad_and_calib(stations):
    """Rectify the frame with quad, measure the needle, decode with calib."""
    checked = 0
    for station in stations[:8]:
        config = station.config_dict(10.0)
        for gauge, quad, entry in zip(station.gauges, station.quads, config["gauges"], strict=True):
            if not isinstance(gauge, DialGauge):
                continue
            calib = entry["calib"]
            span = gauge.max_val - gauge.min_val
            states = default_states(station)
            states[gauge.gauge_id] = (None, "")
            bare = rectify(station.render_frame(states, CLEAN), quad)
            for frac in (0.1, 0.5, 0.9):
                value = gauge.min_val + frac * span
                states[gauge.gauge_id] = (value, "")
                diff = np.abs(rectify(station.render_frame(states, CLEAN), quad) - bare).sum(axis=2)
                ys, xs = np.nonzero(diff > 60)
                dx, dy = xs + 0.5 - calib["center"][0], ys + 0.5 - calib["center"][1]
                far = np.hypot(dx, dy) > 0.45 * RECT / 2
                angle = float(np.degrees(np.arctan2(dy[far].mean(), dx[far].mean())))
                decoded = geometry.dial_value_from_angle(
                    angle, calib["center"], calib["min_pt"], calib["max_pt"],
                    calib["min_val"], calib["max_val"], calib["sweep"],
                )  # fmt: skip
                assert (
                    abs(decoded - value) <= 0.015 * span
                ), f"{station.machine_id} {value} -> {decoded}"
                checked += 1
    assert checked >= 6


def test_digit_slots_line_up_with_quad(stations):
    """A change in one digit must land in that digit's slice of the rectified square."""
    checked = set()
    for station in stations[:10]:
        for gauge, quad in zip(station.gauges, station.quads, strict=True):
            if isinstance(gauge, DialGauge):
                continue
            states = default_states(station)
            if isinstance(gauge, Seg7Gauge):
                slot = 1
                before = (0.0, "8" * gauge.digits)
                after = (0.0, "8" + "1" + "8" * (gauge.digits - 2))
            else:
                slot = gauge.digits - 1
                before, after = (1234.2, ""), (1234.6, "")
            states[gauge.gauge_id] = before
            a = rectify(station.render_frame(states, CLEAN), quad)
            states[gauge.gauge_id] = after
            b = rectify(station.render_frame(states, CLEAN), quad)
            diff = np.abs(a - b).sum(axis=2)
            pitch = RECT / gauge.digits
            inside = diff[:, int(round(slot * pitch)) : int(round((slot + 1) * pitch))].sum()
            assert diff.sum() > 0
            assert inside / diff.sum() > 0.93, f"{station.machine_id} {gauge.gauge_id}"
            checked.add(gauge.type)
    assert checked == {"seg7", "timer_mmss", "rolling_counter"}


def test_rolling_counter_is_a_known_type(stations):
    assert any(isinstance(g, RollingCounterGauge) for s in stations for g in s.gauges)
