"""Đưa số đọc đồng hồ của gauge-twin vào live twin của KaizenFlow.

Vì sao có service này: gauge-twin là hệ của nhà máy, chạy độc lập (stack riêng, DB riêng, edge ngoài
hiện trường) và không được phụ thuộc vào KaizenFlow để hoạt động. Nên việc nối đi theo chiều KÉO:
bridge đọc endpoint live của `query-api` rồi POST vào `/api/ingest` như một nguồn dữ liệu bình
thường. gauge-twin không phải sửa gì, và KaizenFlow sập thì khu Đồng hồ vẫn đọc đồng hồ như cũ.

Tên nguồn là chính topic MQTT mà edge đã publish, nên trang Nguồn dữ liệu hiện đúng cái có thật
ngoài hiện trường. Mỗi máy một bản tin, các đồng hồ của nó nằm trong `gauges`, ghép nối trỏ tới
`gauges.<mã đồng hồ>.value`.

Không gửi kèm `model`: đây là dữ liệu THẬT, nên áp cho mọi mô hình có ghép nối khớp — khác feed giả
lập (mỗi mô hình một runner nên phải nói rõ mô hình).
"""

from __future__ import annotations

import json
import logging
import os
import time
import urllib.error
import urllib.request

log = logging.getLogger("gauge-bridge")

# Số đọc có quality dưới ngưỡng này là ảnh mờ / kim bị che: không đẩy vào twin, vì twin coi mọi giá
# trị nhận được là số đo. Cùng ngưỡng với rollup `gauge_1m` của gauge-twin (chỗ lấy dữ liệu cho Predict).
MIN_QUALITY = 0.7


def _get(url: str, timeout: float) -> object:
    with urllib.request.urlopen(url, timeout=timeout) as resp:
        return json.loads(resp.read())


def _post(url: str, body: dict, timeout: float) -> dict:
    req = urllib.request.Request(
        url, data=json.dumps(body).encode(), headers={"Content-Type": "application/json"}, method="POST"
    )
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return json.loads(resp.read() or b"{}")


def source_of(station: dict) -> str:
    """Tên nguồn = topic telemetry mà edge publish cho máy đó (xem gauge-twin/docs/SPEC.md)."""
    return f"denso/{station.get('plant', '')}/{station.get('line', '')}/{station['machine_id']}/telemetry"


def messages_from(stations: list[dict], seen: dict[str, str] | None = None) -> list[dict]:
    """Dựng lô bản tin cho /api/ingest từ ảnh chụp live của gauge-twin.

    `seen` là mốc thời gian đã gửi của từng (máy, đồng hồ): chỉ gửi số đọc MỚI, để không bơm lại
    cùng một giá trị mỗi vòng lặp (twin tính tốc độ theo chuỗi thời gian nên trùng lặp làm lệch).
    Hàm cập nhật `seen` ngay tại chỗ.
    """
    seen = seen if seen is not None else {}
    out: list[dict] = []
    for st in stations:
        machine = st.get("machine_id")
        if not machine:
            continue
        gauges: dict[str, dict] = {}
        newest = ""
        for g in st.get("gauges") or []:
            gid, ts, value = g.get("gauge_id"), g.get("ts"), g.get("value")
            if not gid or not ts or value is None:
                continue
            if (g.get("quality") or 0) < MIN_QUALITY:
                continue
            if seen.get(f"{machine}|{gid}") == ts:
                continue
            seen[f"{machine}|{gid}"] = ts
            gauges[gid] = {"value": value, "unit": g.get("unit") or "", "quality": g.get("quality")}
            newest = max(newest, ts)
        if not gauges:
            continue
        out.append({
            "source": source_of(st),
            "ts": newest,
            "desc": f"Đồng hồ {machine} ({st.get('plant', '')}/{st.get('line', '')})",
            "payload": {"machine_id": machine, "gauges": gauges},
        })
    return out


class Bridge:
    def __init__(self, gauge_url: str, api_url: str, timeout: float = 5.0):
        self.live_url = gauge_url.rstrip("/") + "/v1/live/stations"
        self.ingest_url = api_url.rstrip("/") + "/api/ingest"
        self.timeout = timeout
        self.seen: dict[str, str] = {}

    def tick(self) -> dict:
        """Một vòng: đọc live của gauge-twin, đẩy số đọc mới vào /api/ingest."""
        stations = _get(self.live_url, self.timeout)
        if not isinstance(stations, list):
            raise ValueError(f"{self.live_url} không trả danh sách trạm")
        msgs = messages_from(stations, self.seen)
        if not msgs:
            return {"machines": 0, "readings": 0}
        res = _post(self.ingest_url, {"messages": msgs}, self.timeout)
        return {"machines": len(msgs), "readings": sum(len(m["payload"]["gauges"]) for m in msgs), "api": res}


def main() -> None:
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
    gauge = os.environ.get("GAUGE_QUERY_URL", "http://localhost:8097")
    api = os.environ.get("KF_API_URL", "http://localhost:8080")
    every = float(os.environ.get("GAUGE_BRIDGE_INTERVAL_S", "5"))
    bridge = Bridge(gauge, api)
    log.info("cầu nối đồng hồ: %s -> %s mỗi %.0fs", bridge.live_url, bridge.ingest_url, every)
    quiet = 0
    while True:
        try:
            res = bridge.tick()
            if res["readings"]:
                log.info("đẩy %d số đọc của %d máy", res["readings"], res["machines"])
                quiet = 0
            else:
                quiet += 1
                if quiet % 12 == 1:  # ~mỗi phút, không spam log khi không có số mới
                    log.info("chưa có số đọc mới")
        except (urllib.error.URLError, urllib.error.HTTPError, ValueError, TimeoutError) as exc:
            # Một bên chưa lên thì chờ vòng sau; không được làm chết cầu nối.
            log.warning("vòng này lỗi, thử lại sau: %s", exc)
        time.sleep(every)


if __name__ == "__main__":
    main()
