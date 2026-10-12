#!/usr/bin/env python3
"""Dữ liệu cho video demo, chạy SAU `seed_demo.py`. Chạy lại nhiều lần không sao.

Thêm vào những gì `seed_demo.py` đã dựng:
- Bản đồ AGV/AMR vẽ trên ảnh mặt bằng trong `assets/` cho `denso-plant-amr` và `denso-plant` (cùng nhà máy nên
  cùng mặt bằng, chỉ bản AMR có chỗ sạc), đặt đủ mọi node lên bản đồ.
- 21 máy đang gắn đồng hồ ở khu Đồng hồ thành thiết bị trong danh mục Thiết bị (mã thiết bị = machine_id của gauge-twin).
- Ba mô hình phụ có ảnh mặt bằng: xưởng cơ khí (NHA_MAY_3), xưởng thực phẩm (NHA_MAY_2), trung tâm phân phối;
  hai xưởng đầu đặt chính các máy gắn đồng hồ của nhà máy đó.
- Thêm scenario cho `denso-plant-amr`, trong đó có scenario dùng làm câu chuyện của video.

Tỉ lệ mét/pixel của các ảnh là GIẢ ĐỊNH để quãng đường xe hợp lý; ảnh là bản vẽ mẫu, không phải mặt bằng DENSO.

Chạy: python3 scripts/seed_demo.py && python3 scripts/seed_video_demo.py [--api http://localhost:8080]
"""
import argparse
import json
import os
import sys
import urllib.request

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import seed_demo as sd  # noqa: E402

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


# ---------- bản đồ vẽ theo toạ độ pixel của ảnh, đổi sang mét ----------

def build_map(m_per_px, w_px, h_px, points, links, markers, keepouts=(), paths=None, speed=1.2):
    """points: {id: (x_px, y_px, kind, node_key|None)}; links: [(a, b, capacity)] hai chiều;
    markers: {node_key: (x_px, y_px)} node chỉ đánh dấu vị trí (không có đường); keepouts: [(id, x0, y0, x1, y1)] px."""
    k = m_per_px
    paths = paths or {}
    pts = [sd._pt(pid, round(x * k, 2), round(y * k, 2), kind, node) for pid, (x, y, kind, node) in points.items()]
    pts += [sd._pt(f"M_{key}", round(x * k, 2), round(y * k, 2), "station", key) for key, (x, y) in markers.items()]
    lanes, i = [], 1
    for a, b, cap in links:
        for src, dst in ((a, b), (b, a)):
            lane = {"id": f"L{i:02d}", "from": src, "to": dst, "capacity": cap}
            via = paths.get((src, dst)) or list(reversed(paths.get((dst, src), [])))
            if via:
                lane["path"] = [{"x": round(x * k, 2), "y": round(y * k, 2)} for x, y in via]
            lanes.append(lane)
            i += 1
    kos = [{"id": kid, "poly": [{"x": round(x * k, 2), "y": round(y * k, 2)} for x, y in ((x0, y0), (x1, y0), (x1, y1), (x0, y1))]}
           for kid, x0, y0, x1, y1 in keepouts]
    return {"v": 2, "speed_mps": speed, "bg": {"x": 0.0, "y": 0.0, "m_per_px": m_per_px, "w_px": w_px, "h_px": h_px, "calibrated": True},
            "keepouts": kos, "points": pts, "lanes": lanes}


def put_map(api, key, image, m):
    with open(os.path.join(ROOT, image), "rb") as f:
        req = urllib.request.Request(f"{api}/api/models/{key}/agv-map/image", data=f.read(),
                                     headers={"Content-Type": "image/jpeg"}, method="PUT")
    with urllib.request.urlopen(req) as r:
        res = json.loads(r.read())
    m = json.loads(json.dumps(m))
    m["bg"]["rev"] = res.get("rev")
    sd.call(api, "PUT", f"/api/models/{key}/agv-map", m)
    print(f"Bản đồ '{key}' trên {os.path.basename(image)}: {len(m['points'])} điểm, {len(m['lanes'])} làn, {len(m['keepouts'])} vùng cấm.")


# ---------- denso-plant / denso-plant-amr: ảnh xưởng điện tử (ban-ve-thiet-ke-nha-xuong-14.jpg, 1366x900) ----------
# Lối đi lấy theo mũi tên xanh trên bản vẽ: hành lang trên (y≈218), giữa (y≈462), dưới (y≈632), dọc trái (x≈205),
# dọc giữa (x≈560), dọc phải (x≈645). Kho NVL A ở cửa "Kho vật tư & linh kiện", kho NVL B ở kho linh kiện phía dưới.

