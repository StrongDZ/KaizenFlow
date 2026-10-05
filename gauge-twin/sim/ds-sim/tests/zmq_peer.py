"""libzmq peer for the Go interoperability test (edge-agent, tag interop).

Pushes FrameResult messages every 2 ms with timestamps 100 ms apart and
answers RELOAD_CONFIG commands: even versions succeed, odd ones fail.
Usage: python zmq_peer.py <frames-endpoint> <control-endpoint> <seconds>
"""

import sys
import time

import zmq
from denso.gauge.v1 import command_pb2, frame_result_pb2
from ds_sim.zmqio import CommandServer, FramePublisher


def handle(command: command_pb2.Command) -> tuple[bool, str]:
    if command.type != command_pb2.COMMAND_TYPE_RELOAD_CONFIG:
        return False, "unsupported command"
    if command.config_version % 2:
        return False, f"odd version {command.config_version}"
    return True, ""


def main() -> None:
    frames_endpoint, control_endpoint, seconds = sys.argv[1], sys.argv[2], float(sys.argv[3])
    context = zmq.Context()
    publisher = FramePublisher(context, frames_endpoint)
    commands = CommandServer(context, control_endpoint, handle)
    deadline, index = time.monotonic() + seconds, 0
    while time.monotonic() < deadline:
        ts_ms = 1_700_000_000_000 + 100 * index
        frame = frame_result_pb2.FrameResult(camera_id="machine_001", frame_ts_ms=ts_ms)
        frame.rois.add(gauge_id="MAIN_PRESSURE", kp_conf=[0.9] * 5).keypoints.add(x=1.5, y=2.5)
        digits = frame.rois.add(gauge_id="VOLTMETER", sharpness=120.5, roi_drift=True, drift_px=3.5)
        for _ in range(4):
            digits.slot_probs.add(probs=[1.0 / 12] * 12)
        # Only advance once a peer took the frame, so the receiver sees no gaps.
        if publisher.send(frame):
            index += 1
        commands.poll(0)
        time.sleep(0.002)
    print(f"sent={publisher.sent} dropped={publisher.dropped}")


if __name__ == "__main__":
    main()
