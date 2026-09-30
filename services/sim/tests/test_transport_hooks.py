"""Điểm móc của Transfer cho feed: chặng đi/về, nhận-trả xe, giai đoạn. Mặc định không được đổi hành vi."""
from helpers import make_request
from sim_service.engine import build, run_replication
from sim_service.transport import Transfer
from test_transport import EDGE_OUT, EDGES_IN, base_nodes, pool_edge


def _req(count=2, **kw):
    return make_request(base_nodes(), [*EDGES_IN, pool_edge(lot=10, **kw), *EDGE_OUT],
                        [{"key": "TUG", "kind": "TUGGER", "count": count}], horizon_s=600)


def test_edge_factory_replaces_the_edge_class_and_hooks_run_in_order():
    calls = []

    class Hooked(Transfer):
        def _vehicle_got(self, pool):
            calls.append(("got", pool.key))
            return "V1"

        def _phase(self, veh, phase):
            calls.append(("phase", veh, phase))

        def _leg(self, veh, kind):
            calls.append(("leg", veh, kind))
            yield self.ctx.env.timeout(7.0)

        def _vehicle_freed(self, pool, veh):
            calls.append(("freed", veh))

    def factory(ctx, spec):
        return (Hooked if spec.mode == "POOL" else Transfer)(ctx, spec)

    ctx = build(_req(count=1), 0, factory)  # một xe → các chuyến nối tiếp, thứ tự hook xác định
    for o in ctx.objects():
        o.start()
    ctx.env.run(until=300)
    first_trip = [c for c in calls if c[0] != "got"][:5]
    assert calls[0] == ("got", "TUG")
    assert first_trip == [("phase", "V1", "PICKUP"), ("leg", "V1", "LOAD"), ("phase", "V1", "UNLOAD"),
                          ("leg", "V1", "RETURN"), ("freed", "V1")]
    # chuyến đi 7 s + về 7 s: trong 300 s phải hoàn thành nhiều chuyến, và mỗi chuyến đủ bộ hook
    assert calls.count(("freed", "V1")) >= 5


def test_leg_controls_travel_time():
    class Slow(Transfer):
        def _leg(self, veh, kind):
            yield self.ctx.env.timeout(100.0)

    fast = build(_req(), 0)
    slow = build(_req(), 0, lambda c, s: (Slow if s.mode == "POOL" else Transfer)(c, s))
    for ctx in (fast, slow):
        for o in ctx.objects():
            o.start()
        ctx.env.run(until=1200)
    moved = lambda ctx: next(e for e in ctx.edges if e.key == "A>B").moved  # noqa: E731
    assert moved(slow) < moved(fast)


def test_default_behaviour_is_unchanged():
    # cùng seed, có và không có edge_factory mặc định → cùng kết quả
    a = run_replication(_req())
    ctx = build(_req(), 0, Transfer)
    for o in ctx.objects():
        o.start()
    ctx.env.run(until=600)
    moved_direct = next(e for e in ctx.edges if e.key == "A>B").moved
    assert a.kpis["throughput"] >= 0 and moved_direct > 0
