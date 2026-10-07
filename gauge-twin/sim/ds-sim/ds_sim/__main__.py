"""Entry point: python -m ds_sim. Configuration comes from the environment."""

from __future__ import annotations

import json
import os
import signal
import sys
import time
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import zmq
from denso.gauge.v1 import command_pb2

from ds_sim import station
from ds_sim.capture import Camera
from ds_sim.inference import Models
from ds_sim.measure import DriftDetector
from ds_sim.pipeline import process_frame
from ds_sim.zmqio import CommandServer, FramePublisher


def log(level: str, message: str, **fields) -> None:
    record = {
        "time": time.strftime("%Y-%m-%dT%H:%M:%S%z"),
        "level": level,
        "service": "ds-sim",
        "msg": message,
    }
    print(json.dumps(record | fields), flush=True)


class App:
    def __init__(self) -> None:
        self.config_dir = Path(os.environ.get("CONFIG_DIR", "/var/lib/edge-agent/config"))
        self.drift_interval_s = float(os.environ.get("DRIFT_INTERVAL", "600"))
        self.drift_threshold_px = float(os.environ.get("DRIFT_THRESHOLD_PX", "8"))
        self.models = Models(
            Path(os.environ.get("MODEL_DIR", "/models")),
            int(os.environ.get("INFERENCE_THREADS", "1")),
        )
        context = zmq.Context()
        self.publisher = FramePublisher(
            context, os.environ.get("FRAMES_ENDPOINT", "ipc:///tmp/zmq/frames")
        )
        self.commands = CommandServer(
            context, os.environ.get("CONTROL_ENDPOINT", "ipc:///tmp/zmq/control"), self.handle
        )
        self.stations: dict[str, tuple[station.StationConfig, Camera, DriftDetector]] = {}
        self.running = True
        self.exit_code = 0

    def load(self, machine_id: str, min_version: int = 0) -> None:
        """Loads <config_dir>/<machine_id>.json and (re)starts its camera."""
        config = station.load(self.config_dir / f"{machine_id}.json")
        if config.machine_id != machine_id:
            raise ValueError(f"file is for machine {config.machine_id!r}")
        if config.config_version < min_version:
            raise ValueError(f"file has version {config.config_version}, expected {min_version}")
        if not config.camera_url:
            raise ValueError("camera url is empty")
        previous = self.stations.pop(machine_id, None)
        if previous is not None and previous[0].camera_url == config.camera_url:
            camera = previous[1]
            camera.interval_s = 1.0 / max(config.sample_fps, 0.1)
        else:
            if previous is not None:
                previous[1].close()
            camera = Camera(config.camera_url, config.sample_fps)
        # A new config means new ROIs: the drift reference starts over.
        detector = DriftDetector(self.drift_interval_s, self.drift_threshold_px)
        self.stations[machine_id] = (config, camera, detector)
        log(
            "INFO",
            "config loaded",
            machine_id=machine_id,
            config_version=config.config_version,
            gauges=len(config.gauges),
            camera=config.camera_url,
        )

    def process(self, config, detector, frame, ts_ms):
        drift = detector.update(frame, time.monotonic())
        return process_frame(config, frame, ts_ms, self.models, drift)

    def handle(self, command: command_pb2.Command) -> tuple[bool, str]:
        if command.type == command_pb2.COMMAND_TYPE_RELOAD_CONFIG:
            self.load(command.machine_id, command.config_version)
            return True, ""
        if command.type == command_pb2.COMMAND_TYPE_RESTART:
            log("WARNING", "restart requested by edge-agent", machine_id=command.machine_id)
            self.running = False
            return True, ""
        return False, f"unsupported command type {command.type}"

    def run(self) -> int:
        # Configs of a previous run: keep working if only this process restarted.
        for path in sorted(self.config_dir.glob("*.json")):
            try:
                self.load(path.stem)
            except Exception as exc:  # noqa: BLE001 - a bad file must not stop the others
                log("ERROR", "stored config ignored", file=str(path), error=str(exc))
        log("INFO", "started", stations=len(self.stations))
        last_report = time.monotonic()
        processed = 0
        workers = int(os.environ.get("WORKERS", "4"))
        with ThreadPoolExecutor(max_workers=workers, thread_name_prefix="frame") as pool:
            while self.running:
                self.commands.poll(0)
                # One frame per camera at most, processed in parallel: OpenCV
                # and onnxruntime release the GIL. The socket is only used here.
                jobs = []
                for config, camera, detector in list(self.stations.values()):
                    sample = camera.take()
                    if sample is not None:
                        jobs.append(pool.submit(self.process, config, detector, *sample))
                for job in jobs:
                    self.publisher.send(job.result())
                    processed += 1
                if not jobs:
                    self.commands.poll(20)
                if time.monotonic() - last_report >= 30:
                    log(
                        "INFO",
                        "progress",
                        frames=processed,
                        sent=self.publisher.sent,
                        dropped=self.publisher.dropped,
                    )
                    last_report = time.monotonic()
        for _, camera, _ in self.stations.values():
            camera.close()
        return self.exit_code


def main() -> int:
    # RTSP over TCP, as cameras behind a factory network need. OpenCV opens
    # streams one at a time, so the probing of each is kept short.
    os.environ.setdefault(
        "OPENCV_FFMPEG_CAPTURE_OPTIONS",
        "rtsp_transport;tcp|analyzeduration;500000|probesize;500000",
    )
    app = App()

    def stop(*_: object) -> None:
        app.running = False

    signal.signal(signal.SIGTERM, stop)
    signal.signal(signal.SIGINT, stop)
    return app.run()


if __name__ == "__main__":
    sys.exit(main())
