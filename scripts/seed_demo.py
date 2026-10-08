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
import os
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
EXTRA_MATERIALS = [
    {"code": "RAW-02", "name": "RAW-02", "unit": "pcs"},
    {"code": "BIMBO-01", "name": "Bimbo SKU 01", "unit": "pcs"},
    {"code": "BIMBO-02", "name": "Bimbo SKU 02", "unit": "pcs"},
    {"code": "BIMBO-03", "name": "Bimbo SKU 03", "unit": "pcs"},
    {"code": "CASE-01", "name": "Case SKU 01", "unit": "case"},
    {"code": "CASE-02", "name": "Case SKU 02", "unit": "case"},
    {"code": "CASE-03", "name": "Case SKU 03", "unit": "case"},
]

# Bản đồ AGV v2: toạ độ tính bằng mét (y hướng xuống), làn là đường gấp khúc (`path` là các điểm uốn giữa hai đầu), xe 1,2 m/s.
# Hình dạng tự nhiên: hành lang trên chạy xiên xuống phía đông, hành lang dưới chạy lên phía tây, trạm máy thò xuống giữa hai hành lang,
# đầu đông phình ra. Topology là mạng vòng một chiều nên xe không tự kẹt cứng.
def _lanes(pairs, paths=None, capacity=2):
    paths = paths or {}
    out = []
    for i, (a, b) in enumerate(pairs):
        lane = {"id": f"L{i + 1:02d}", "from": a, "to": b, "capacity": capacity}
        if (a, b) in paths:
            lane["path"] = [{"x": x, "y": y} for x, y in paths[(a, b)]]
        out.append(lane)
    return out


def _pt(pid, x, y, kind="junction", node=None):
    p = {"id": pid, "x": x, "y": y, "kind": kind}
    if node:
        p["node_key"] = node
    return p


MINI_MAP = {
    "v": 2, "speed_mps": 1.2,
    "points": [_pt("KHO", 8, 12, "station", "KHO_NVL"), _pt("J1", 30, 8), _pt("J2", 54, 13), _pt("J3", 78, 22), _pt("NE", 96, 34),
               _pt("SE", 92, 56), _pt("B3", 72, 56), _pt("B2", 50, 50), _pt("B1", 28, 46), _pt("SW", 8, 48),
               _pt("S1", 30, 27, "station", "STAMP_1"), _pt("S2", 53, 31, "station", "STAMP_2"), _pt("S3", 76, 40, "station", "STAMP_3")],
    "lanes": _lanes(
        [("KHO", "J1"), ("J1", "J2"), ("J2", "J3"), ("J3", "NE"), ("NE", "SE"), ("SE", "B3"), ("B3", "B2"), ("B2", "B1"),
         ("B1", "SW"), ("SW", "KHO"), ("J1", "S1"), ("S1", "B1"), ("J2", "S2"), ("S2", "B2"), ("J3", "S3"), ("S3", "B3")],
        {("KHO", "J1"): [(19, 9)], ("J1", "J2"): [(42, 9)], ("J2", "J3"): [(66, 16)], ("J3", "NE"): [(88, 27)], ("NE", "SE"): [(98, 46)],
         ("SE", "B3"): [(82, 58)], ("B3", "B2"): [(61, 54)], ("B2", "B1"): [(39, 49)], ("B1", "SW"): [(18, 48)], ("SW", "KHO"): [(4, 30)],
         ("S1", "B1"): [(29, 37)], ("S2", "B2"): [(51, 41)], ("S3", "B3"): [(75, 48)]}),
}

