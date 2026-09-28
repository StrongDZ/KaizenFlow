"""Dựng và chạy một replication."""
from __future__ import annotations

from dataclasses import dataclass, field

import numpy as np
import simpy

from sim_service.contract import ContractError, RunRequest
from sim_service.kpis import rep_kpis
from sim_service.nodes import ARCHETYPES
from sim_service.recorder import Recorder
from sim_service.transport import Transfer


@dataclass
class Ctx:
    env: simpy.Environment
    rng: np.random.Generator
    aux_rng: np.random.Generator
    rec: Recorder
    req: RunRequest
    warmup: float
    nodes: dict = field(default_factory=dict)
    pools: dict = field(default_factory=dict)
    edges: list = field(default_factory=list)

    def objects(self) -> list:
        return [*self.nodes.values(), *self.pools.values(), *self.edges]


@dataclass
class RepResult:
    rep: int
    kpis: dict
    series: dict
    intervals: dict
    tallies: dict
    signals: list
    events: list


def build(req: RunRequest, rep: int) -> Ctx:
    env = simpy.Environment()
    warm = req.warmup
    rec = Recorder(req.sim_start, record_from=warm, keep_raw=rep in req.outputs.raw_reps)
    ctx = Ctx(env, np.random.default_rng([req.seed, rep]), np.random.default_rng([req.seed, rep, 1]),
              rec, req, warm)
    for n in req.nodes:
        cls = ARCHETYPES.get(n.archetype)
        if cls is None:
            raise ContractError(n.key, f"archetype '{n.archetype}' not supported")
        ctx.nodes[n.key] = cls(ctx, n)
    for e in req.edges:
        ctx.nodes[e.src].mark_output_edge(e.material)
    ctx.edges = [Transfer(ctx, e) for e in req.edges]
    return ctx


def _sampler(ctx: Ctx):
    env = ctx.env
    yield env.timeout(ctx.warmup)
    while True:
        for o in ctx.objects():
            o.sample(env.now)
        yield env.timeout(ctx.req.outputs.sample_s)


def run_replication(req: RunRequest, rep: int = 0) -> RepResult:
    ctx = build(req, rep)
    for o in ctx.objects():
        o.start()
    ctx.env.process(_sampler(ctx))
    end = ctx.warmup + req.horizon_s
    ctx.env.run(until=end)
    ctx.rec.finalize(end)
    return RepResult(rep, rep_kpis(ctx), dict(ctx.rec.series), dict(ctx.rec.intervals),
                     dict(ctx.rec.tallies), ctx.rec.signals, ctx.rec.events)
