"""Real photos of time displays on machines (hour meters, panel timers, digital clocks)
collected from openly licensed sources and labelled without a human.

    python -m gauge_ml.timedisp.collect   --root data/public/time-displays
    python -m gauge_ml.timedisp.autolabel --root data/public/time-displays

collect writes raw/<id>.jpg and manifest.csv; autolabel writes labels.jsonl,
which dataset.public.time_displays turns into digit slots. Design:
docs/superpowers/specs/2026-10-05-time-display-dataset-design.md.
"""

KINDS = ("hour_mech", "hour_lcd", "timer_led", "timer_lcd", "clock_led", "clock_lcd")

GAUGE_TYPE = {
    "hour_mech": "rolling_counter",
    "hour_lcd": "seg7",
    "timer_led": "timer_mmss",
    "timer_lcd": "timer_mmss",
    "clock_led": "timer_mmss",
    "clock_lcd": "timer_mmss",
}

# Licences under which a photo may go to train and val; any other goes to test only.
TRAIN_LICENCES = frozenset({"CC0", "PDM", "CC-BY", "CC-BY-SA"})


def polarity_of(kind: str, white_wheels: bool) -> str:
    """Stroke polarity: light strokes on a dark face (LED, black drums) or dark ones (LCD, white drums)."""
    if kind == "hour_mech":
        return "dark" if white_wheels else "light"
    return "dark" if kind.endswith("_lcd") else "light"