PLANT_MAP = {
    "v": 2, "speed_mps": 1.2,
    "points": [_pt("KHO_A", 8, 10, "station", "KHO_A"), _pt("KHO_B", 6, 52, "station", "KHO_B"),
               _pt("J1", 30, 6), _pt("J2", 54, 12), _pt("J3", 76, 22), _pt("NE", 94, 36), _pt("SE", 90, 62),
               _pt("B3", 70, 56), _pt("B2", 48, 48), _pt("B1", 26, 46),
               _pt("S1", 32, 27, "station", "STAMP_1"), _pt("S2", 52, 29, "station", "STAMP_2"),
               _pt("S4", 75, 40, "station", "STAMP_4"), _pt("S3", 100, 50, "station", "STAMP_3")],
    "lanes": _lanes(
        [("KHO_A", "J1"), ("J1", "J2"), ("J2", "J3"), ("J3", "NE"), ("NE", "S3"), ("S3", "SE"), ("SE", "B3"),
         ("B3", "B2"), ("B2", "B1"), ("B1", "KHO_B"), ("KHO_B", "KHO_A"),
         ("J1", "S1"), ("S1", "B1"), ("J2", "S2"), ("S2", "B2"), ("J3", "S4"), ("S4", "B3")],
        {("KHO_A", "J1"): [(18, 6)], ("J1", "J2"): [(42, 7)], ("J2", "J3"): [(66, 14)], ("J3", "NE"): [(86, 28)], ("NE", "S3"): [(98, 41)],
         ("S3", "SE"): [(98, 58)], ("SE", "B3"): [(80, 61)], ("B3", "B2"): [(59, 54)], ("B2", "B1"): [(37, 49)], ("B1", "KHO_B"): [(14, 50)],
         ("KHO_B", "KHO_A"): [(2, 31)], ("S1", "B1"): [(28, 36)], ("J2", "S2"): [(53, 20)], ("S2", "B2"): [(50, 40)],
         ("J3", "S4"): [(76, 31)], ("S4", "B3"): [(72, 49)]}),
}

# Bản denso-plant với xe B là AMR (tự hành: FMS điều xe rảnh gần nhất, xe ở lại điểm trả hàng, có pin) và một chỗ sạc giữa hai làn dưới.
# Mô phỏng dự báo không đổi (kind chỉ ảnh hưởng cách feed cho xe chạy), nên chạy cùng kịch bản để so với denso-plant.
PLANT_AMR_NODES = [(k, t, c, r, {"kind": "AMR"} if k == "TUG_B" else p, *(["AMR kho B"] if k == "TUG_B" else rest))
                   for k, t, c, r, p, *rest in PLANT_NODES]
PLANT_AMR_MAP = {
    **PLANT_MAP,
    "points": [*PLANT_MAP["points"], _pt("CH", 38, 60, "charger")],
    "lanes": [*PLANT_MAP["lanes"], {"id": "L18", "from": "B2", "to": "CH", "capacity": 2}, {"id": "L19", "from": "CH", "to": "B1", "capacity": 2}],
}

FMCG_NODES = [
    ("SUP_FMCG", "DOCK_IN", 0, 0, {"lots": [
        {"material": "BIMBO-01", "qty": 480},
        {"material": "BIMBO-02", "qty": 420},
        {"material": "BIMBO-03", "qty": 400},
    ]}, "Nhà cung cấp FMCG"),
    ("DC_MAIN", "RACK_WAREHOUSE", 1, 0, {"stock": [
        {"material": "BIMBO-01", "initial": 1200, "max": 4200},
        {"material": "BIMBO-02", "initial": 950, "max": 3600},
        {"material": "BIMBO-03", "initial": 900, "max": 3400},
    ], "coverage_thresholds": {"red_h": 4, "yellow_low_h": 8, "yellow_high_h": 48}}, "Kho trung tâm FMCG"),
    ("PACK_A", "PACKING", 2, -1, None, "Line đóng gói A"),
    ("PACK_B", "PACKING", 2, 0, None, "Line đóng gói B"),
    ("PACK_C", "PACKING", 2, 1, None, "Line đóng gói C"),
    ("FG_A", "RACK_WAREHOUSE", 3, -1, {"stock": [{"material": "CASE-01", "initial": 180, "max": 1200}],
                                        "coverage_thresholds": {"red_h": 2, "yellow_low_h": 6, "yellow_high_h": 36}}, "Kho thành phẩm A"),
    ("FG_B", "RACK_WAREHOUSE", 3, 0, {"stock": [{"material": "CASE-02", "initial": 150, "max": 1000}],
                                      "coverage_thresholds": {"red_h": 2, "yellow_low_h": 6, "yellow_high_h": 36}}, "Kho thành phẩm B"),
    ("FG_C", "RACK_WAREHOUSE", 3, 1, {"stock": [{"material": "CASE-03", "initial": 140, "max": 900}],
                                      "coverage_thresholds": {"red_h": 2, "yellow_low_h": 6, "yellow_high_h": 36}}, "Kho thành phẩm C"),
    ("SHIP_A", "SHIP_DOCK", 4, -1, {"demand": [{"kind": "TAKT", "material": "CASE-01", "takt": {"dist": "exp", "mean": 360}}]}, "Depot A"),
    ("SHIP_B", "SHIP_DOCK", 4, 0, {"demand": [{"kind": "TAKT", "material": "CASE-02", "takt": {"dist": "exp", "mean": 420}}]}, "Depot B"),
    ("SHIP_C", "SHIP_DOCK", 4, 1, {"demand": [{"kind": "TAKT", "material": "CASE-03", "takt": {"dist": "exp", "mean": 480}}]}, "Depot C"),
    ("TUG_FMCG_A", "TUGGER", 1, 2, {}, "Xe kéo FMCG A"),
    ("OPS_FMCG_A", "HOOK_OPERATOR", 2, 2, {}, "Nhân sự bốc dỡ A"),
    ("TUG_FMCG_B", "TUGGER", 3, 2, {}, "Xe kéo FMCG B"),
    ("OPS_FMCG_B", "HOOK_OPERATOR", 4, 2, {}, "Nhân sự bốc dỡ B"),
]

