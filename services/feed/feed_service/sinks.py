"""Nói chuyện với Go API: đẩy bản tin, lấy blueprint, xoá dữ liệu live."""
from __future__ import annotations

import json
import urllib.error
import urllib.parse
import urllib.request


class ApiError(Exception):
    def __init__(self, status: int, message: str):
        super().__init__(message)
        self.status = status


def _call(method: str, url: str, body: dict | None = None, timeout: float = 10.0):
    data = None if body is None else json.dumps(body).encode()
    req = urllib.request.Request(url, data=data, method=method, headers={"Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            raw = resp.read()
            return json.loads(raw) if raw else None
    except urllib.error.HTTPError as exc:
        try:
            message = json.loads(exc.read()).get("error") or exc.reason
        except Exception:
            message = str(exc.reason)
        raise ApiError(exc.code, message) from exc
    except urllib.error.URLError as exc:
        raise ApiError(502, f"không nối được API: {exc.reason}") from exc


class HttpSink:
    """Sink của Runner: POST lô bản tin vào /api/ingest."""

    def __init__(self, api_url: str, timeout: float = 5.0):
        self.url = api_url.rstrip("/") + "/api/ingest"
        self.timeout = timeout
        # Mô hình mà các bản tin thuộc về; Runner đặt khi bắt đầu phát. API dùng nó để ghi nguồn dữ liệu vào đúng mô hình.
        self.model: str | None = None

    def __call__(self, messages: list[dict]) -> None:
        body: dict = {"messages": messages}
        if self.model:
            body["model"] = self.model
        _call("POST", self.url, body, self.timeout)


class ApiClient:
    def __init__(self, api_url: str):
        self.base = api_url.rstrip("/")

    def blueprint(self, model: str) -> dict:
        return _call("GET", f"{self.base}/api/models/{urllib.parse.quote(model)}/live/blueprint")

    def clear_live(self, model: str) -> None:
        _call("DELETE", f"{self.base}/api/models/{urllib.parse.quote(model)}/live")