def plant_map(with_charger):
    points = {
        "J_TL": (205, 218, "junction", None), "S1": (330, 218, "station", "STAMP_1"), "S2": (455, 218, "station", "STAMP_2"),
        "J_TC": (560, 218, "junction", None), "J_TR": (645, 218, "junction", None),
        "J_KA": (645, 300, "junction", None), "KHO_A": (765, 300, "station", "KHO_A"),
        "J_ML": (205, 462, "junction", None), "S4": (330, 462, "station", "STAMP_4"), "S3": (455, 462, "station", "STAMP_3"),
        "J_MC": (560, 462, "junction", None), "J_MR": (645, 462, "junction", None),
        "J_KB": (645, 553, "junction", None), "KHO_B": (765, 553, "station", "KHO_B"),
        "J_BL": (205, 632, "junction", None), "J_BC": (560, 632, "junction", None),
    }
    links = [("J_TL", "S1", 2), ("S1", "S2", 2), ("S2", "J_TC", 2), ("J_TC", "J_TR", 2),
             ("J_ML", "S4", 2), ("S4", "S3", 2), ("S3", "J_MC", 2), ("J_MC", "J_MR", 2),
             ("J_TL", "J_ML", 2), ("J_TC", "J_MC", 2), ("J_MC", "J_BC", 2), ("J_BL", "J_BC", 2),
             ("J_TR", "J_KA", 2), ("J_KA", "KHO_A", 1), ("J_KA", "J_MR", 2),
             ("J_MR", "J_KB", 2), ("J_KB", "KHO_B", 1), ("J_BC", "J_KB", 2)]
    if with_charger:
        points["CH"] = (205, 560, "charger", None)
        links += [("J_ML", "CH", 1), ("CH", "J_BL", 1)]
    else:
        links += [("J_ML", "J_BL", 2)]
    markers = {"SUP_A": (500, 815), "SUP_B": (615, 815), "WIP_1": (600, 390), "WIP_2": (600, 515),
               "ASSY_1": (300, 560), "ASSY_2": (440, 560), "QC": (735, 212), "PACK_1": (735, 385), "PACK_2": (735, 455),
               "SCRAP": (190, 700), "FG_1": (885, 400), "FG_2": (885, 480), "SHIP_1": (1010, 400), "SHIP_2": (1010, 480)}
    keepouts = [("KO_RND", 805, 565, 965, 740), ("KO_ESD", 240, 652, 520, 740), ("KO_KHO_VT", 795, 195, 965, 330)]
    return build_map(0.12, 1366, 900, points, links, markers, keepouts, paths={("J_BC", "J_KB"): [(645, 632)]})