FMCG_RECIPES = {
    "PACK_A": ([("BIMBO-01", 12)], [("CASE-01", 1, "OK")]),
    "PACK_B": ([("BIMBO-02", 10)], [("CASE-02", 1, "OK")]),
    "PACK_C": ([("BIMBO-03", 8)], [("CASE-03", 1, "OK")]),
}

FMCG_TUG_A = {"mode": "POOL", "pool": "TUG_FMCG_A", "hook_pool": "OPS_FMCG_A", "lot": 12,
              "travel": {"dist": "norm", "mean": 70, "sd": 10}}
FMCG_TUG_B = {"mode": "POOL", "pool": "TUG_FMCG_B", "hook_pool": "OPS_FMCG_B", "lot": 10,
              "travel": {"dist": "norm", "mean": 85, "sd": 12}}

FMCG_EDGES = [
    ("SUP_FMCG", "DC_MAIN", "BIMBO-01", {"lot": 480}),
    ("SUP_FMCG", "DC_MAIN", "BIMBO-02", {"lot": 420}),
    ("SUP_FMCG", "DC_MAIN", "BIMBO-03", {"lot": 400}),
    ("DC_MAIN", "PACK_A", "BIMBO-01", FMCG_TUG_A),
    ("DC_MAIN", "PACK_B", "BIMBO-02", FMCG_TUG_A),
    ("DC_MAIN", "PACK_C", "BIMBO-03", FMCG_TUG_B),
    ("PACK_A", "FG_A", "CASE-01", {}),
    ("PACK_B", "FG_B", "CASE-02", {}),
    ("PACK_C", "FG_C", "CASE-03", {}),
    ("FG_A", "SHIP_A", "CASE-01", {}),
    ("FG_B", "SHIP_B", "CASE-02", {}),
    ("FG_C", "SHIP_C", "CASE-03", {}),
]

FMCG_SCENARIOS = [
    {"name": "Baseline FMCG Cat A", "horizon_s": 86400, "replications": 20, "start_state": "WARMUP", "injections": [], "overrides": []},
    {"name": "Tuần khuyến mãi Bimbo", "horizon_s": 86400, "replications": 20, "start_state": "WARMUP", "injections": [], "overrides": [
        {"target": "SHIP_A", "path": "/demand/0/takt/mean", "value": 300},
        {"target": "SHIP_B", "path": "/demand/0/takt/mean", "value": 360},
        {"target": "SHIP_C", "path": "/demand/0/takt/mean", "value": 420},
    ]},
    {"name": "Depot B chỉ còn 1 xe kéo", "horizon_s": 86400, "replications": 20, "start_state": "WARMUP", "injections": [], "overrides": [
        {"target": "TUG_FMCG_B", "path": "/count", "value": 1},
    ]},
]

