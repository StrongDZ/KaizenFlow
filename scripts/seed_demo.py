#!/usr/bin/env python3
"""Dựng hai mô hình demo qua Go API. Idempotent (mô hình đã có thì bỏ qua).

- `denso-mini`: một dây chuyền thẳng, 3 máy dập song song chung một kho, scenario "Máy dập 3 hỏng".
- `denso-plant`: nhà máy nhiều kho nối nhiều máy (không 1-1): 2 kho nguyên liệu nuôi 4 máy dập (có máy lấy từ cả hai kho,
  có máy cần hai loại nguyên liệu từ hai kho), 2 buffer WIP dùng chung, 2 cell lắp, 2 trạm đóng gói, 2 kho thành phẩm
  và 2 cửa xuất chéo nhau; hai đội xe kéo, mỗi đội một người móc kéo.

Chạy: python3 scripts/seed_demo.py [--api http://localhost:8080]
"""
import argparse
import json
import sys
import urllib.error
import urllib.request

# (key, node_type, cột, hàng, params[, tên hiển thị])
MINI_NODES = [
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

MINI_RECIPES = {
    "STAMP_1": ([("RAW-01", 1)], [("PART", 1, "OK")]),
    "STAMP_2": ([("RAW-01", 1)], [("PART", 1, "OK")]),
    "STAMP_3": ([("RAW-01", 1)], [("PART", 1, "OK")]),
    "ASSY": ([("PART", 2)], [("SUB", 1, "OK")]),
    "QC": ([("SUB", 1)], [("SUB_OK", 1, "OK"), ("SUB_NG", 1, "NG")]),
    "PACKING": ([("SUB_OK", 10)], [("BOX", 1, "OK")]),
}

MINI_TUGGER = {"mode": "POOL", "pool": "TUGGER_A", "hook_pool": "OPS_ZONE_B", "lot": 20,
          "travel": {"dist": "norm", "mean": 90, "sd": 15}}

MINI_EDGES = [
    ("SUPPLIER", "KHO_NVL", "RAW-01", {"lot": 150}),
    *[("KHO_NVL", f"STAMP_{i}", "RAW-01", MINI_TUGGER) for i in (1, 2, 3)],
    *[(f"STAMP_{i}", "WIP_BUF", "PART", {}) for i in (1, 2, 3)],
    ("WIP_BUF", "ASSY", "PART", {"lot": 2}),
    ("ASSY", "QC", "SUB", {}),
    ("QC", "PACKING", "SUB_OK", {}),
    ("QC", "SCRAP", "SUB_NG", {}),
    ("PACKING", "FG", "BOX", {}),
    ("FG", "SHIP", "BOX", {}),
]

MINI_SCENARIO = {"name": "Máy dập 3 hỏng (RUL ≈ 2 giờ)", "horizon_s": 14400, "replications": 20, "start_state": "WARMUP",
            "injections": [{"target": "STAMP_3", "failure": "bearing_wear", "at_s": 7200}], "overrides": []}


def tug(pool, ops):
    return {"mode": "POOL", "pool": pool, "hook_pool": ops, "lot": 20, "travel": {"dist": "norm", "mean": 90, "sd": 15}}


def thresholds(low=1, high=5):
    return {"red_h": 0.5, "yellow_low_h": low, "yellow_high_h": high}


PLANT_NODES = [
    ("SUP_A", "DOCK_IN", 0, -1, {"lots": [{"material": "RAW-01", "qty": 150}]}, "Nhà cung cấp A"),
    ("SUP_B", "DOCK_IN", 0, 1, {"lots": [{"material": "RAW-02", "qty": 100}]}, "Nhà cung cấp B"),
    ("KHO_A", "RACK_WAREHOUSE", 1, -1, {"stock": [{"material": "RAW-01", "initial": 300, "max": 1000}],
                                        "coverage_thresholds": thresholds()}, "Kho NVL A"),
    ("KHO_B", "RACK_WAREHOUSE", 1, 1, {"stock": [{"material": "RAW-01", "initial": 150, "max": 600},
                                                 {"material": "RAW-02", "initial": 200, "max": 800}],
                                       "coverage_thresholds": thresholds()}, "Kho NVL B"),
    ("STAMP_1", "STAMP_PRESS", 2, -1.5, None, "Máy dập 1"),
    ("STAMP_2", "STAMP_PRESS", 2, -0.5, None, "Máy dập 2"),
    ("STAMP_4", "STAMP_PRESS", 2, 0.5, None, "Máy dập 4"),
    ("STAMP_3", "STAMP_PRESS", 2, 1.5, None, "Máy dập 3"),
    ("WIP_1", "WIP_BUFFER", 3, -0.75, {"stock": [{"material": "PART", "initial": 40, "max": 300}]}, "Buffer WIP 1"),
    ("WIP_2", "WIP_BUFFER", 3, 0.75, {"stock": [{"material": "PART", "initial": 40, "max": 300}]}, "Buffer WIP 2"),
    ("ASSY_1", "ASSEMBLY_CELL", 4, -0.75, None, "Cell lắp ráp 1"),
    ("ASSY_2", "ASSEMBLY_CELL", 4, 0.75, None, "Cell lắp ráp 2"),
    ("QC", "AOI", 5, 0, None, "Kiểm tra AOI"),
    ("PACK_1", "PACKING", 6, -0.75, None, "Đóng gói 1"),
    ("PACK_2", "PACKING", 6, 0.75, None, "Đóng gói 2"),
    ("SCRAP", "SCRAP", 6, 2, {}, "Phế phẩm"),
    ("FG_1", "RACK_WAREHOUSE", 7, -0.75, {"stock": [{"material": "BOX", "initial": 14, "max": 60}],
                                          "coverage_thresholds": thresholds(1.5, 6)}, "Kho thành phẩm 1"),
    ("FG_2", "RACK_WAREHOUSE", 7, 0.75, {"stock": [{"material": "BOX", "initial": 14, "max": 60}],
                                         "coverage_thresholds": thresholds(1.5, 6)}, "Kho thành phẩm 2"),
    ("SHIP_1", "SHIP_DOCK", 8, -0.75, {"demand": [{"kind": "TAKT", "material": "BOX", "takt": {"dist": "exp", "mean": 540}}]},
     "Cửa xuất 1"),
    ("SHIP_2", "SHIP_DOCK", 8, 0.75, {"demand": [{"kind": "TAKT", "material": "BOX", "takt": {"dist": "exp", "mean": 540}}]},
     "Cửa xuất 2"),
    ("TUG_A", "TUGGER", 1, 3, {}, "Xe kéo A"),
    ("OPS_A", "HOOK_OPERATOR", 2, 3, {}, "Người móc kéo A"),
    ("TUG_B", "TUGGER", 3, 3, {}, "Xe kéo B"),
    ("OPS_B", "HOOK_OPERATOR", 4, 3, {}, "Người móc kéo B"),
]

PLANT_RECIPES = {
    "STAMP_1": ([("RAW-01", 1)], [("PART", 1, "OK")]),
    "STAMP_2": ([("RAW-01", 1), ("RAW-02", 1)], [("PART", 1, "OK")]),  # cần cả hai loại, từ hai kho
    "STAMP_3": ([("RAW-02", 1)], [("PART", 1, "OK")]),
    "STAMP_4": ([("RAW-01", 1)], [("PART", 1, "OK")]),
    "ASSY_1": ([("PART", 2)], [("SUB", 1, "OK")]),
    "ASSY_2": ([("PART", 2)], [("SUB", 1, "OK")]),
    "QC": ([("SUB", 1)], [("SUB_OK", 1, "OK"), ("SUB_NG", 1, "NG")]),
    "PACK_1": ([("SUB_OK", 10)], [("BOX", 1, "OK")]),
    "PACK_2": ([("SUB_OK", 10)], [("BOX", 1, "OK")]),
}

TUG_A, TUG_B = tug("TUG_A", "OPS_A"), tug("TUG_B", "OPS_B")

PLANT_EDGES = [
    ("SUP_A", "KHO_A", "RAW-01", {"lot": 150}),
    ("SUP_A", "KHO_B", "RAW-01", {"lot": 150}),
    ("SUP_B", "KHO_B", "RAW-02", {"lot": 100}),
    # Kho A nuôi 3 máy; kho B nuôi 3 máy; máy 2 và 4 lấy từ cả hai kho, máy 2 còn cần RAW-02 từ kho B.
    ("KHO_A", "STAMP_1", "RAW-01", TUG_A),
    ("KHO_A", "STAMP_2", "RAW-01", TUG_A),
    ("KHO_A", "STAMP_4", "RAW-01", TUG_A),
    ("KHO_B", "STAMP_2", "RAW-01", TUG_B),
    ("KHO_B", "STAMP_2", "RAW-02", TUG_B),
    ("KHO_B", "STAMP_3", "RAW-02", TUG_B),
    ("KHO_B", "STAMP_4", "RAW-01", TUG_B),
    # Máy 2 đổ vào cả hai buffer; buffer 2 nhận từ 3 máy.
    ("STAMP_1", "WIP_1", "PART", {}),
    ("STAMP_2", "WIP_1", "PART", {}),
    ("STAMP_2", "WIP_2", "PART", {}),
    ("STAMP_3", "WIP_2", "PART", {}),
    ("STAMP_4", "WIP_2", "PART", {}),
    ("WIP_1", "ASSY_1", "PART", {"lot": 2}),
    ("WIP_2", "ASSY_1", "PART", {"lot": 2}),
    ("WIP_2", "ASSY_2", "PART", {"lot": 2}),
    ("ASSY_1", "QC", "SUB", {}),
    ("ASSY_2", "QC", "SUB", {}),
    ("QC", "PACK_1", "SUB_OK", {}),
    ("QC", "PACK_2", "SUB_OK", {}),
    ("QC", "SCRAP", "SUB_NG", {}),
    ("PACK_1", "FG_1", "BOX", {}),
    ("PACK_2", "FG_1", "BOX", {}),
    ("PACK_2", "FG_2", "BOX", {}),
    ("FG_1", "SHIP_1", "BOX", {}),
    ("FG_1", "SHIP_2", "BOX", {}),
    ("FG_2", "SHIP_2", "BOX", {}),
]

PLANT_SCENARIOS = [
    {"name": "Nền (không sự cố)", "horizon_s": 14400, "replications": 20, "start_state": "WARMUP", "injections": [], "overrides": []},
    {"name": "Máy dập 2 hỏng sau 30 phút", "horizon_s": 14400, "replications": 20, "start_state": "WARMUP",
     "injections": [{"target": "STAMP_2", "failure": "bearing_wear", "at_s": 1800}], "overrides": []},
    {"name": "Kho B chỉ còn 1 xe kéo", "horizon_s": 14400, "replications": 20, "start_state": "WARMUP",
     "injections": [], "overrides": [{"target": "TUG_B", "path": "/count", "value": 1}]},
]

# Vật tư ngoài bộ mặc định của denso-mini.
EXTRA_MATERIALS = [{"code": "RAW-02", "name": "RAW-02", "unit": "pcs"}]

MODELS = [
    {"key": "denso-mini", "grid": (40, 220, 200, 150), "nodes": MINI_NODES, "recipes": MINI_RECIPES, "edges": MINI_EDGES, "scenarios": [MINI_SCENARIO]},
    {"key": "denso-plant", "grid": (40, 230, 300, 130), "nodes": PLANT_NODES, "recipes": PLANT_RECIPES, "edges": PLANT_EDGES, "scenarios": PLANT_SCENARIOS},
]


def call(api, method, path, body=None):
    req = urllib.request.Request(api + path, method=method, headers={"Content-Type": "application/json"},
                                 data=None if body is None else json.dumps(body).encode())
    try:
        with urllib.request.urlopen(req) as r:
            raw = r.read()
            return json.loads(raw) if raw else None
    except urllib.error.HTTPError as e:
        sys.exit(f"{method} {path} → {e.code}: {e.read().decode()}")


def edge_rows(edges):
    """Khoá edge là src>dst; hai edge cùng cặp (khác vật tư) thêm #2, #3 như Editor."""
    seen, rows = {}, []
    for src, dst, material, params in edges:
        base = f"{src}>{dst}"
        seen[base] = seen.get(base, 0) + 1
        key = base if seen[base] == 1 else f"{base}#{seen[base]}"
        rows.append({"key": key, "src": src, "dst": dst, "material": material, "params": params})
    return rows


def node_rows(model):
    x0, dx, y0, dy = model["grid"]
    rows = []
    for key, typ, col, row, params, *name in model["nodes"]:
        p = dict(params or {})
        if key in model["recipes"]:
            ins, outs = model["recipes"][key]
            p["recipes"] = [{"inputs": [{"material": m, "qty": q} for m, q in ins],
                             "outputs": [{"material": m, "qty": q, "port": port} for m, q, port in outs]}]
        node = {"key": key, "node_type": typ, "params": p, "canvas_pos": {"x": int(x0 + col * dx), "y": int(y0 + row * dy)}}
        if name:
            node["name"] = name[0]
        rows.append(node)
    return rows


def seed_model(api, model, existing):
    key = model["key"]
    if key in existing:
        m = existing[key]
        print(f"'{key}' đã có: version {m['latest_version_id']} ({m['status']}) — bỏ qua.")
        print(f"Mở http://localhost:5173/versions/{m['latest_version_id']}/scenarios")
        return
    vid = call(api, "POST", "/api/models", {"model_key": key})["version_id"]
    call(api, "PUT", f"/api/versions/{vid}/graph", {"nodes": node_rows(model), "edges": edge_rows(model["edges"])})
    call(api, "POST", f"/api/versions/{vid}/publish")
    ids = [call(api, "POST", "/api/scenarios", {"model_version_id": vid, **sc})["id"] for sc in model["scenarios"]]
    print(f"Đã tạo '{key}' version {vid} (PUBLISHED), scenario {', '.join(map(str, ids))}.")
    print(f"Mở http://localhost:5173/versions/{vid}/scenarios rồi bấm Chạy.")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--api", default="http://localhost:8080")
    api = ap.parse_args().api.rstrip("/")
    have = {m["code"] for m in call(api, "GET", "/api/materials")}
    for mat in EXTRA_MATERIALS:
        if mat["code"] not in have:
            call(api, "POST", "/api/materials", mat)
    existing = {m["model_key"]: m for m in call(api, "GET", "/api/models")}
    for model in MODELS:
        seed_model(api, model, existing)


if __name__ == "__main__":
    main()
