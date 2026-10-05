"""Value scenarios: how the physical quantity behind each gauge evolves.

Every function is a pure function of the time axis and a NumPy Generator, so a
given seed always yields the same series.
"""

from __future__ import annotations

from dataclasses import dataclass

import numpy as np

ANOMALY_NONE = ""
ANOMALY_OVER_RANGE = "over_range"
ANOMALY_FROZEN = "frozen"


@dataclass(frozen=True)
class PressCycle:
    """Stamping cycle shared by a whole station; noise is synchronised to it."""

    period_s: float
    phase_s: float

    def since_impact(self, t: np.ndarray) -> np.ndarray:
        """Seconds elapsed since the latest press impact."""
        return np.mod(t - self.phase_s, self.period_s)


def _smooth_noise(rng: np.random.Generator, n: int, sigma: float, window: int) -> np.ndarray:
    """Gaussian noise low-pass filtered with a moving average."""
    window = max(1, min(window, n))
    raw = rng.normal(0.0, sigma, n + window - 1)
    kernel = np.full(window, 1.0 / window)
    return np.convolve(raw, kernel, mode="valid") * np.sqrt(window)


def press_cycle(
    t: np.ndarray, rng: np.random.Generator, cycle: PressCycle, low: float, peak: float
) -> np.ndarray:
    """Pressure of a stamping press: a pulse on every cycle plus noise."""
    phase = cycle.since_impact(t) / cycle.period_s
    rise, hold, fall = 0.12, 0.30, 0.50
    pulse = np.where(
        phase < rise,
        0.5 - 0.5 * np.cos(np.pi * phase / rise),
        np.where(
            phase < hold,
            1.0,
            np.where(phase < fall, 0.5 + 0.5 * np.cos(np.pi * (phase - hold) / (fall - hold)), 0.0),
        ),
    )
    # Peak height varies a little from one stroke to the next.
    stroke = np.floor((t - cycle.phase_s) / cycle.period_s).astype(np.int64)
    stroke -= stroke.min()
    stroke_gain = 1.0 + rng.normal(0.0, 0.04, int(stroke.max()) + 1)
    noise = _smooth_noise(rng, len(t), (peak - low) * 0.012, 3)
    return low + (peak - low) * pulse * stroke_gain[stroke] + noise


def saturating_rise(
    t: np.ndarray, rng: np.random.Generator, start: float, saturation: float, tau_s: float
) -> np.ndarray:
    """Temperature: slow exponential rise that settles at a saturation level."""
    noise = _smooth_noise(rng, len(t), abs(saturation - start) * 0.004, 20)
    return start + (saturation - start) * (1.0 - np.exp(-t / tau_s)) + noise


def level_with_sags(
    t: np.ndarray, rng: np.random.Generator, nominal: float, ripple: float, sag_depth: float
) -> np.ndarray:
    """Voltage: steady around a nominal level with short sags."""
    n = len(t)
    values = nominal + _smooth_noise(rng, n, ripple, 4)
    duration = float(t[-1] - t[0]) if n > 1 else 0.0
    n_sags = int(rng.poisson(max(duration / 25.0, 0.5)))
    for _ in range(n_sags):
        start = rng.uniform(t[0], t[-1])
        length = rng.uniform(0.3, 2.0)
        depth = nominal * sag_depth * rng.uniform(0.5, 1.0)
        mask = (t >= start) & (t < start + length)
        values = np.where(mask, values - depth, values)
    return values


def load_following(
    t: np.ndarray, rng: np.random.Generator, cycle: PressCycle, idle: float, load: float
) -> np.ndarray:
    """Current: follows the press cycle, higher while the press is working."""
    phase = cycle.since_impact(t) / cycle.period_s
    working = np.clip(1.0 - np.abs(phase - 0.2) / 0.3, 0.0, 1.0)
    return idle + (load - idle) * working + _smooth_noise(rng, len(t), (load - idle) * 0.02, 3)


def count_and_reset(
    t: np.ndarray, rng: np.random.Generator, min_s: float, max_s: float
) -> np.ndarray:
    """Cycle timer in seconds: counts up, then resets after a random length."""
    values = np.empty(len(t))
    start = float(t[0]) - rng.uniform(0.0, min_s)
    end = start + rng.uniform(min_s, max_s)
    for i, now in enumerate(t):
        while now >= end:
            start = end
            end = start + rng.uniform(min_s, max_s)
        values[i] = now - start
    return values


def monotonic_counter(t: np.ndarray, start: float, rate_per_s: float) -> np.ndarray:
    """Hour meter, fast-forwarded so digit transitions show up in short clips."""
    return start + rate_per_s * (t - t[0])


def apply_anomalies(
    t: np.ndarray,
    values: np.ndarray,
    rng: np.random.Generator,
    kinds: tuple[str, ...],
    over_value: float | None = None,
) -> tuple[np.ndarray, np.ndarray]:
    """Injects abnormal segments used to exercise alerting.

    Returns the modified series and a per-sample label array.
    """
    n = len(t)
    labels = np.full(n, ANOMALY_NONE, dtype=object)
    duration = float(t[-1] - t[0]) if n > 1 else 0.0
    if not kinds or duration < 30.0:
        return values, labels

    values = values.copy()
    count = max(1, round(duration / 120.0))
    for i in range(count):
        kind = kinds[i % len(kinds)]
        length = min(rng.uniform(5.0, 15.0), duration / 6.0)
        start = rng.uniform(t[0] + 0.1 * duration, t[-1] - length)
        mask = (t >= start) & (t < start + length) & (labels == ANOMALY_NONE)
        if not mask.any():
            continue
        if kind == ANOMALY_OVER_RANGE and over_value is not None:
            # Raised-cosine excursion towards the over-range level.
            window = 0.5 - 0.5 * np.cos(2.0 * np.pi * (t[mask] - start) / length)
            values[mask] = values[mask] + (over_value - values[mask]) * np.sqrt(window)
        elif kind == ANOMALY_FROZEN:
            values[mask] = values[np.argmax(mask)]
        else:
            continue
        labels[mask] = kind
    return values, labels