FMCG_MAP = {
    "unit_m": 1.5, "speed_mps": 1.25,
    "points": [_pt("DC", 5, 20, "station", "DC_MAIN"), _pt("J1", 25, 10), _pt("J2", 45, 10), _pt("J3", 65, 10), _pt("NE", 85, 10),
               _pt("SE", 85, 35), _pt("B3", 65, 35), _pt("B2", 45, 35), _pt("B1", 25, 35), _pt("SW", 5, 35),
               _pt("P1", 25, 22, "station", "PACK_A"), _pt("P2", 45, 22, "station", "PACK_B"), _pt("P3", 65, 22, "station", "PACK_C")],
    "lanes": _lanes([("DC", "J1"), ("J1", "J2"), ("J2", "J3"), ("J3", "NE"), ("NE", "SE"), ("SE", "B3"), ("B3", "B2"), ("B2", "B1"),
                     ("B1", "SW"), ("SW", "DC"), ("J1", "P1"), ("P1", "B1"), ("J2", "P2"), ("P2", "B2"), ("J3", "P3"), ("P3", "B3")]),
}

FMCG_MODEL = {
    "key": "bimbo-fmcg",
    "grid": (40, 230, 210, 140),
    "nodes": FMCG_NODES,
    "recipes": FMCG_RECIPES,
    "edges": FMCG_EDGES,
    "scenarios": FMCG_SCENARIOS,
    "map": FMCG_MAP,
}

# Mô hình nhà xưởng 5000m² (50m x 100m) dựa trên sơ đồ mặt bằng thực tế:
# assets/so-do-bo-tri-mat-bang-nha-xuong-may-5-1024x675.jpg
# Sử dụng đầy đủ tất cả các thành phần của bản đồ AGV:
# - Ảnh mặt bằng (bg) hiệu chuẩn theo mét (0.10695 m/px, 1024x675 px)
# - Các vùng cấm xe (keepouts): Văn phòng, Khu phúc lợi (WC/Căn tin/Y tế), Phòng EICM, Bãi xe ngoài trời, Khu xử lý rác
# - Các loại điểm (points):
#     + station: các trạm làm việc gắn với node sơ đồ nhà máy (Kho NVL, IQC, CNC, Cơ khí, Hàn, Buffer WIP, Lắp ráp, KCS, Đóng gói, Kho TP, Cửa xuất, Phế phẩm)
#     + junction: các giao lộ, ngã ba, hành lang chính (4m) và nhánh rẽ
#     + charger: trạm sạc pin tự động AMR (khu Tây và khu Đông)
# - Các làn đường (lanes): mạng lưới hai chiều có dung lượng (capacity 1-2 xe), các điểm uốn (path waypoints) theo đúng luồng di chuyển mặt bằng thực tế.

PLANT_5000_NODES = [
    ("SUPPLIER", "DOCK_IN", 0, 0, {"lots": [{"material": "RAW-01", "qty": 150}]}, "Bãi xả Dock"),
    ("KHO_NVL", "RACK_WAREHOUSE", 1, 0, {"stock": [{"material": "RAW-01", "initial": 400, "max": 1500}],
                                         "coverage_thresholds": thresholds(2, 8)}, "Kho NVL"),
    ("IQC", "IQC", 1, 1, {"in_buffer": 50, "out_buffer": 50}, "Khu IQC"),
    ("CNC", "STAMP_PRESS", 2, -1, {"in_buffer": 50, "out_buffer": 50}, "Xưởng CNC"),
    ("MECH", "STAMP_PRESS", 2, 0, {"in_buffer": 50, "out_buffer": 50}, "Cơ khí"),
    ("WELD", "ASSEMBLY_CELL", 2, 1, {"in_buffer": 50, "out_buffer": 50}, "Xưởng hàn"),
    ("WIP_BUF", "WIP_BUFFER", 3, 0, {"stock": [{"material": "PART", "initial": 60, "max": 400},
                                                {"material": "SUB", "initial": 30, "max": 200}]}, "Buffer WIP"),
    ("ASSY_3", "ASSEMBLY_CELL", 4, 0, {"in_buffer": 50, "out_buffer": 50}, "Lắp ráp 3"),
    ("KCS", "AOI", 5, 0, {"in_buffer": 50, "out_buffer": 50}, "KCS"),
    ("PACKING", "PACKING", 6, 0, {"in_buffer": 50, "out_buffer": 50}, "Đóng gói"),
    ("SCRAP", "SCRAP", 5, 2, {}, "Phế liệu"),
    ("KHO_TP", "RACK_WAREHOUSE", 7, 0, {"stock": [{"material": "BOX", "initial": 20, "max": 100}],
                                        "coverage_thresholds": thresholds(3, 12)}, "Kho TP"),
    ("SHIP_DOCK", "SHIP_DOCK", 8, 0, {"buffer": 50, "demand": [{"kind": "TAKT", "material": "BOX", "takt": {"dist": "exp", "mean": 420}}]},
     "Cửa xuất hàng"),
    ("AGV_WEST", "AGV", 1, 2, {"kind": "AMR", "count": 2, "service": {"dist": "const", "value": 25}}, "AMR Tây"),
    ("AGV_EAST", "AGV", 6, 2, {"kind": "AMR", "count": 2, "service": {"dist": "const", "value": 20}}, "AMR Đông"),
    ("OPS_LOG", "HOOK_OPERATOR", 4, 2, {"kind": "OPERATOR", "count": 2, "service": {"dist": "tri", "min": 60, "mode": 120, "max": 240}}, "Điều phối"),
]

