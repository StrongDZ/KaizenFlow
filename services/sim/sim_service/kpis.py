def rep_kpis(ctx) -> dict:
    out = {"sources": {}, "storages": {}, "processes": {}, "sinks": {}, "pools": {}, "edges": {}}
    for o in ctx.objects():
        out[o.category][o.key] = o.kpi()
    out["throughput"] = sum(v["fulfilled"] for v in out["sinks"].values() if v["counts_throughput"])
    out["red_minutes"] = sum(v["red_s"] for v in out["storages"].values()) / 60.0
    out["backorder_end"] = sum(v["backorder_end"] for v in out["sinks"].values())
    out["backorder"] = out["backorder_end"]
    requested = out["throughput"] + out["backorder_end"]
    out["service_level"] = out["throughput"] / requested if requested > 0 else 1.0
    return out
