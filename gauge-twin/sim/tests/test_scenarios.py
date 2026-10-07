"""Value scenarios behave like the physical quantities they imitate."""

import numpy as np
from gauge_renderer import scenarios
from gauge_renderer.scenarios import PressCycle

FPS = 10.0
CYCLE = PressCycle(period_s=2.0, phase_s=0.3)


def axis(seconds: float) -> np.ndarray:
    return np.arange(int(seconds * FPS)) / FPS


def rng(seed: int = 1) -> np.random.Generator:
    return np.random.default_rng(seed)


def test_press_cycle_pulses_once_per_period():
    t = axis(60)
    v = scenarios.press_cycle(t, rng(), CYCLE, low=30.0, peak=100.0)

    assert 20.0 < v.min() < 40.0
    assert 85.0 < v.max() < 120.0
    high = v > 65.0
    strokes = np.count_nonzero(high[1:] & ~high[:-1])
    assert abs(strokes - 30) <= 1


def test_saturating_rise_settles_at_saturation():
    t = axis(600)
    v = scenarios.saturating_rise(t, rng(), start=25.0, saturation=80.0, tau_s=60.0)

    assert abs(v[0] - 25.0) < 2.0
    assert abs(v[-100:].mean() - 80.0) < 1.0
    assert v[: len(v) // 2].mean() < v[len(v) // 2 :].mean()


def test_level_with_sags_stays_near_nominal_with_short_drops():
    t = axis(300)
    v = scenarios.level_with_sags(t, rng(), nominal=220.0, ripple=0.7, sag_depth=0.15)

    assert abs(np.median(v) - 220.0) < 1.0
    assert v.max() < 225.0
    assert v.min() < 210.0
    assert np.mean(v < 210.0) < 0.2


def test_count_and_reset_counts_seconds_and_resets():
    t = axis(300)
    v = scenarios.count_and_reset(t, rng(), 20.0, 90.0)

    steps = np.diff(v)
    resets = steps < 0
    assert v.min() >= 0.0 and v.max() <= 90.0
    assert resets.sum() >= 3
    assert np.allclose(steps[~resets], 1.0 / FPS)


def test_monotonic_counter_never_decreases():
    v = scenarios.monotonic_counter(axis(120), start=1234.5, rate_per_s=0.02)

    assert v[0] == 1234.5
    assert (np.diff(v) > 0).all()


def test_anomalies_inject_frozen_and_over_range_segments():
    t = axis(600)
    base = scenarios.press_cycle(t, rng(), CYCLE, low=30.0, peak=100.0)
    kinds = (scenarios.ANOMALY_OVER_RANGE, scenarios.ANOMALY_FROZEN)

    v, labels = scenarios.apply_anomalies(t, base, rng(2), kinds, over_value=140.0)

    frozen = labels == scenarios.ANOMALY_FROZEN
    over = labels == scenarios.ANOMALY_OVER_RANGE
    assert frozen.any() and over.any()
    assert np.mean(labels != scenarios.ANOMALY_NONE) < 0.2
    assert v[over].max() > 130.0
    assert np.array_equal(v[labels == ""], base[labels == ""])
    # Each frozen segment holds a single value.
    edges = np.flatnonzero(np.diff(np.concatenate([[0], frozen.astype(int), [0]])))
    for start, stop in zip(edges[::2], edges[1::2], strict=True):
        assert np.ptp(v[start:stop]) == 0.0


def test_short_clips_have_no_anomalies():
    t = axis(10)
    base = np.ones(len(t))

    v, labels = scenarios.apply_anomalies(t, base, rng(), (scenarios.ANOMALY_FROZEN,))

    assert (labels == "").all() and np.array_equal(v, base)


def test_scenarios_are_deterministic():
    t = axis(60)

    a = scenarios.press_cycle(t, rng(5), CYCLE, 30.0, 100.0)
    b = scenarios.press_cycle(t, rng(5), CYCLE, 30.0, 100.0)
    c = scenarios.press_cycle(t, rng(6), CYCLE, 30.0, 100.0)

    assert np.array_equal(a, b)
    assert not np.array_equal(a, c)