PLANT_5000_RECIPES = {
    "IQC": ([("RAW-01", 1)], [("RAW-01", 1, "OK")]),
    "CNC": ([("RAW-01", 1)], [("PART", 1, "OK")]),
    "MECH": ([("RAW-01", 1)], [("PART", 1, "OK")]),
    "WELD": ([("PART", 2)], [("SUB", 1, "OK")]),
    "ASSY_3": ([("PART", 1), ("SUB", 1)], [("SUB_OK", 1, "OK")]),
    "KCS": ([("SUB_OK", 1)], [("SUB_OK", 1, "OK"), ("SUB_NG", 1, "NG")]),
    "PACKING": ([("SUB_OK", 6)], [("BOX", 1, "OK")]),
}

TUG_5000_W = {"mode": "POOL", "pool": "AGV_WEST", "hook_pool": "OPS_LOG", "lot": 15, "travel": {"dist": "norm", "mean": 50, "sd": 8}}
TUG_5000_E = {"mode": "POOL", "pool": "AGV_EAST", "hook_pool": "OPS_LOG", "lot": 10, "travel": {"dist": "norm", "mean": 45, "sd": 8}}
TUG_5000_E_BOX = {"mode": "POOL", "pool": "AGV_EAST", "hook_pool": "OPS_LOG", "lot": 2, "travel": {"dist": "norm", "mean": 40, "sd": 8}}

PLANT_5000_EDGES = [
    ("SUPPLIER", "KHO_NVL", "RAW-01", {"lot": 150}),
    ("KHO_NVL", "IQC", "RAW-01", {"lot": 20}),
    ("IQC", "CNC", "RAW-01", TUG_5000_W),
    ("IQC", "MECH", "RAW-01", TUG_5000_W),
    ("CNC", "WIP_BUF", "PART", TUG_5000_W),
    ("MECH", "WIP_BUF", "PART", TUG_5000_W),
    ("WIP_BUF", "WELD", "PART", {"lot": 2}),
    ("WELD", "WIP_BUF", "SUB", TUG_5000_W),
    ("WIP_BUF", "ASSY_3", "PART", TUG_5000_E),
    ("WIP_BUF", "ASSY_3", "SUB", TUG_5000_E),
    ("ASSY_3", "KCS", "SUB_OK", {"lot": 1}),
    ("KCS", "PACKING", "SUB_OK", {"lot": 6}),
    ("KCS", "SCRAP", "SUB_NG", TUG_5000_W),
    ("PACKING", "KHO_TP", "BOX", TUG_5000_E_BOX),
    ("KHO_TP", "SHIP_DOCK", "BOX", {}),
]

PLANT_5000_SCENARIOS = [
    {"name": "Nền (vận hành bình thường)", "horizon_s": 14400, "replications": 20, "start_state": "WARMUP", "injections": [], "overrides": []},
    {"name": "Máy CNC bảo trì sau 1 giờ", "horizon_s": 14400, "replications": 20, "start_state": "WARMUP",
     "injections": [{"target": "CNC", "failure": "bearing_wear", "at_s": 3600}], "overrides": []},
    {"name": "Đội AMR khu Tây chỉ còn 1 xe", "horizon_s": 14400, "replications": 20, "start_state": "WARMUP",
     "injections": [], "overrides": [{"target": "AGV_WEST", "path": "/count", "value": 1}]},
]

