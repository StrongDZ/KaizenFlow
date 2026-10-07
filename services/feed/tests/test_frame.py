import pytest

from feed_service.frame import ControllerFrame


# Các ca dưới đây lấy nguyên từ frame_test.go của Go (Frame.Apply): to_raw phải là phép ngược.
@pytest.mark.parametrize("kw, raw, mapped", [
    ({}, (3, 4), (3, 4)),
    ({"scale": 0.001}, (2000, 500), (2, 0.5)),
    ({"rot_deg": 90}, (1, 0), (0, 1)),
    ({"dx": 10, "dy": -5}, (1, 2), (11, -3)),
    ({"flip_y": True, "dy": 100}, (5, 20), (5, 80)),
    ({"scale": 2, "rot_deg": 90, "dx": 1, "dy": 1}, (1, 0), (1, 3)),
])
def test_to_map_matches_go_and_to_raw_inverts_it(kw, raw, mapped):
    f = ControllerFrame(**kw)
    assert f.to_map(*raw) == pytest.approx(mapped)
    assert f.to_raw(*mapped) == pytest.approx(raw)


def test_heading_round_trip_and_flip():
    f = ControllerFrame(rot_deg=90)
    assert f.heading_to_raw(100) == pytest.approx(10)
    assert ControllerFrame(flip_y=True).heading_to_raw(330) == pytest.approx(30)
    for kw in ({"rot_deg": 37}, {"rot_deg": 200, "flip_y": True}):
        g = ControllerFrame(**kw)
        for h in (0, 45, 179, 300):
            assert g.heading_to_raw(g.heading_to_map(h)) == pytest.approx(h % 360)


def test_noise_is_small_and_reproducible():
    import numpy as np
    f = ControllerFrame(noise_m=0.05)
    a = f.to_raw(10, 10, np.random.default_rng(1))
    b = f.to_raw(10, 10, np.random.default_rng(1))
    assert a == b
    assert abs(a[0] - 10) < 0.5 and abs(a[1] - 10) < 0.5
    assert f.to_raw(10, 10) == (10, 10)  # không truyền rng thì không nhiễu
