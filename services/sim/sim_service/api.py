"""FastAPI sim-service. Chạy: uvicorn sim_service.api:app --port 8081"""
from __future__ import annotations

import os
import threading

from fastapi import BackgroundTasks, FastAPI, HTTPException
from fastapi.encoders import jsonable_encoder
from fastapi.responses import PlainTextResponse

from sim_service.contract import ENGINE_VERSION, ContractError, RunRequest, validate_refs
from sim_service.pipeline import execute, to_csv

app = FastAPI(title="KaizenFlow sim-service", version=ENGINE_VERSION)
_runs: dict[int, dict] = {}
_lock = threading.Lock()


def _workers() -> int:
    return int(os.environ.get("SIM_WORKERS", "1"))


def _execute(req: RunRequest) -> None:
    try:
        state = {"status": "DONE", "result": execute(req, _workers())}
    except Exception as exc:  # lỗi được trả về qua GET /runs/{id}
        state = {"status": "FAILED", "error": f"{type(exc).__name__}: {exc}"}
    with _lock:
        _runs[req.run_id] = state


@app.post("/runs", status_code=202)
def create_run(req: RunRequest, background: BackgroundTasks):
    try:
        validate_refs(req)
    except ContractError as exc:
        raise HTTPException(status_code=422, detail={"key": exc.key, "message": str(exc)})
    with _lock:
        _runs[req.run_id] = {"status": "RUNNING"}
    background.add_task(_execute, req)
    return {"run_id": req.run_id, "status": "RUNNING"}


@app.post("/validate")
def validate(req: RunRequest):
    try:
        validate_refs(req)
    except ContractError as exc:
        raise HTTPException(status_code=422, detail={"key": exc.key, "message": str(exc)})
    return {"ok": True}


@app.get("/runs/{run_id}")
def get_run(run_id: int):
    st = _runs.get(run_id)
    if st is None:
        raise HTTPException(status_code=404, detail="run not found")
    body: dict = {"run_id": run_id, "status": st["status"]}
    if st["status"] == "DONE":
        r = st["result"]
        body.update(engine_version=r.engine_version, kpis=r.kpis, insights=r.insights, bands_count=len(r.bands))
    elif st["status"] == "FAILED":
        body["error"] = st["error"]
    return jsonable_encoder(body)


@app.get("/runs/{run_id}/result")
def get_result(run_id: int):
    st = _runs.get(run_id)
    if st is None:
        raise HTTPException(status_code=404, detail="run not found")
    if st["status"] != "DONE":
        raise HTTPException(status_code=409, detail=f"run is {st['status']}")
    r = st["result"]
    return jsonable_encoder({"run_id": r.run_id, "engine_version": r.engine_version, "kpis": r.kpis,
                             "bands": r.bands, "insights": r.insights, "signals": r.signals, "events": r.events,
                             "warehouse_series_log": r.warehouse_series_log})


@app.get("/runs/{run_id}/warehouse_series")
def get_warehouse_series(run_id: int):
    st = _runs.get(run_id)
    if st is None:
        raise HTTPException(status_code=404, detail="run not found")
    if st["status"] != "DONE":
        raise HTTPException(status_code=409, detail=f"run is {st['status']}")
    r = st["result"]
    return jsonable_encoder({"run_id": r.run_id, "warehouse_series_log": r.warehouse_series_log,
                             "count": len(r.warehouse_series_log)})


@app.get("/runs/{run_id}/export.csv")
def export_csv(run_id: int):
    st = _runs.get(run_id)
    if st is None:
        raise HTTPException(status_code=404, detail="run not found")
    if st["status"] != "DONE":
        raise HTTPException(status_code=409, detail=f"run is {st['status']}")
    return PlainTextResponse(to_csv(st["result"]), media_type="text/csv")