# ---------- 21 máy gắn đồng hồ (khu Đồng hồ) thành thiết bị ----------
GAUGE_ASSETS = [
    # (mã = machine_id, loại node, nhà máy, dây chuyền, tên)
    ("TRAM_BOM_01", "UTILITY_SUPPLY", "NHA_MAY_1", "XUONG_A", "Trạm bơm 01"),
    ("MAY_NEN_KHI_02", "UTILITY_SUPPLY", "NHA_MAY_1", "XUONG_A", "Máy nén khí 02"),
    ("MAY_EP_03", "UTILITY_MACHINE", "NHA_MAY_1", "XUONG_A", "Máy ép thuỷ lực 03"),
    ("MAY_PHAT_DIEN_04", "UTILITY_SUPPLY", "NHA_MAY_1", "XUONG_A", "Máy phát điện 04"),
    ("LO_HOI_05", "UTILITY_SUPPLY", "NHA_MAY_1", "XUONG_A", "Lò hơi 05"),
    ("BOM_CHAN_KHONG_06", "UTILITY_SUPPLY", "NHA_MAY_1", "XUONG_A", "Bơm chân không 06"),
    ("MAY_LANH_07", "UTILITY_SUPPLY", "NHA_MAY_1", "XUONG_A", "Máy làm lạnh nước 07"),
    ("MAY_DONG_GOI_08", "UTILITY_MACHINE", "NHA_MAY_1", "XUONG_A", "Máy đóng gói 08"),
    ("TRAM_KHI_NEN_09", "UTILITY_SUPPLY", "NHA_MAY_1", "XUONG_A", "Trạm khí nén 09"),
    ("MAY_NGHIEN_10", "UTILITY_MACHINE", "NHA_MAY_1", "XUONG_A", "Máy nghiền 10"),
    ("DAY_CHUYEN_SON_11", "UTILITY_MACHINE", "NHA_MAY_1", "XUONG_A", "Dây chuyền sơn 11"),
    ("NOI_HAP_21", "UTILITY_MACHINE", "NHA_MAY_2", "XUONG_THUC_PHAM", "Nồi hấp tiệt trùng 21"),
    ("MAY_CHIET_22", "UTILITY_MACHINE", "NHA_MAY_2", "XUONG_THUC_PHAM", "Máy chiết rót 22"),
    ("KHO_LANH_23", "RACK_WAREHOUSE", "NHA_MAY_2", "XUONG_THUC_PHAM", "Kho lạnh nguyên liệu 23"),
    ("BOM_NUOC_24", "UTILITY_SUPPLY", "NHA_MAY_2", "XUONG_THUC_PHAM", "Bơm nước cấp 24"),
    ("BOM_NUOC_25", "UTILITY_SUPPLY", "NHA_MAY_2", "XUONG_THUC_PHAM", "Bơm nước thải 25"),
    ("MAY_CNC_31", "UTILITY_MACHINE", "NHA_MAY_3", "XUONG_CO_KHI", "Máy CNC 31"),
    ("LO_NHIET_LUYEN_32", "UTILITY_MACHINE", "NHA_MAY_3", "XUONG_CO_KHI", "Lò nhiệt luyện 32"),
    ("MAY_NEN_KHI_33", "UTILITY_SUPPLY", "NHA_MAY_3", "XUONG_CO_KHI", "Máy nén khí 33"),
    ("MAY_HAN_34", "UTILITY_MACHINE", "NHA_MAY_3", "XUONG_CO_KHI", "Máy hàn MIG/TIG 34"),
    ("MAY_CAT_PLASMA_35", "UTILITY_MACHINE", "NHA_MAY_3", "XUONG_CO_KHI", "Máy cắt plasma 35"),
]

MATERIALS = [
    {"code": "THEP-TAM", "name": "Thép tấm", "unit": "tấm"},
    {"code": "PHOI", "name": "Phôi cắt", "unit": "pcs"},
    {"code": "CHI-TIET", "name": "Chi tiết gia công", "unit": "pcs"},
    {"code": "CHI-TIET-NL", "name": "Chi tiết đã nhiệt luyện", "unit": "pcs"},
    {"code": "CUM-HAN", "name": "Cụm hàn", "unit": "pcs"},
    {"code": "KHUNG", "name": "Khung thành phẩm", "unit": "pcs"},
    {"code": "NL-TUOI", "name": "Nguyên liệu tươi", "unit": "kg"},
    {"code": "NL-SO-CHE", "name": "Nguyên liệu đã sơ chế", "unit": "kg"},
    {"code": "BAN-TP", "name": "Bán thành phẩm đã hấp", "unit": "kg"},
    {"code": "LON", "name": "Lon đóng hộp", "unit": "lon"},
    {"code": "THUNG", "name": "Thùng 12 lon", "unit": "thùng"},
    {"code": "PALLET", "name": "Pallet hàng nhập", "unit": "pallet"},
    {"code": "KIEN", "name": "Kiện hàng đã phân loại", "unit": "kiện"},
]


def forklift(pool, lot, mean=75):
    return {"mode": "POOL", "pool": pool, "lot": lot, "travel": {"dist": "norm", "mean": mean, "sd": 12}}


def recipe(ins, outs):
    return ([(m, q) for m, q in ins], [(m, q, "OK") for m, q in outs])


