"""Tên thiết bị (asset tag) suy từ key node. Cố ý khác key node: bước mapping phải có việc để làm."""
from __future__ import annotations

import re

_FULL = {"QC": "aoi", "WIP_BUF": "buf", "SUPPLIER": "dock-in", "PACKING": "pck", "SHIP": "dock-out", "SRC": "dock-in",
         "OUT": "dock-out", "SCRAP": "scr", "FG": "wh-fg", "ASSY": "asm", "KHO_NVL": "wh-raw"}
_HEAD = {"STAMP": "prs", "ASSY": "asm", "QC": "aoi", "PACK": "pck", "KHO": "wh", "FG": "wh-fg", "SUP": "dock-in",
         "SHIP": "dock-out", "SCRAP": "scr", "TUG": "tug", "TUGGER": "tug", "OPS": "ops", "WIP": "buf"}


def alias_of(key: str) -> str:
    """STAMP_2 → prs-02; KHO_A → wh-a; QC → aoi; chưa có trong bảng → chữ thường."""
    norm = re.sub(r"[^A-Za-z0-9]+", "_", key).strip("_")
    if norm.upper() in _FULL:
        return _FULL[norm.upper()]
    tokens = norm.split("_")
    head = _HEAD.get(tokens[0].upper(), tokens[0].lower())
    rest = tokens[1:]
    if not rest:
        return head
    first = rest[0]
    tail = f"{int(first):02d}" if first.isdigit() else "-".join(t.lower() for t in rest)
    return f"{head}-{tail}"


def edge_slug(edge_key: str) -> str:
    """KHO_A>STAMP_1 → wh-a~prs-01; cặp trùng (`#2`) → …​.2. Không chứa ký tự đại diện của MQTT."""
    base, _, n = edge_key.partition("#")
    src, _, dst = base.partition(">")
    slug = f"{alias_of(src)}~{alias_of(dst)}"
    return f"{slug}.{n}" if n else slug
