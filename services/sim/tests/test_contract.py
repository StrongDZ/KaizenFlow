import pytest
from pydantic import ValidationError

from helpers import make_request
from sim_service.contract import ContractError, RunRequest, apply_overrides, validate_refs
from sim_service.tools.export_schema import SCHEMA_PATH, render

SRC = {"key": "SRC", "archetype": "SOURCE", "params": {"lots": [{"material": "X", "qty": 1}]}}
BUF = {"key": "BUF", "archetype": "STORAGE", "params": {"stock": [{"material": "X", "max": 10}]}}
PROC = {"key": "M", "archetype": "PROCESS", "params": {
    "recipes": [{"inputs": [{"material": "X", "qty": 1}], "outputs": [{"material": "Y", "qty": 1}]}],
    "failure_modes": [{"code": "wear"}]}}
OUT = {"key": "OUT", "archetype": "SINK", "params": {}}
POOLS = [{"key": "TUG", "kind": "TUGGER", "count": 2}]


def test_valid_request_passes():
    req = make_request([SRC, BUF, OUT], [
        {"key": "SRC>BUF", "src": "SRC", "dst": "BUF", "material": "X"},
        {"key": "BUF>OUT", "src": "BUF", "dst": "OUT", "material": "X", "mode": "POOL", "pool": "TUG"}],
        POOLS)
    validate_refs(req)
    assert req.warmup == 0.0


def test_pool_kinds_include_agv_and_amr():
    for kind in ("AGV", "AMR", "TUGGER", "FORKLIFT", "OPERATOR"):
        req = make_request([SRC, BUF, OUT], [], [{"key": "P", "kind": kind, "count": 1}])
        assert req.pools[0].kind == kind
    with pytest.raises(ValidationError):
        make_request([SRC, BUF, OUT], [], [{"key": "P", "kind": "DRONE", "count": 1}])


def test_extra_field_rejected():
    with pytest.raises(ValidationError):
        RunRequest.model_validate({"run_id": 1, "sim_start": "2026-10-01T08:00:00+07:00",
                                   "horizon_s": 10, "nodes": [], "bogus": 1})


def test_unknown_node_reports_edge_key():
    req = make_request([SRC], [{"key": "SRC>NOPE", "src": "SRC", "dst": "NOPE", "material": "X"}])
    with pytest.raises(ContractError) as e:
        validate_refs(req)
    assert e.value.key == "SRC>NOPE"


def test_pool_mode_requires_known_pool():
    req = make_request([SRC, OUT], [{"key": "e", "src": "SRC", "dst": "OUT", "material": "X", "mode": "POOL"}])
    with pytest.raises(ContractError) as e:
        validate_refs(req)
    assert e.value.key == "e"


def test_process_edge_material_must_match_recipe():
    req = make_request([SRC, PROC], [{"key": "e", "src": "SRC", "dst": "M", "material": "Z"}])
    with pytest.raises(ContractError) as e:
        validate_refs(req)
    assert e.value.key == "e"


def test_injection_needs_known_failure_mode():
    req = make_request([PROC], injections=[{"target": "M", "failure": "nope", "at_s": 10}])
    with pytest.raises(ContractError) as e:
        validate_refs(req)
    assert e.value.key == "M"


def test_planned_stop_needs_duration():
    req = make_request([PROC], injections=[{"target": "M", "kind": "planned_stop", "at_s": 10}])
    with pytest.raises(ContractError):
        validate_refs(req)


def test_apply_overrides_pool_and_nested_node_param():
    req = make_request([SRC, BUF, OUT], pools=POOLS)
    out = apply_overrides(req, [
        {"target": "TUG", "path": "/count", "value": 3},
        {"target": "BUF", "path": "/replenish/rop", "value": 7}])
    assert out.pools[0].count == 3
    assert out.nodes[1].params["replenish"]["rop"] == 7
    assert req.pools[0].count == 2  # bản gốc không đổi


def test_apply_overrides_unknown_target():
    req = make_request([SRC])
    with pytest.raises(ContractError) as e:
        apply_overrides(req, [{"target": "GHOST", "path": "/count", "value": 1}])
    assert e.value.key == "GHOST"


def test_schema_file_up_to_date():
    assert SCHEMA_PATH.read_text() == render()
