"""Lớp cơ sở cho node luồng + registry archetype."""
from __future__ import annotations

from collections import defaultdict

from sim_service.contract import ContractError, NodeSpec

ARCHETYPES: dict[str, type] = {}
INF = float("inf")


def register(archetype: str):
    def deco(cls):
        ARCHETYPES[archetype] = cls
        return cls
    return deco


class FlowNode:
    category = "nodes"

    def __init__(self, ctx, spec: NodeSpec):
        self.ctx = ctx
        self.key = spec.key
        self.p = spec.params
        self.reserved: dict[str, float] = defaultdict(float)
        self.claimed: dict[str, float] = defaultdict(float)

    @property
    def env(self):
        return self.ctx.env

    @property
    def rec(self):
        return self.ctx.rec

    def in_box(self, m):
        raise ContractError(self.key, f"does not accept '{m}'")

    def out_box(self, m):
        raise ContractError(self.key, f"does not produce '{m}'")

    def mark_output_edge(self, m) -> None:
        self.out_box(m)

    def available(self, m) -> float:
        return self.out_box(m).level - self.claimed[m]

    def room(self, m) -> float:
        b = self.in_box(m)
        return b.capacity - b.level - self.reserved[m]

    def wants(self, m, lot) -> bool:
        return self.room(m) >= lot

    def lot_for(self, m, default: int) -> int:
        return default

    def reserve(self, m, q):
        self.reserved[m] += q

    def unreserve(self, m, q):
        self.reserved[m] -= q

    def claim(self, m, q):
        self.claimed[m] += q

    def unclaim(self, m, q):
        self.claimed[m] -= q

    def take(self, m, q):
        yield self.out_box(m).get(q)
        self.on_take(m, q)

    def give(self, m, q):
        yield self.in_box(m).put(q)

    def on_take(self, m, q) -> None:
        pass

    def start(self) -> None:
        pass

    def sample(self, now) -> None:
        pass

    def kpi(self) -> dict:
        return {}
