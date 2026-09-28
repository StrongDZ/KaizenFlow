"""python -m sim_service.tools.export_schema → ghi contracts/run.schema.json"""
import json
from pathlib import Path

from sim_service.contract import RunRequest

SCHEMA_PATH = Path(__file__).resolve().parents[4] / "contracts" / "run.schema.json"


def render() -> str:
    return json.dumps(RunRequest.model_json_schema(), indent=2, sort_keys=True) + "\n"


def main() -> None:
    SCHEMA_PATH.parent.mkdir(parents=True, exist_ok=True)
    SCHEMA_PATH.write_text(render())


if __name__ == "__main__":
    main()
