import numpy as np
import pytest

from sim_service.dists import make_sampler, mean_of


def draws(spec, n=20000, **kw):
    s = make_sampler(spec, np.random.default_rng(0), **kw)
    return np.array([s() for _ in range(n)])


def test_none_and_number():
    rng = np.random.default_rng(0)
    assert make_sampler(None, rng, default=3.0)() == 3.0
    assert make_sampler(7, rng)() == 7.0
    assert make_sampler({"dist": "const", "value": 2}, rng)() == 2.0


def test_exp_mean():
    assert abs(draws({"dist": "exp", "mean": 50}).mean() - 50) < 2


def test_lognorm_mean_and_cv_with_suffix_keys():
    x = draws({"dist": "lognorm", "mean_s": 3600, "cv": 0.3})
    assert abs(x.mean() - 3600) < 60
    assert abs(x.std() / x.mean() - 0.3) < 0.02


def test_tri_bounds():
    x = draws({"dist": "tri", "min": 60, "mode": 150, "max": 300})
    assert x.min() >= 60 and x.max() <= 300


def test_norm_truncated_unless_signed():
    assert draws({"dist": "norm", "mean": 0.1, "sd": 1}).min() >= 0
    assert draws({"dist": "normal", "mean": 0.1, "sd": 1}, nonneg=False).min() < 0


def test_mean_of():
    assert mean_of({"dist": "tri", "min": 0, "mode": 3, "max": 6}) == 3
    assert mean_of({"dist": "lognorm", "mean_s": 1800, "cv": 0.5}) == 1800
    assert abs(mean_of({"dist": "weibull", "shape": 1, "scale": 10}) - 10) < 1e-9
    assert mean_of(None) == 0.0


def test_unknown_dist():
    with pytest.raises(ValueError):
        make_sampler({"dist": "cauchy"}, np.random.default_rng(0))
