"""active_period_shares phải cho cùng kết quả với bản duyệt từng mốc, và đủ nhanh cho dự báo nhiều ngày."""
import random
import time
from collections import defaultdict

import numpy as np
from sim_service.detect import active_period_shares


def reference(periods: dict, horizon: float, step: float = 60.0) -> dict[str, float]:
    """Bản gốc (chậm): duyệt từng mốc, chọn khoảng dài nhất đang phủ mốc đó; hoà thì lấy node đứng trước."""
    counts: dict[str, int] = defaultdict(int)
    ticks = np.arange(0.0, horizon, step)
    for t in ticks:
        best, best_len = None, 0.0
        for subject, ps in periods.items():
            for a, b in ps:
                if a <= t < b:
                    if b - a > best_len:
                        best, best_len = subject, b - a
                    break
        if best is not None:
            counts[best] += 1
    return {s: c / len(ticks) for s, c in counts.items()}


def random_periods(rng: random.Random, horizon: float, n: int) -> list[tuple[float, float]]:
    cuts = sorted(rng.uniform(0, horizon) for _ in range(2 * n))
    return [(cuts[i], cuts[i + 1]) for i in range(0, 2 * n, 2)]


def test_matches_the_reference_on_random_inputs():
    rng = random.Random(4)
    for trial in range(8):
        horizon = rng.choice([3600.0, 14400.0, 40000.0])
        periods = {f"M{i}": random_periods(rng, horizon, rng.randint(0, 25)) for i in range(rng.randint(1, 6))}
        assert active_period_shares(periods, horizon) == reference(periods, horizon), f"trial {trial}"


def test_ties_go_to_the_node_listed_first_and_touching_periods_are_half_open():
    periods = {"A": [(0.0, 120.0)], "B": [(0.0, 120.0)], "C": [(120.0, 240.0)]}
    got = active_period_shares(periods, 240.0, step=60.0)
    assert got == reference(periods, 240.0, step=60.0)
    assert got["A"] == 0.5 and "B" not in got and got["C"] == 0.5


def test_no_periods_gives_empty_and_empty_horizon_is_safe():
    assert active_period_shares({"A": []}, 3600.0) == {}
    assert active_period_shares({}, 3600.0) == {}


def test_a_week_of_many_periods_is_fast():
    rng = random.Random(1)
    horizon = 7 * 86400.0
    periods = {f"M{i}": random_periods(rng, horizon, 3000) for i in range(9)}
    t0 = time.time()
    active_period_shares(periods, horizon)
    assert time.time() - t0 < 2.0
