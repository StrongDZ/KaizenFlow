"""Datasets, training, evaluation and ONNX export of the gauge-reading models."""

# Keypoint order of the dial model (SPEC section 4.1).
KEYPOINTS = ("center", "start", "end", "mid", "tip")
# center: needle pivot; start / end: Min / Max marks of the scale;
# mid: mark at 50% of the range; tip: needle tip.
KP_CENTER, KP_START, KP_END, KP_MID, KP_TIP = range(5)

# Digit classifier classes: 0-9, blank, transition (rolling digit mid-change).
N_DIGIT_CLASSES = 12
CLASS_BLANK = 10
CLASS_TRANSITION = 11

DIAL_INPUT = 256  # dial crop side in pixels
DIGIT_W, DIGIT_H = 32, 48  # digit slot size in pixels