# ---------- NHA_MAY_3: xưởng cơ khí (ban-ve-thiet-ke-nha-xuong-12.jpg) ----------
NM3 = {
    "key": "nha-may-3-co-khi", "plant": "NHA_MAY_3", "line": "XUONG_CO_KHI", "grid": (40, 230, 260, 140),
    "nodes": [
        ("NM3_BAI_THEP", "DOCK_IN", 0, 0, {"lots": [{"material": "THEP-TAM", "qty": 40}]}, "Bãi nhận thép tấm"),
        ("NM3_KHO_VL", "RACK_WAREHOUSE", 1, 0, {"stock": [{"material": "THEP-TAM", "initial": 120, "max": 400}],
                                                "coverage_thresholds": sd.thresholds(2, 8)}, "Kho vật liệu"),
        ("MAY_CAT_PLASMA_35", "UTILITY_MACHINE", 2, 0, None, "Máy cắt plasma 35"),
        ("MAY_CNC_31", "UTILITY_MACHINE", 3, 0, None, "Máy CNC 31"),
        ("LO_NHIET_LUYEN_32", "UTILITY_MACHINE", 4, 0, None, "Lò nhiệt luyện 32"),
        ("MAY_HAN_34", "UTILITY_MACHINE", 5, 0, None, "Máy hàn MIG/TIG 34"),
        ("NM3_LAP_RAP", "ASSEMBLY_CELL", 6, 0, None, "Khu lắp ráp"),
        ("NM3_KHO_TP", "RACK_WAREHOUSE", 7, 0, {"stock": [{"material": "KHUNG", "initial": 10, "max": 60}],
                                                "coverage_thresholds": sd.thresholds(1.5, 6)}, "Kho thành phẩm"),
        ("NM3_XUAT", "SHIP_DOCK", 8, 0, {"demand": [{"kind": "TAKT", "material": "KHUNG", "takt": {"dist": "exp", "mean": 420}}]},
         "Cửa cuốn xuất hàng"),
        ("NM3_XE_NANG", "TUGGER", 4, 1.5, {"kind": "FORKLIFT", "count": 2}, "Xe nâng xưởng cơ khí"),
    ],
    "recipes": {
        "MAY_CAT_PLASMA_35": recipe([("THEP-TAM", 1)], [("PHOI", 4)]),
        "MAY_CNC_31": recipe([("PHOI", 1)], [("CHI-TIET", 1)]),
        "LO_NHIET_LUYEN_32": recipe([("CHI-TIET", 1)], [("CHI-TIET-NL", 1)]),
        "MAY_HAN_34": recipe([("CHI-TIET-NL", 2)], [("CUM-HAN", 1)]),
        "NM3_LAP_RAP": recipe([("CUM-HAN", 1)], [("KHUNG", 1)]),
    },
    "edges": [
        ("NM3_BAI_THEP", "NM3_KHO_VL", "THEP-TAM", {"lot": 40}),
        ("NM3_KHO_VL", "MAY_CAT_PLASMA_35", "THEP-TAM", forklift("NM3_XE_NANG", 5)),
        ("MAY_CAT_PLASMA_35", "MAY_CNC_31", "PHOI", {}),
        ("MAY_CNC_31", "LO_NHIET_LUYEN_32", "CHI-TIET", {}),
        ("LO_NHIET_LUYEN_32", "MAY_HAN_34", "CHI-TIET-NL", {}),
        ("MAY_HAN_34", "NM3_LAP_RAP", "CUM-HAN", {}),
        ("NM3_LAP_RAP", "NM3_KHO_TP", "KHUNG", forklift("NM3_XE_NANG", 4)),
        ("NM3_KHO_TP", "NM3_XUAT", "KHUNG", {}),
    ],
    "scenarios": [
        {"name": "Nền (ca ngày)", "horizon_s": 14400, "replications": 20, "start_state": "WARMUP", "injections": [], "overrides": []},
        {"name": "Máy CNC 31 mòn vòng bi sau 1 giờ", "horizon_s": 14400, "replications": 20, "start_state": "WARMUP",
         "injections": [{"target": "MAY_CNC_31", "failure": "bearing_wear", "at_s": 3600}], "overrides": []},
        {"name": "Chỉ còn 1 xe nâng", "horizon_s": 14400, "replications": 20, "start_state": "WARMUP", "injections": [],
         "overrides": [{"target": "NM3_XE_NANG", "path": "/count", "value": 1}]},
    ],
}


