"""python -m sim_service.tools.freeze_golden → ghi KPI rep 0 của denso_mini làm mốc regression."""
import json
from pathlib import Path

from sim_service.contract import RunRequest
from sim_service.engine import run_replication

TESTS = Path(__file__).resolve().parents[2] / "tests"
FIXTURE_PATH = TESTS / "fixtures" / "denso_mini.json"
GOLDEN_PATH = TESTS / "golden" / "denso_mini_rep0.json"


def normalize(obj):
    if isinstance(obj, float):
        return round(obj, 6)
    if isinstance(obj, dict):
        return {str(k): normalize(v) for k, v in obj.items()}
    if isinstance(obj, (list, tuple)):
        return [normalize(v) for v in obj]
    return obj


def current() -> dict:
    req = RunRequest.model_validate(json.loads(FIXTURE_PATH.read_text()))
    return normalize(run_replication(req, 0).kpis)


def main() -> None:
    GOLDEN_PATH.parent.mkdir(parents=True, exist_ok=True)
    GOLDEN_PATH.write_text(json.dumps(current(), indent=2, sort_keys=True) + "\n")


if __name__ == "__main__":
    main()
