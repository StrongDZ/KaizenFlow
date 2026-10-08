"""Contract Go ↔ sim-service. Nguồn sinh contracts/run.schema.json."""
from __future__ import annotations

from datetime import datetime
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field

ENGINE_VERSION = "0.1.0"


class ContractError(ValueError):
    def __init__(self, key: str, message: str):
        super().__init__(f"{key}: {message}")
        self.key = key


class _Base(BaseModel):
    model_config = ConfigDict(extra="forbid")


class Material(_Base):
    code: str
    unit_load: int | None = None


class NodeSpec(_Base):
    key: str
    archetype: Literal["SOURCE", "STORAGE", "PROCESS", "SINK"]
    params: dict = Field(default_factory=dict)


class PoolSpec(_Base):
    key: str
    kind: Literal["AGV", "TUGGER", "FORKLIFT", "OPERATOR"]
    count: int = Field(ge=1)
    service: dict | None = None


class EdgeSpec(_Base):
    key: str
    src: str
    dst: str
    material: str
    mode: Literal["NONE", "CONVEYOR", "POOL"] = "NONE"
    pool: str | None = None
    hook_pool: str | None = None
    hook_at_load: bool = True
    hook_at_unload: bool = False
    travel: dict | None = None
    lot: int = Field(default=1, ge=1)
    max_in_transit: int | None = Field(default=None, ge=1)
    workers: int | None = Field(default=None, ge=1)
    poll_s: float = Field(default=5.0, gt=0)


class Injection(_Base):
    target: str
    kind: Literal["failure", "planned_stop"] = "failure"
    failure: str | None = None
    at_s: float = Field(ge=0)
    duration_s: float | None = Field(default=None, gt=0)


class InitialState(_Base):
    mode: Literal["EMPTY", "WARMUP"] = "WARMUP"
    warmup_s: float = Field(default=0.0, ge=0)


class Outputs(_Base):
    raw_reps: list[int] = Field(default_factory=lambda: [0])
    sample_s: float = Field(default=60.0, gt=0)
    sensors: bool = True


class RunRequest(_Base):
    run_id: int
    sim_start: datetime
    horizon_s: float = Field(gt=0)
    replications: int = Field(default=1, ge=1)
    seed: int = 0
    materials: list[Material] = Field(default_factory=list)
    nodes: list[NodeSpec]
    pools: list[PoolSpec] = Field(default_factory=list)
    edges: list[EdgeSpec] = Field(default_factory=list)
    initial_state: InitialState = Field(default_factory=InitialState)
    injections: list[Injection] = Field(default_factory=list)
    outputs: Outputs = Field(default_factory=Outputs)
    recommend: bool = True

    @property
    def warmup(self) -> float:
        return self.initial_state.warmup_s if self.initial_state.mode == "WARMUP" else 0.0


def _recipe_materials(node: NodeSpec, side: str) -> set[str]:
    recipes = node.params.get("recipes") or [{}]
    return {x["material"] for x in recipes[0].get(side, [])}


def validate_refs(req: RunRequest) -> None:
    nodes = {n.key: n for n in req.nodes}
    pools = {p.key for p in req.pools}
    if len(nodes) != len(req.nodes):
        raise ContractError("nodes", "duplicate node key")
    for n in req.nodes:
        if n.archetype == "PROCESS" and not n.params.get("recipes"):
            raise ContractError(n.key, "PROCESS needs at least one recipe")
    for e in req.edges:
        for end in (e.src, e.dst):
            if end not in nodes:
                raise ContractError(e.key, f"unknown node '{end}'")
        src, dst = nodes[e.src], nodes[e.dst]
        if src.archetype == "SINK":
            raise ContractError(e.key, "edge cannot leave a SINK")
        if dst.archetype == "SOURCE":
            raise ContractError(e.key, "edge cannot enter a SOURCE")
        if src.archetype == "PROCESS" and e.material not in _recipe_materials(src, "outputs"):
            raise ContractError(e.key, f"'{e.src}' does not produce '{e.material}'")
        if dst.archetype == "PROCESS" and e.material not in _recipe_materials(dst, "inputs"):
            raise ContractError(e.key, f"'{e.dst}' does not consume '{e.material}'")
        if e.mode == "POOL" and e.pool not in pools:
            raise ContractError(e.key, f"unknown pool '{e.pool}'")
        if e.hook_pool is not None and e.hook_pool not in pools:
            raise ContractError(e.key, f"unknown hook pool '{e.hook_pool}'")
    for inj in req.injections:
        n = nodes.get(inj.target)
        if n is None or n.archetype != "PROCESS":
            raise ContractError(inj.target, "injection target must be a PROCESS")
        if inj.kind == "failure":
            codes = {m["code"] for m in n.params.get("failure_modes", [])}
            if inj.failure not in codes:
                raise ContractError(inj.target, f"unknown failure mode '{inj.failure}'")
        elif inj.duration_s is None:
            raise ContractError(inj.target, "planned_stop needs duration_s")
    from sim_service.engine import build  # import muộn: engine phụ thuộc contract
    build(req, 0)  # dựng thử model → mọi lỗi tham số lộ ra ở đây (API trả 422)


def apply_overrides(req: RunRequest, overrides: list[dict]) -> RunRequest:
    """overrides: [{target, path, value}]. Node: path tính trong params; pool/edge: trong object."""
    data = req.model_dump(mode="json")
    index: dict[str, dict] = {}
    for n in data["nodes"]:
        index[n["key"]] = n["params"]
    for p in data["pools"]:
        index[p["key"]] = p
    for e in data["edges"]:
        index[e["key"]] = e
    for o in overrides:
        base = index.get(o["target"])
        if base is None:
            raise ContractError(o["target"], "unknown override target")
        parts = [p for p in o["path"].split("/") if p]
        if not parts:
            raise ContractError(o["target"], "empty override path")
        cur = base
        for part in parts[:-1]:
            if isinstance(cur, list):
                try:
                    idx = int(part)
                    cur = cur[idx]
                except (ValueError, IndexError):
                    raise ContractError(o["target"], f"invalid list index '{part}' in override path") from None
            elif isinstance(cur, dict):
                cur = cur.setdefault(part, {})
            else:
                raise ContractError(o["target"], f"override path cannot traverse '{part}'")
        leaf = parts[-1]
        if isinstance(cur, list):
            try:
                cur[int(leaf)] = o["value"]
            except (ValueError, IndexError):
                raise ContractError(o["target"], f"invalid list index '{leaf}' in override path") from None
        elif isinstance(cur, dict):
            cur[leaf] = o["value"]
        else:
            raise ContractError(o["target"], f"override path cannot set '{leaf}'")
    return RunRequest.model_validate(data)
