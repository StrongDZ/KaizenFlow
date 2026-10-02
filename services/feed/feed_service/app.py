"""FastAPI điều khiển feed. Web không gọi trực tiếp: Go proxy /api/feed/* sang đây."""
from __future__ import annotations

import os
import threading
import time

from fastapi import FastAPI, HTTPException
from pydantic import BaseModel, Field

from feed_service.frame import ControllerFrame
from feed_service.runner import Runner
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


class SpeedBody(BaseModel):
    speed: float = Field(gt=0)


class ResetBody(BaseModel):
    model: str


class IncidentBody(BaseModel):
    kind: str
    target: str
    duration_s: float | None = Field(default=None, gt=0)
    material: str | None = None
    fraction: float | None = Field(default=None, ge=0, le=1)


def create_app(runner: Runner, client: ApiClient) -> FastAPI:
    app = FastAPI(title="KaizenFlow feed")

    def api_error(exc: ApiError) -> HTTPException:
        return HTTPException(status_code=exc.status if exc.status in (404, 409) else 502, detail=str(exc))

    @app.get("/health")
    def health():
        return {"status": "ok"}

    @app.get("/status")
    def status():
        return runner.status()

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
            runner.start(blueprint, speed=body.speed, truth=Truth(body.cycle_factor, body.demand_factor),
                         frame=ControllerFrame(**body.frame.model_dump()) if body.frame else None)
        except Exception as exc:  # RunRequest hỏng, bản đồ hỏng…
            raise HTTPException(status_code=422, detail=f"không dựng được nhà máy: {exc}")
        return runner.status()

    @app.post("/pause")
    def pause():
        runner.pause()
        return runner.status()

    @app.post("/resume")
    def resume():
        runner.resume()
        return runner.status()

    @app.post("/speed")
    def speed(body: SpeedBody):
        runner.set_speed(body.speed)
        return runner.status()

    @app.post("/stop")
    def stop():
        runner.stop()
        return runner.status()

    @app.post("/reset")
    def reset(body: ResetBody):
        runner.stop()
        try:
            client.clear_live(body.model)
        except ApiError as exc:
            raise api_error(exc)
        return runner.status()

    @app.get("/incidents")
    def incidents():
        return runner.list_incidents()

    @app.post("/incidents", status_code=201)
    def add_incident(body: IncidentBody):
        params = {k: v for k, v in (("material", body.material), ("fraction", body.fraction)) if v is not None}
        try:
            return runner.add_incident(body.kind, body.target, body.duration_s, **params)
        except RuntimeError as exc:
            raise HTTPException(status_code=409, detail=str(exc))
        except ValueError as exc:
            raise HTTPException(status_code=422, detail=str(exc))

    @app.delete("/incidents/{incident_id}", status_code=204)
    def clear_incident(incident_id: int):
        try:
            if not runner.clear_incident(incident_id):
                raise HTTPException(status_code=404, detail="sự cố không còn hiệu lực hoặc không tồn tại")
        except RuntimeError as exc:
            raise HTTPException(status_code=409, detail=str(exc))

    return app


def _autostart(runner: Runner, client: ApiClient, model: str, speed: float) -> None:
    """Bật sẵn cho demo: đợi API sẵn sàng rồi tự start."""
    for _ in range(40):
        try:
            blueprint = client.blueprint(model)
            client.clear_live(model)
            runner.start(blueprint, speed=speed)
            return
        except Exception:
            time.sleep(3)


def build_from_env() -> FastAPI:
    api_url = os.environ.get("KF_API_URL", "http://localhost:8080")
    runner = Runner(HttpSink(api_url), tick_s=float(os.environ.get("FEED_TICK_S", "0.25")))
    client = ApiClient(api_url)
    if model := os.environ.get("FEED_AUTOSTART_MODEL"):
        threading.Thread(target=_autostart, args=(runner, client, model, float(os.environ.get("FEED_AUTOSTART_SPEED", "10"))),
                         daemon=True).start()
    return create_app(runner, client)


app = build_from_env()