PLANT_5000_KEEPOUTS = [
    {"id": "KO_OFFICE", "poly": [{"x": 80.0, "y": 8.5}, {"x": 102.0, "y": 8.5}, {"x": 102.0, "y": 17.0}, {"x": 80.0, "y": 17.0}]},
    {"id": "KO_TIEN_ICH", "poly": [{"x": 80.0, "y": 19.0}, {"x": 102.0, "y": 19.0}, {"x": 102.0, "y": 27.0}, {"x": 80.0, "y": 27.0}]},
    {"id": "KO_RAC_THAI", "poly": [{"x": 20.0, "y": 55.0}, {"x": 44.0, "y": 55.0}, {"x": 44.0, "y": 63.0}, {"x": 20.0, "y": 63.0}]},
    {"id": "KO_BAI_XE", "poly": [{"x": 58.0, "y": 55.0}, {"x": 102.0, "y": 55.0}, {"x": 102.0, "y": 63.0}, {"x": 58.0, "y": 63.0}]},
]

PLANT_5000_POINTS = [
    # Stations
    _pt("ST_DOCK", 13.0, 38.0, "station", "SUPPLIER"),
    _pt("ST_KHO_NVL", 13.0, 20.0, "station", "KHO_NVL"),
    _pt("ST_IQC", 24.0, 29.0, "station", "IQC"),
    _pt("ST_CNC", 36.0, 15.0, "station", "CNC"),
    _pt("ST_MECH", 36.0, 29.0, "station", "MECH"),
    _pt("ST_WELD", 36.0, 41.0, "station", "WELD"),
    _pt("ST_WIP", 48.0, 29.0, "station", "WIP_BUF"),
    _pt("ST_ASSY", 64.0, 29.0, "station", "ASSY_3"),
    _pt("ST_KCS", 76.0, 29.0, "station", "KCS"),
    _pt("ST_PACK", 76.0, 41.0, "station", "PACKING"),
    _pt("ST_KHO_TP", 88.0, 32.0, "station", "KHO_TP"),
    _pt("ST_SHIP", 96.0, 41.0, "station", "SHIP_DOCK"),
    _pt("ST_SCRAP", 51.0, 49.0, "station", "SCRAP"),
    # Chargers
    _pt("CH_WEST", 24.0, 15.0, "charger"),
    _pt("CH_EAST", 64.0, 41.0, "charger"),
    # Junctions
    _pt("J_W_N", 18.0, 15.0),
    _pt("J_W_M", 18.0, 29.0),
    _pt("J_W_S", 18.0, 41.0),
    _pt("J_CTR_N", 51.0, 15.0),
    _pt("J_CTR_M", 56.0, 29.0),
    _pt("J_CTR_S", 51.0, 41.0),
    _pt("J_E_M", 70.0, 29.0),
    _pt("J_E_S", 70.0, 41.0),
    _pt("J_FG", 88.0, 41.0),
]


