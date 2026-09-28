import json

from sim_service.tools.freeze_golden import GOLDEN_PATH, current


def test_denso_mini_sanity():
    k = current()
    assert 20 <= k["throughput"] <= 60
    assert k["processes"]["STAMP_3"]["state_s"]["DOWN"] > 0
    assert 0.3 <= k["processes"]["STAMP_1"]["util"] <= 1.0
    assert k["pools"]["OPS_ZONE_B"]["util"] > 0
    assert k["edges"]["KHO_NVL>STAMP_1"]["wait_hook_mean"] >= 0


def test_denso_mini_matches_golden():
    assert current() == json.loads(GOLDEN_PATH.read_text())
