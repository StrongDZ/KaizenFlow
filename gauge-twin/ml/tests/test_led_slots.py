"""Synthetic LED slots have the format of the builder and show what their label says."""

import numpy as np

from gauge_ml import CLASS_BLANK, DIGIT_H, DIGIT_W
from gauge_ml.dataset import led_slots


def test_render_gives_a_split_in_the_builder_format():
    split = led_slots.render(40, seed=3)
    assert split["images"].shape == (40, DIGIT_H, DIGIT_W) and split["images"].dtype == np.uint8
    assert split["labels"].dtype == np.uint8 and set(split["labels"]) <= set(range(10)) | {CLASS_BLANK}
    # Every slot is its own display.
    assert len(set(split["sequence"])) == 40
    assert set(split["gauge_type"]) == {"seg7"} and set(split["color"]) == {"synthetic-led"}
    keys = {"images", "labels", "sequence", "slot", "station", "gauge_type", "color", "noise_level"}
    assert set(split) == keys | {"occluded", "glare_local"}


def test_render_is_reproducible_and_seeded():
    first, again, other = led_slots.render(8, seed=1), led_slots.render(8, seed=1), led_slots.render(8, seed=2)
    assert np.array_equal(first["images"], again["images"]) and np.array_equal(first["labels"], again["labels"])
    assert not np.array_equal(first["images"], other["images"])


def test_a_digit_is_brighter_than_an_unlit_position_on_average():
    rng = np.random.default_rng(0)
    eights = np.mean([led_slots.render_slot(rng, 8).mean() for _ in range(60)])
    blanks = np.mean([led_slots.render_slot(rng, CLASS_BLANK).mean() for _ in range(60)])
    # Neighbours and visible unlit segments keep a blank from being black, but lit segments add light.
    assert eights > blanks + 5


def test_every_digit_has_a_segment_pattern_of_its_own():
    patterns = [variants[0] for variants in led_slots.SEGMENTS.values()]
    assert sorted(led_slots.SEGMENTS) == list(range(10))
    assert len({"".join(sorted(p)) for p in patterns}) == 10


def test_mix_appends_the_synthetic_slots_with_new_display_ids():
    real = led_slots.render(5, seed=1)
    real["color"][:] = "trodo"
    merged = led_slots.mix(real, led_slots.render(3, seed=2))
    assert len(merged["labels"]) == 8 and merged["images"].shape == (8, DIGIT_H, DIGIT_W)
    assert list(merged["color"]) == ["trodo"] * 5 + ["synthetic-led"] * 3
    assert len(set(merged["sequence"])) == 8
    assert all(merged[key].dtype == real[key].dtype for key in real)