def _plant_5000_lanes():
    connections = [
        # West backbone
        ("J_W_N", "J_W_M", 2),
        ("J_W_M", "J_W_S", 2),
        ("J_W_N", "ST_KHO_NVL", 1),
        ("ST_KHO_NVL", "J_W_M", 1),
        ("J_W_M", "ST_DOCK", 1),
        ("ST_DOCK", "J_W_S", 1),
        ("J_W_N", "CH_WEST", 1),
        ("J_W_M", "ST_IQC", 1),

        # North aisle & Machining
        ("CH_WEST", "ST_CNC", 2),
        ("ST_CNC", "J_CTR_N", 2),
        ("ST_CNC", "ST_MECH", 2),

        # Mid aisle (Main line)
        ("ST_IQC", "ST_MECH", 2),
        ("ST_MECH", "ST_WIP", 2),
        ("ST_WIP", "J_CTR_M", 2),
        ("J_CTR_M", "ST_ASSY", 2),
        ("ST_ASSY", "J_E_M", 2),
        ("J_E_M", "ST_KCS", 2),

        # South aisle & Fabrication
        ("J_W_S", "ST_WELD", 2),
        ("ST_MECH", "ST_WELD", 2),
        ("ST_WELD", "J_CTR_S", 2),
        ("J_CTR_S", "CH_EAST", 1),
        ("CH_EAST", "J_E_S", 1),
        ("J_E_S", "ST_PACK", 2),

        # Center spine & Scrap
        ("J_CTR_N", "J_CTR_M", 2),
        ("J_CTR_M", "J_CTR_S", 2),
        ("J_CTR_S", "ST_SCRAP", 1),

        # East area (KCS, Pack, Finished Goods)
        ("J_E_M", "J_E_S", 2),
        ("ST_KCS", "ST_PACK", 2),
        ("ST_PACK", "J_FG", 2),
        ("J_FG", "ST_KHO_TP", 2),
        ("J_FG", "ST_SHIP", 2),
    ]

    paths = {
        ("J_W_N", "ST_KHO_NVL"): [(13.0, 15.0)],
        ("ST_KHO_NVL", "J_W_M"): [(13.0, 29.0)],
        ("J_W_M", "ST_DOCK"): [(13.0, 29.0)],
        ("ST_DOCK", "J_W_S"): [(13.0, 41.0)],
        ("J_CTR_N", "J_CTR_M"): [(51.0, 29.0)],
        ("J_CTR_M", "J_CTR_S"): [(51.0, 29.0)],
    }

    lanes = []
    idx = 1
    for a, b, cap in connections:
        l_fwd = {"id": f"L{idx:02d}", "from": a, "to": b, "capacity": cap}
        if (a, b) in paths:
            l_fwd["path"] = [{"x": x, "y": y} for x, y in paths[(a, b)]]
        elif (b, a) in paths:
            l_fwd["path"] = [{"x": x, "y": y} for x, y in reversed(paths[(b, a)])]
        lanes.append(l_fwd)
        idx += 1

        l_rev = {"id": f"L{idx:02d}", "from": b, "to": a, "capacity": cap}
        if (b, a) in paths:
            l_rev["path"] = [{"x": x, "y": y} for x, y in paths[(b, a)]]
        elif (a, b) in paths:
            l_rev["path"] = [{"x": x, "y": y} for x, y in reversed(paths[(a, b)])]
        lanes.append(l_rev)
        idx += 1

    return lanes


PLANT_5000_MAP = {
    "v": 2,
    "speed_mps": 1.2,
    "bg": {
        "x": 0.0,
        "y": 0.0,
        "m_per_px": 0.10695187,
        "w_px": 1024,
        "h_px": 675,
        "calibrated": True,
    },
    "keepouts": PLANT_5000_KEEPOUTS,
    "points": PLANT_5000_POINTS,
    "lanes": _plant_5000_lanes(),
}

PLANT_5000_MODEL = {
    "key": "plant-5000m2",
    "image_path": "assets/so-do-bo-tri-mat-bang-nha-xuong-may-5-1024x675.jpg",
    "grid": (40, 220, 200, 140),
    "nodes": PLANT_5000_NODES,
    "recipes": PLANT_5000_RECIPES,
    "edges": PLANT_5000_EDGES,
    "scenarios": PLANT_5000_SCENARIOS,
    "map": PLANT_5000_MAP,
}

MODELS = [
    {"key": "denso-mini", "grid": (40, 220, 200, 150), "nodes": MINI_NODES, "recipes": MINI_RECIPES, "edges": MINI_EDGES, "scenarios": [MINI_SCENARIO], "map": MINI_MAP},
    {"key": "denso-plant", "grid": (40, 230, 300, 130), "nodes": PLANT_NODES, "recipes": PLANT_RECIPES, "edges": PLANT_EDGES, "scenarios": PLANT_SCENARIOS, "map": PLANT_MAP},
    {"key": "denso-plant-amr", "grid": (40, 230, 300, 130), "nodes": PLANT_AMR_NODES, "recipes": PLANT_RECIPES, "edges": PLANT_EDGES, "scenarios": PLANT_SCENARIOS, "map": PLANT_AMR_MAP},
    PLANT_5000_MODEL,
]


def call(api, method, path, body=None, allow=()):
    """allow: các mã HTTP được coi là bình thường (trả None) thay vì thoát."""
    req = urllib.request.Request(api + path, method=method, headers={"Content-Type": "application/json"},
                                 data=None if body is None else json.dumps(body).encode())
    try:
        with urllib.request.urlopen(req) as r:
            raw = r.read()
            return json.loads(raw) if raw else None
    except urllib.error.HTTPError as e:
        if e.code in allow:
            return None
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


