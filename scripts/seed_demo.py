#!/usr/bin/env python3
"""Dựng mô hình demo `denso-mini` + scenario "Máy dập 3 hỏng" qua Go API. Idempotent.

Chạy: python3 scripts/seed_demo.py [--api http://localhost:8080]
"""
import argparse
import json
import sys
import urllib.error
import urllib.request

MODEL_KEY = "denso-mini"

# (key, node_type, cột, hàng, params)
NODES = [
    ("SUPPLIER", "DOCK_IN", 0, 0, {"lots": [{"material": "RAW-01", "qty": 150}]}),
    ("KHO_NVL", "RACK_WAREHOUSE", 1, 0, {"stock": [{"material": "RAW-01", "initial": 300, "max": 1000}],
                                         "coverage_thresholds": {"red_h": 0.5, "yellow_low_h": 1, "yellow_high_h": 5}}),
    ("STAMP_1", "STAMP_PRESS", 2, -1, None),
    ("STAMP_2", "STAMP_PRESS", 2, 0, None),
    ("STAMP_3", "STAMP_PRESS", 2, 1, None),
    ("WIP_BUF", "WIP_BUFFER", 3, 0, {"stock": [{"material": "PART", "initial": 60, "max": 400}]}),
    ("ASSY", "ASSEMBLY_CELL", 4, 0, None),
    ("QC", "AOI", 5, 0, None),
    ("PACKING", "PACKING", 6, 0, None),
    ("SCRAP", "SCRAP", 6, 1, {}),
    ("FG", "RACK_WAREHOUSE", 7, 0, {"stock": [{"material": "BOX", "initial": 6, "max": 60}],
                                    "coverage_thresholds": {"red_h": 0.5, "yellow_low_h": 1.5, "yellow_high_h": 6}}),
    ("SHIP", "SHIP_DOCK", 8, 0, {"demand": [{"kind": "TAKT", "material": "BOX", "takt": {"dist": "exp", "mean": 330}}]}),
    ("TUGGER_A", "TUGGER", 1, 2, {}),
    ("OPS_ZONE_B", "HOOK_OPERATOR", 2, 2, {}),
]

RECIPES = {
    "STAMP_1": ([("RAW-01", 1)], [("PART", 1, "OK")]),
    "STAMP_2": ([("RAW-01", 1)], [("PART", 1, "OK")]),
    "STAMP_3": ([("RAW-01", 1)], [("PART", 1, "OK")]),
    "ASSY": ([("PART", 2)], [("SUB", 1, "OK")]),
    "QC": ([("SUB", 1)], [("SUB_OK", 1, "OK"), ("SUB_NG", 1, "NG")]),
    "PACKING": ([("SUB_OK", 10)], [("BOX", 1, "OK")]),
}

TUGGER = {"mode": "POOL", "pool": "TUGGER_A", "hook_pool": "OPS_ZONE_B", "lot": 20,
          "travel": {"dist": "norm", "mean": 90, "sd": 15}}

EDGES = [
    ("SUPPLIER", "KHO_NVL", "RAW-01", {"lot": 150}),
    *[("KHO_NVL", f"STAMP_{i}", "RAW-01", TUGGER) for i in (1, 2, 3)],
    *[(f"STAMP_{i}", "WIP_BUF", "PART", {}) for i in (1, 2, 3)],
    ("WIP_BUF", "ASSY", "PART", {"lot": 2}),
    ("ASSY", "QC", "SUB", {}),
    ("QC", "PACKING", "SUB_OK", {}),
    ("QC", "SCRAP", "SUB_NG", {}),
    ("PACKING", "FG", "BOX", {}),
    ("FG", "SHIP", "BOX", {}),
]

SCENARIO = {"name": "Máy dập 3 hỏng (RUL ≈ 2 giờ)", "horizon_s": 14400, "replications": 20, "start_state": "WARMUP",
            "injections": [{"target": "STAMP_3", "failure": "bearing_wear", "at_s": 7200}], "overrides": []}


def call(api, method, path, body=None):
    req = urllib.request.Request(api + path, method=method, headers={"Content-Type": "application/json"},
                                 data=None if body is None else json.dumps(body).encode())
    try:
        with urllib.request.urlopen(req) as r:
            raw = r.read()
            return json.loads(raw) if raw else None
    except urllib.error.HTTPError as e:
        sys.exit(f"{method} {path} → {e.code}: {e.read().decode()}")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--api", default="http://localhost:8080")
    api = ap.parse_args().api.rstrip("/")
    for m in call(api, "GET", "/api/models"):
        if m["model_key"] == MODEL_KEY:
            print(f"'{MODEL_KEY}' đã có: version {m['latest_version_id']} ({m['status']}) — bỏ qua.")
            print(f"Mở http://localhost:5173/versions/{m['latest_version_id']}/scenarios")
            return
    vid = call(api, "POST", "/api/models", {"model_key": MODEL_KEY})["version_id"]
    nodes = []
    for key, typ, col, row, params in NODES:
        p = dict(params or {})
        if key in RECIPES:
            ins, outs = RECIPES[key]
            p["recipes"] = [{"inputs": [{"material": m, "qty": q} for m, q in ins],
                             "outputs": [{"material": m, "qty": q, "port": port} for m, q, port in outs]}]
        nodes.append({"key": key, "node_type": typ, "params": p, "canvas_pos": {"x": 40 + col * 220, "y": 200 + row * 150}})
    edges = [{"key": f"{s}>{d}", "src": s, "dst": d, "material": m, "params": p} for s, d, m, p in EDGES]
    call(api, "PUT", f"/api/versions/{vid}/graph", {"nodes": nodes, "edges": edges})
    call(api, "POST", f"/api/versions/{vid}/publish")
    sid = call(api, "POST", "/api/scenarios", {"model_version_id": vid, **SCENARIO})["id"]
    print(f"Đã tạo '{MODEL_KEY}' version {vid} (PUBLISHED) và scenario {sid}.")
    print(f"Mở http://localhost:5173/versions/{vid}/scenarios rồi bấm Chạy.")


if __name__ == "__main__":
    main()