def nm3_map():
    points = {
        "PLASMA": (230, 640, "station", "MAY_CAT_PLASMA_35"), "J_M": (690, 640, "junction", None),
        "LAP_RAP": (900, 640, "station", "NM3_LAP_RAP"), "J_E": (1055, 640, "junction", None),
        "KHO_TP": (1110, 600, "station", "NM3_KHO_TP"), "J_MN": (690, 470, "junction", None),
        "J_N2": (1055, 470, "junction", None), "J_NE": (1055, 300, "junction", None), "KHO_VL": (1110, 300, "station", "NM3_KHO_VL"),
    }
    links = [("PLASMA", "J_M", 2), ("J_M", "LAP_RAP", 2), ("LAP_RAP", "J_E", 2), ("J_E", "KHO_TP", 1),
             ("J_M", "J_MN", 2), ("J_MN", "J_N2", 2), ("J_N2", "J_NE", 2), ("J_N2", "J_E", 2), ("J_NE", "KHO_VL", 1)]
    markers = {"NM3_BAI_THEP": (1290, 300), "MAY_CNC_31": (500, 450), "LO_NHIET_LUYEN_32": (200, 470),
               "MAY_HAN_34": (700, 240), "NM3_XUAT": (1290, 470)}
    keepouts = [("KO_VAN_PHONG", 725, 662, 905, 780), ("KO_VE_SINH", 912, 662, 1082, 780)]
    return build_map(0.06, 1366, 900, points, links, markers, keepouts)


# ---------- NHA_MAY_2: xưởng thực phẩm đóng hộp (ban-ve-thiet-ke-nha-xuong-11.jpg) ----------
NM2 = {
    "key": "nha-may-2-thuc-pham", "plant": "NHA_MAY_2", "line": "XUONG_THUC_PHAM", "grid": (40, 230, 260, 140),
    "nodes": [
        ("NM2_NHAP", "DOCK_IN", 0, 0, {"lots": [{"material": "NL-TUOI", "qty": 60}]}, "Cổng nhập nguyên liệu"),
        ("KHO_LANH_23", "RACK_WAREHOUSE", 1, 0, {"stock": [{"material": "NL-TUOI", "initial": 220, "max": 600}],
                                                "coverage_thresholds": sd.thresholds(2, 8)}, "Kho lạnh nguyên liệu 23"),
        ("NM2_SO_CHE", "ASSEMBLY_CELL", 2, 0, {"in_buffer": 40, "out_buffer": 40}, "Khu rửa & sơ chế"),
        ("NOI_HAP_21", "UTILITY_MACHINE", 3, 0, None, "Nồi hấp tiệt trùng 21"),
        ("MAY_CHIET_22", "UTILITY_MACHINE", 4, 0, None, "Máy chiết rót 22"),
        ("NM2_DONG_GOI", "PACKING", 5, 0, {"in_buffer": 36, "out_buffer": 10}, "Đóng gói & nhãn mác"),
        ("NM2_KHO_TP", "RACK_WAREHOUSE", 6, 0, {"stock": [{"material": "THUNG", "initial": 12, "max": 80}],
                                                "coverage_thresholds": sd.thresholds(1.5, 6)}, "Kho thành phẩm mát"),
        ("NM2_XUAT", "SHIP_DOCK", 7, 0, {"demand": [{"kind": "TAKT", "material": "THUNG", "takt": {"dist": "exp", "mean": 1500}}]},
         "Cửa xuất hàng"),
        ("NM2_XE_NANG", "TUGGER", 3, 1.5, {"kind": "FORKLIFT", "count": 2}, "Xe nâng tay"),
    ],
    "recipes": {
        "NM2_SO_CHE": recipe([("NL-TUOI", 1)], [("NL-SO-CHE", 1)]),
        "NOI_HAP_21": recipe([("NL-SO-CHE", 2)], [("BAN-TP", 1)]),
        "MAY_CHIET_22": recipe([("BAN-TP", 1)], [("LON", 1)]),
        "NM2_DONG_GOI": recipe([("LON", 12)], [("THUNG", 1)]),
    },
    "edges": [
        ("NM2_NHAP", "KHO_LANH_23", "NL-TUOI", {"lot": 60}),
        ("KHO_LANH_23", "NM2_SO_CHE", "NL-TUOI", forklift("NM2_XE_NANG", 20, 60)),
        ("NM2_SO_CHE", "NOI_HAP_21", "NL-SO-CHE", {}),
        ("NOI_HAP_21", "MAY_CHIET_22", "BAN-TP", {}),
        ("MAY_CHIET_22", "NM2_DONG_GOI", "LON", {}),
        ("NM2_DONG_GOI", "NM2_KHO_TP", "THUNG", forklift("NM2_XE_NANG", 2, 60)),
        ("NM2_KHO_TP", "NM2_XUAT", "THUNG", {}),
    ],
    "scenarios": [
        {"name": "Nền (một ca)", "horizon_s": 14400, "replications": 20, "start_state": "WARMUP", "injections": [], "overrides": []},
        {"name": "Nồi hấp 21 quá nhiệt sau 90 phút", "horizon_s": 14400, "replications": 20, "start_state": "WARMUP",
         "injections": [{"target": "NOI_HAP_21", "failure": "motor_overheat", "at_s": 5400}], "overrides": []},
    ],
}


