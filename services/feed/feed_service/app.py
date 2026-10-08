"""FastAPI điều khiển feed. Web không gọi trực tiếp: Go proxy /api/feed/* sang đây."""
from __future__ import annotations

import os
import threading
import time

from fastapi import FastAPI, HTTPException, Query
from pydantic import BaseModel, Field

from feed_service.frame import ControllerFrame
from feed_service.runner import PoolFull, Runner, RunnerPool
from feed_service.scale import Truth
from feed_service.sinks import ApiClient, ApiError, HttpSink


class FrameBody(BaseModel):
    """Hệ toạ độ hãng xe giả lập (cùng nghĩa với khung toạ độ của API); bỏ trống là phát thẳng toạ độ bản đồ."""
    dx: float = 0.0
    dy: float = 0.0
    rot_deg: float = 0.0
    scale: float = Field(default=1.0, gt=0)
    flip_y: bool = False
    noise_m: float = Field(default=0.05, ge=0)


class StartBody(BaseModel):
    model: str
    frame: FrameBody | None = None
    speed: float = Field(default=10.0, gt=0)
    cycle_factor: float = Field(default=Truth.cycle_factor, gt=0)
    demand_factor: float = Field(default=Truth.demand_factor, gt=0)


class ModelBody(BaseModel):
    model: str


class SpeedBody(BaseModel):
    model: str
    speed: float = Field(gt=0)


class IncidentBody(BaseModel):
    model: str
    kind: str
    target: str
    duration_s: float | None = Field(default=None, gt=0)
    material: str | None = None
    fraction: float | None = Field(default=None, ge=0, le=1)


def create_app(pool: RunnerPool, client: ApiClient) -> FastAPI:
    """Mỗi mô hình một runner độc lập: mọi lệnh điều khiển đều nêu rõ mô hình, lệnh cho mô hình này không đụng tới mô hình khác."""
    app = FastAPI(title="KaizenFlow feed")

    def api_error(exc: ApiError) -> HTTPException:
        return HTTPException(status_code=exc.status if exc.status in (404, 409) else 502, detail=str(exc))

    @app.get("/health")
    def health():
        return {"status": "ok"}

    @app.get("/status")
    def status(model: str = Query(min_length=1)):
        return pool.status(model)

    @app.get("/feeds")
    def feeds():
        """Mọi mô hình đang chạy hoặc tạm dừng."""
        return pool.statuses()

    @app.post("/start")
    def start(body: StartBody):
        try:
            blueprint = client.blueprint(body.model)
        except ApiError as exc:
            raise api_error(exc)
        try:
            # Giờ ảo bắt đầu lại từ giờ hiện tại nên dữ liệu live của phiên trước (có thể ở "tương lai") không còn khớp.
            client.clear_live(body.model)
        except ApiError as exc:
            raise api_error(exc)
        try:
            pool.start(body.model, blueprint, speed=body.speed, truth=Truth(body.cycle_factor, body.demand_factor),
                       frame=ControllerFrame(**body.frame.model_dump()) if body.frame else None)
        except PoolFull as exc:
            raise HTTPException(status_code=409, detail=str(exc))
        except Exception as exc:  # RunRequest hỏng, bản đồ hỏng…
            raise HTTPException(status_code=422, detail=f"không dựng được nhà máy: {exc}")
        return pool.status(body.model)

    @app.post("/pause")
    def pause(body: ModelBody):
        pool.pause(body.model)
        return pool.status(body.model)

    @app.post("/resume")
    def resume(body: ModelBody):
        pool.resume(body.model)
        return pool.status(body.model)

    @app.post("/speed")
    def speed(body: SpeedBody):
        pool.set_speed(body.model, body.speed)
        return pool.status(body.model)

    @app.post("/stop")
    def stop(body: ModelBody):
        pool.stop(body.model)
        return pool.status(body.model)

    @app.post("/reset")
    def reset(body: ModelBody):
        pool.stop(body.model)
        try:
            client.clear_live(body.model)
        except ApiError as exc:
            raise api_error(exc)
        return pool.status(body.model)

    @app.get("/incidents")
    def incidents(model: str = Query(min_length=1)):
        return pool.list_incidents(model)

    @app.post("/incidents", status_code=201)
    def add_incident(body: IncidentBody):
        params = {k: v for k, v in (("material", body.material), ("fraction", body.fraction)) if v is not None}
        try:
            return pool.add_incident(body.model, body.kind, body.target, body.duration_s, **params)
        except RuntimeError as exc:
            raise HTTPException(status_code=409, detail=str(exc))
        except ValueError as exc:
            raise HTTPException(status_code=422, detail=str(exc))

    @app.delete("/incidents/{incident_id}", status_code=204)
    def clear_incident(incident_id: int, model: str = Query(min_length=1)):
        try:
            if not pool.clear_incident(model, incident_id):
                raise HTTPException(status_code=404, detail="sự cố không còn hiệu lực hoặc không tồn tại")
        except RuntimeError as exc:
            raise HTTPException(status_code=409, detail=str(exc))

    return app


def _autostart(pool: RunnerPool, client: ApiClient, model: str, speed: float) -> None:
    """Bật sẵn cho demo: đợi API sẵn sàng rồi tự start."""
    for _ in range(40):
        try:
            blueprint = client.blueprint(model)
            client.clear_live(model)
            pool.start(model, blueprint, speed=speed)
            return
        except PoolFull:
            return
        except Exception:
            time.sleep(3)


def build_from_env() -> FastAPI:
    api_url = os.environ.get("KF_API_URL", "http://localhost:8080")
    tick_s = float(os.environ.get("FEED_TICK_S", "0.25"))
    # Mỗi mô hình một HttpSink riêng: sink gắn tên mô hình vào từng lô để API chỉ áp lô đó cho đúng mô hình.
    pool = RunnerPool(lambda model: Runner(HttpSink(api_url), tick_s=tick_s), max_runners=int(os.environ.get("FEED_MAX_MODELS", "8")))
    client = ApiClient(api_url)
    speed = float(os.environ.get("FEED_AUTOSTART_SPEED", "10"))
    # FEED_AUTOSTART_MODEL nhận một hoặc nhiều mô hình, ngăn cách bằng dấu phẩy.
    for model in (m.strip() for m in os.environ.get("FEED_AUTOSTART_MODEL", "").split(",")):
        if model:
            threading.Thread(target=_autostart, args=(pool, client, model, speed), daemon=True).start()
    return create_app(pool, client)


app = build_from_env()
