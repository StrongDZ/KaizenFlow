"""Bộ lấy mẫu phân phối từ dict JSON của contract."""
from __future__ import annotations

import math
from typing import Callable

import numpy as np

Sampler = Callable[[], float]
_ALIASES = {"normal": "norm"}


def _norm(spec: dict) -> dict:
    out: dict = {}
    for k, v in spec.items():
        if k != "dist" and k.endswith("_s"):
            k = k[:-2]
        out[k] = v
    d = spec.get("dist", "const")
    out["dist"] = _ALIASES.get(d, d)
    return out


def make_sampler(spec, rng: np.random.Generator, default: float = 0.0, nonneg: bool = True) -> Sampler:
    if spec is None:
        return lambda: default
    if isinstance(spec, (int, float)):
        v = float(spec)
        return lambda: v
    s = _norm(spec)
    d = s["dist"]
    if d == "const":
        v = float(s["value"])
        return lambda: v
    if d == "exp":
        m = float(s["mean"])
        return lambda: float(rng.exponential(m))
    if d == "norm":
        m, sd = float(s["mean"]), float(s["sd"])
        if nonneg:
            return lambda: max(0.0, float(rng.normal(m, sd)))
        return lambda: float(rng.normal(m, sd))
    if d == "lognorm":
        m, cv = float(s["mean"]), float(s["cv"])
        sigma2 = math.log(1.0 + cv * cv)
        mu, sigma = math.log(m) - sigma2 / 2.0, math.sqrt(sigma2)
        return lambda: float(rng.lognormal(mu, sigma))
    if d == "tri":
        a, c, b = float(s["min"]), float(s["mode"]), float(s["max"])
        return lambda: float(rng.triangular(a, c, b))
    if d == "uniform":
        a, b = float(s["min"]), float(s["max"])
        return lambda: float(rng.uniform(a, b))
    if d == "weibull":
        k, lam = float(s["shape"]), float(s["scale"])
        return lambda: float(lam * rng.weibull(k))
    raise ValueError(f"unknown dist '{d}'")


def mean_of(spec) -> float:
    if spec is None:
        return 0.0
    if isinstance(spec, (int, float)):
        return float(spec)
    s = _norm(spec)
    d = s["dist"]
    if d == "const":
        return float(s["value"])
    if d in ("exp", "norm", "lognorm"):
        return float(s["mean"])
    if d == "tri":
        return (float(s["min"]) + float(s["mode"]) + float(s["max"])) / 3.0
    if d == "uniform":
        return (float(s["min"]) + float(s["max"])) / 2.0
    if d == "weibull":
        return float(s["scale"]) * math.gamma(1.0 + 1.0 / float(s["shape"]))
    raise ValueError(f"unknown dist '{d}'")