def nm2_map():
    points = {
        "J_A": (360, 390, "junction", None), "KL": (480, 390, "station", "KHO_LANH_23"), "J_B": (790, 390, "junction", None),
        "DG": (860, 395, "station", "NM2_DONG_GOI"), "KTP": (1050, 395, "station", "NM2_KHO_TP"),
        "J_C": (360, 500, "junction", None), "SC": (470, 500, "station", "NM2_SO_CHE"), "J_D": (790, 500, "junction", None),
    }
    links = [("J_A", "KL", 2), ("KL", "J_B", 2), ("J_B", "DG", 2), ("DG", "KTP", 2),
             ("J_A", "J_C", 2), ("J_C", "SC", 2), ("SC", "J_D", 2), ("J_D", "J_B", 2)]
    markers = {"NM2_NHAP": (230, 450), "NOI_HAP_21": (650, 445), "MAY_CHIET_22": (860, 300), "NM2_XUAT": (1150, 450)}
    keepouts = [("KO_VAN_PHONG", 800, 537, 905, 685), ("KO_KY_THUAT", 910, 537, 1005, 685), ("KO_VE_SINH", 1010, 522, 1145, 685)]
    return build_map(0.05, 1366, 900, points, links, markers, keepouts)


# ---------- Trung tâm phân phối (ban-ve-thiet-ke-nha-xuong-13.jpg) ----------
DC = {
    "key": "trung-tam-phan-phoi", "plant": "TT_PHAN_PHOI", "line": "KHO_CAO_TANG", "grid": (40, 230, 280, 140),
    "nodes": [
        ("DC_NHAP", "DOCK_IN", 0, 0, {"lots": [{"material": "PALLET", "qty": 24}]}, "Khu vực nhập hàng"),
        ("DC_KHO", "RACK_WAREHOUSE", 1, 0, {"stock": [{"material": "PALLET", "initial": 180, "max": 900}],
                                            "coverage_thresholds": sd.thresholds(4, 24)}, "Kho kệ cao tầng"),
        ("DC_PHAN_LOAI", "PACKING", 2, 0, {"in_buffer": 6, "out_buffer": 48}, "Khu phân loại & xếp dỡ"),
        ("DC_STAGING", "WIP_BUFFER", 3, 0, {"stock": [{"material": "KIEN", "initial": 40, "max": 400}]}, "Staging xuất hàng"),
        ("DC_XUAT", "SHIP_DOCK", 4, 0, {"demand": [{"kind": "TAKT", "material": "KIEN", "takt": {"dist": "exp", "mean": 45}}]},
         "Khu vực xuất hàng"),
        ("DC_XE_NANG", "TUGGER", 2, 1.5, {"kind": "FORKLIFT", "count": 3}, "Đội xe nâng"),
    ],
    "recipes": {"DC_PHAN_LOAI": recipe([("PALLET", 1)], [("KIEN", 8)])},
    "edges": [
        ("DC_NHAP", "DC_KHO", "PALLET", {"lot": 24}),
        ("DC_KHO", "DC_PHAN_LOAI", "PALLET", forklift("DC_XE_NANG", 2, 90)),
        ("DC_PHAN_LOAI", "DC_STAGING", "KIEN", forklift("DC_XE_NANG", 16, 60)),
        ("DC_STAGING", "DC_XUAT", "KIEN", {}),
    ],
    "scenarios": [
        {"name": "Nền (ngày thường)", "horizon_s": 28800, "replications": 20, "start_state": "WARMUP", "injections": [], "overrides": []},
        {"name": "Cao điểm cuối tháng: chỉ còn 2 xe nâng", "horizon_s": 28800, "replications": 20, "start_state": "WARMUP",
         "injections": [], "overrides": [{"target": "DC_XE_NANG", "path": "/count", "value": 2}]},
    ],
}