def ensure_map(api, model, force=False):
    """Bản đồ AGV thuộc mô hình: chỉ đặt khi chưa có (hoặc force=True), để không ghi đè bản đã sửa trên giao diện."""
    key = model["key"]
    if "map" not in model:
        return
    if not force and call(api, "GET", f"/api/models/{key}/agv-map", allow=(404,)) is not None:
        return

    m = json.loads(json.dumps(model["map"]))
    if "image_path" in model:
        repo_root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
        img_full_path = os.path.join(repo_root, model["image_path"])
        if os.path.exists(img_full_path):
            try:
                with open(img_full_path, "rb") as f:
                    img_data = f.read()
                req = urllib.request.Request(
                    f"{api}/api/models/{key}/agv-map/image",
                    data=img_data,
                    headers={"Content-Type": "image/jpeg"},
                    method="PUT",
                )
                with urllib.request.urlopen(req) as r:
                    res = json.loads(r.read())
                    rev = res.get("rev")
                    if "bg" in m and rev:
                        m["bg"] = {**m["bg"], "rev": rev, "calibrated": True}
                    print(f"Đã tải ảnh mặt bằng cho '{key}': {res.get('width')}x{res.get('height')} px (rev {rev}).")
            except Exception as e:
                print(f"Cảnh báo: không tải được ảnh mặt bằng '{img_full_path}': {e}")
        else:
            print(f"Cảnh báo: không tìm thấy file ảnh mặt bằng tại '{img_full_path}'")

    call(api, "PUT", f"/api/models/{key}/agv-map", m)
    keepouts_cnt = len(m.get("keepouts", []))
    print(f"Đã đặt bản đồ AGV cho '{key}': {len(m['points'])} điểm, {len(m['lanes'])} làn, {keepouts_cnt} vùng cấm.")


def seed_model(api, model, existing, force_map=False):
    key = model["key"]
    if key in existing:
        m = existing[key]
        if m["status"] == "DRAFT" and m["scenarios"] == 0:
            vid = m["latest_version_id"]
            call(api, "PUT", f"/api/versions/{vid}/graph", {"nodes": node_rows(model), "edges": edge_rows(model["edges"])})
            call(api, "POST", f"/api/versions/{vid}/publish")
            ids = [call(api, "POST", "/api/scenarios", {"model_version_id": vid, **sc})["id"] for sc in model["scenarios"]]
            print(f"Đã hoàn tất lại '{key}' version {vid} (PUBLISHED), scenario {', '.join(map(str, ids))}.")
            ensure_map(api, model, force=force_map)
            print(f"Mở http://localhost:5173/versions/{vid}/scenarios rồi bấm Chạy.")
            return
        print(f"'{key}' đã có: version {m['latest_version_id']} ({m['status']}) — bỏ qua.")
        print(f"Mở http://localhost:5173/versions/{m['latest_version_id']}/scenarios")
        ensure_map(api, model, force=force_map)
        return
    vid = call(api, "POST", "/api/models", {"model_key": key})["version_id"]
    call(api, "PUT", f"/api/versions/{vid}/graph", {"nodes": node_rows(model), "edges": edge_rows(model["edges"])})
    call(api, "POST", f"/api/versions/{vid}/publish")
    ids = [call(api, "POST", "/api/scenarios", {"model_version_id": vid, **sc})["id"] for sc in model["scenarios"]]
    print(f"Đã tạo '{key}' version {vid} (PUBLISHED), scenario {', '.join(map(str, ids))}.")
    ensure_map(api, model, force=force_map)
    print(f"Mở http://localhost:5173/versions/{vid}/scenarios rồi bấm Chạy.")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--api", default="http://localhost:8080")
    ap.add_argument("--with-fmcg", action="store_true", help="Seed thêm model FMCG/Bimbo benchmark demo.")
    ap.add_argument("--force-map", action="store_true", help="Ghi đè lại bản đồ AGV và tải lại ảnh mặt bằng kể cả khi đã có.")
    args = ap.parse_args()
    api = args.api.rstrip("/")
    have = {m["code"] for m in call(api, "GET", "/api/materials")}
    for mat in EXTRA_MATERIALS:
        if mat["code"] not in have:
            call(api, "POST", "/api/materials", mat)
    existing = {m["model_key"]: m for m in call(api, "GET", "/api/models")}
    models = MODELS + ([FMCG_MODEL] if args.with_fmcg else [])
    for model in models:
        seed_model(api, model, existing, force_map=args.force_map)


if __name__ == "__main__":
    main()
