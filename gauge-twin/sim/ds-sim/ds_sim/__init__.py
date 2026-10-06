"""ds-sim: what ds-pipeline does, on the CPU.

Reads the RTSP streams of the station configs, crops the gauge ROIs, runs the
two ONNX models as described by their preprocess.json, measures sharpness,
glare and ROI drift, and sends FrameResult messages over ZeroMQ. It is the
reference the DeepStream pipeline is compared against.
"""