def dc_map():
    points = {
        "J1": (485, 210, "junction", None), "J2": (700, 210, "junction", None), "J3": (700, 545, "junction", None),
        "J4": (485, 545, "junction", None), "KHO": (590, 545, "station", "DC_KHO"),
        "PL": (790, 330, "station", "DC_PHAN_LOAI"), "STG": (900, 430, "station", "DC_STAGING"),
    }
    links = [("J1", "J2", 2), ("J2", "J3", 2), ("J4", "J1", 2), ("J4", "KHO", 2), ("KHO", "J3", 2),
             ("J2", "PL", 2), ("PL", "STG", 2), ("STG", "J3", 2)]
    markers = {"DC_NHAP": (270, 400), "DC_XUAT": (1040, 480)}
    keepouts = [("KO_VAN_PHONG", 918, 178, 1088, 288)]
    return build_map(0.155, 1366, 900, points, links, markers, keepouts,
                     paths={("J2", "PL"): [(790, 210)], ("STG", "J3"): [(900, 545)]})


# ---------- scenario thêm cho denso-plant-amr ----------
STORY = "Ca chiều: AMR kho B còn 1 xe, máy dập 2 mòn vòng bi"
AMR_EXTRA_SCENARIOS = [
    {"name": STORY, "horizon_s": 14400, "replications": 20, "start_state": "WARMUP",
     "injections": [{"target": "STAMP_2", "failure": "bearing_wear", "at_s": 3600}],
     "overrides": [{"target": "TUG_B_AMR", "path": "/count", "value": 1}]},
    {"name": "Kho NVL A nhập trễ: tồn đầu chỉ còn 80", "horizon_s": 14400, "replications": 20, "start_state": "WARMUP",
     "injections": [], "overrides": [{"target": "KHO_A", "path": "/stock/0/initial", "value": 80}]},
    {"name": "Máy dập 4 mòn vòng bi sau 1 giờ", "horizon_s": 14400, "replications": 20, "start_state": "WARMUP",
     "injections": [{"target": "STAMP_4", "failure": "bearing_wear", "at_s": 3600}], "overrides": []},
]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--api", default="http://localhost:8080")
    api = ap.parse_args().api.rstrip("/")

    have = {m["code"] for m in sd.call(api, "GET", "/api/materials")}
    for mat in MATERIALS:
        if mat["code"] not in have:
            sd.call(api, "POST", "/api/materials", mat)

    assets = {a["key"] for a in sd.call(api, "GET", "/api/assets")}
    made = 0
    for key, typ, plant, line, name in GAUGE_ASSETS:
        if key not in assets:
            sd.call(api, "POST", "/api/assets", {"key": key, "node_type": typ, "plant": plant, "line": line, "name": name})
            assets.add(key)
            made += 1
    print(f"Đã khai {made} thiết bị gắn đồng hồ vào danh mục Thiết bị.")

    existing = {m["model_key"]: m for m in sd.call(api, "GET", "/api/models")}
    for model in (NM3, NM2, DC):
        sd.seed_model(api, model, existing, assets=assets)

    put_map(api, "denso-plant-amr", "assets/ban-ve-thiet-ke-nha-xuong-14.jpg", plant_map(with_charger=True))
    put_map(api, "denso-plant", "assets/ban-ve-thiet-ke-nha-xuong-14.jpg", plant_map(with_charger=False))
    put_map(api, "nha-may-3-co-khi", "assets/ban-ve-thiet-ke-nha-xuong-12.jpg", nm3_map())
    put_map(api, "nha-may-2-thuc-pham", "assets/ban-ve-thiet-ke-nha-xuong-11.jpg", nm2_map())
    put_map(api, "trung-tam-phan-phoi", "assets/ban-ve-thiet-ke-nha-xuong-13.jpg", dc_map())

    amr = next(m for m in sd.call(api, "GET", "/api/models") if m["model_key"] == "denso-plant-amr")
    vid = amr["latest_version_id"]
    names = {s["name"] for s in sd.call(api, "GET", f"/api/versions/{vid}/scenarios")}
    for sc in AMR_EXTRA_SCENARIOS:
        if sc["name"] not in names:
            sid = sd.call(api, "POST", "/api/scenarios", {"model_version_id": vid, **sc})["id"]
            print(f"Thêm scenario '{sc['name']}' (id {sid}) cho denso-plant-amr.")


if __name__ == "__main__":
    main()
