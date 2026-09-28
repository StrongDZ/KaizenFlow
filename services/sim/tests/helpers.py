import json
from datetime import datetime, timedelta, timezone
from pathlib import Path

from sim_service.contract import (EdgeSpec, InitialState, Injection, NodeSpec, Outputs,
                                  PoolSpec, RunRequest)

SIM_START = datetime(2026, 10, 1, 8, 0, tzinfo=timezone(timedelta(hours=7)))
FIXTURES = Path(__file__).parent / "fixtures"


def make_request(nodes, edges=(), pools=(), *, horizon_s=3600.0, warmup_s=0.0, seed=1,
                 replications=1, raw_reps=(0,), sample_s=60.0, injections=()) -> RunRequest:
    return RunRequest(
        run_id=1, sim_start=SIM_START, horizon_s=horizon_s, replications=replications, seed=seed,
        nodes=[NodeSpec(**n) for n in nodes],
        edges=[EdgeSpec(**e) for e in edges],
        pools=[PoolSpec(**p) for p in pools],
        initial_state=InitialState(mode="WARMUP" if warmup_s else "EMPTY", warmup_s=warmup_s),
        injections=[Injection(**i) for i in injections],
        outputs=Outputs(raw_reps=list(raw_reps), sample_s=sample_s),
        recommend=False,
    )


def load_request(name: str, **update) -> RunRequest:
    data = json.loads((FIXTURES / f"{name}.json").read_text())
    data.update(update)
    return RunRequest.model_validate(data)


def at(seconds: float) -> datetime:
    return SIM_START + timedelta(seconds=seconds)
