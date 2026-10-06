"""Tests for the Python code generated from schemas/proto (run `make proto` first)."""

from denso.gauge.v1 import frame_result_pb2

# digit_cls classes: 0-9, blank, transition.
N_DIGIT_CLASSES = 12


def test_frame_result_round_trip():
    msg = frame_result_pb2.FrameResult(camera_id="cam-1", frame_ts_ms=1_700_000_000_000)
    roi = msg.rois.add(gauge_id="VOLTMETER", sharpness=120.5, glare_ratio=0.25)
    roi.slot_probs.add(probs=[0.0] * N_DIGIT_CLASSES)
    roi.keypoints.add(x=1.5, y=2.5)

    out = frame_result_pb2.FrameResult.FromString(msg.SerializeToString())

    assert out == msg
    assert len(out.rois[0].slot_probs[0].probs) == N_DIGIT_CLASSES
