"""Each gauge face shows the value it is asked to show."""

import numpy as np
import pytest
from gauge_renderer.gauges import DialGauge, RollingCounterGauge, Seg7Gauge
from gauge_renderer.geometry import dial_value_from_angle


def rng(seed: int) -> np.random.Generator:
    return np.random.default_rng(seed)


def needle_angle(gauge: DialGauge, value: float) -> float:
    """Measures the needle direction from the pixels it changes on the face."""
    diff = np.abs(gauge.render(value).astype(int) - gauge.render(None).astype(int)).sum(axis=2)
    ys, xs = np.nonzero(diff > 60)
    dx, dy = xs - gauge.center[0], ys - gauge.center[1]
    far = np.hypot(dx, dy) > 0.45 * gauge.radius
    return float(np.degrees(np.arctan2(dy[far].mean(), dx[far].mean())))


@pytest.mark.parametrize("seed", range(12))
def test_dial_needle_matches_calibration(seed):
    gauge = DialGauge("G", "pressure" if seed % 2 else "temperature", rng(seed))
    calib = gauge.calib(256)
    span = gauge.max_val - gauge.min_val
    assert 180.0 <= gauge.sweep_deg <= 320.0

    for frac in (0.0, 0.13, 0.5, 0.77, 1.0):
        value = gauge.min_val + frac * span
        decoded = dial_value_from_angle(
            needle_angle(gauge, value), calib["center"], calib["min_pt"], calib["max_pt"],
            calib["min_val"], calib["max_val"], calib["sweep"],
        )  # fmt: skip
        assert abs(decoded - value) <= 0.01 * span, f"value {value}, decoded {decoded}"


def test_dial_styles_are_all_generated():
    gauges = [DialGauge("G", "pressure", rng(seed)) for seed in range(60)]

    assert {g.needle_style for g in gauges} == {"line", "tapered", "arrow"}
    assert {g.sweep for g in gauges} == {"cw", "ccw"}
    assert {g.dark_face for g in gauges} == {True, False}


def test_seg7_formats_values_into_slots():
    volt = Seg7Gauge("V", "voltage", rng(0))
    amp = Seg7Gauge("A", "current", rng(0))
    timer = Seg7Gauge("T", "timer", rng(0))

    assert volt.format(220.5) == "2205"
    assert volt.format(22.5) == "_225"
    assert volt.format(0.3) == "__03"
    assert volt.format(5000.0) == "9999"
    assert amp.format(7.25) == "_72"
    assert timer.format(205.0) == "0325"
    assert timer.format(59.0) == "0059"
    assert timer.calib(256) == {"digits": 4, "colon_after": 2, "color": timer.color}
    assert volt.calib(256) == {"digits": 4, "decimal_pos": 3, "color": volt.color}


@pytest.mark.parametrize("color", ["red_led", "green_led", "lcd"])
def test_seg7_change_of_one_digit_stays_in_its_cell(color):
    gauge = Seg7Gauge("V", "voltage", rng(3), color=color)
    x0 = int(gauge.quad_local[0][0])

    for slot in range(gauge.digits):
        text = "8" * slot + "1" + "8" * (gauge.digits - slot - 1)
        diff = np.abs(
            gauge.render(1.0, "8888").astype(float) - gauge.render(1.0, text).astype(float)
        ).sum(axis=2)
        inside = diff[:, x0 + slot * gauge.cell_w : x0 + (slot + 1) * gauge.cell_w].sum()
        assert diff.sum() > 0
        assert inside / diff.sum() > 0.97


def test_seg7_led_is_bright_on_dark_and_lcd_is_dark_on_light():
    led = Seg7Gauge("V", "voltage", rng(1), color="red_led")
    lcd = Seg7Gauge("V", "voltage", rng(1), color="lcd")

    assert led.emissive and not lcd.emissive
    assert led.render(1.0, "8888").mean() > led.render(None, "").mean() + 10
    assert lcd.render(1.0, "8888").mean() < lcd.render(None, "").mean() - 10
    # Red LED: the red channel (index 2 in BGR) dominates.
    lit = led.render(1.0, "8888").reshape(-1, 3).mean(axis=0)
    assert lit[2] > 2 * lit[0]


def test_seg7_timer_simulation_reports_seconds():
    from gauge_renderer.scenarios import PressCycle

    timer = Seg7Gauge("T", "timer", rng(0))
    t = np.arange(600) / 10.0
    display = timer.simulate(t, 10.0, rng(1), PressCycle(2.0, 0.0))

    assert (display.values == np.floor(display.values)).all()
    for value, text in zip(display.values[:50], display.texts[:50], strict=True):
        assert int(text[:2]) * 60 + int(text[2:]) == int(value)


def test_seg7_meter_holds_value_between_refreshes():
    from gauge_renderer.scenarios import PressCycle

    meter = Seg7Gauge("V", "voltage", rng(4))
    t = np.arange(300) / 10.0
    display = meter.simulate(t, 10.0, rng(1), PressCycle(2.0, 0.0))

    step = max(1, round(meter.refresh_s * 10.0))
    for start in range(0, 300, step):
        assert len(set(display.texts[start : start + step])) == 1
    assert meter.rules()["min"] == 0.0 and meter.rules()["max"] > 0.0
    assert all(
        float(text.replace("_", "0")) / 10.0 == value
        for text, value in zip(display.texts, display.values, strict=True)
    )


def test_rolling_counter_reads_lower_digit_while_rolling():
    gauge = RollingCounterGauge("H", rng(0))
    pad = "0" * (gauge.digits - 4)

    assert gauge.read(123.4) == (pad + "1234", "0" * gauge.digits)
    # Half way from .4 to .5: only the last wheel is moving, it still reads 4.
    assert gauge.read(123.45) == (pad + "1234", "0" * (gauge.digits - 1) + "1")
    # Last wheel half way from 9 to 0: it drags the next wheel along.
    assert gauge.read(123.95) == (pad + "1239", "0" * (gauge.digits - 2) + "11")
    # Cascading carry: 199.95 -> 200.0 moves the last four wheels together.
    assert gauge.read(199.95) == (pad + "1999", "0" * (gauge.digits - 4) + "1111")


def test_rolling_counter_reading_never_goes_backwards():
    gauge = RollingCounterGauge("H", rng(2))
    values = 98.7 + np.arange(4000) * 0.001

    readings = [int(gauge.read(float(v))[0]) / 10.0 for v in values]

    assert (np.diff(readings) >= 0).all()
    assert np.max(np.abs(np.array(readings) - values)) <= 0.1 + 1e-6


def test_rolling_counter_draws_two_digits_during_transition():
    gauge = RollingCounterGauge("H", rng(1))
    cw, p = gauge.cell_w, gauge.pad
    last = slice(p + (gauge.digits - 1) * cw, p + gauge.digits * cw)

    rest, mid, following = gauge.render(123.4), gauge.render(123.45), gauge.render(123.5)

    assert not np.array_equal(mid[:, last], rest[:, last])
    assert not np.array_equal(mid[:, last], following[:, last])
    # Wheels to the left do not move.
    assert np.array_equal(mid[:, : last.start - 2], rest[:, : last.start - 2])
