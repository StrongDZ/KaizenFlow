"""Time-display dataset: geometry, consensus, VLM cache, collect helpers, autolabel, loader.

No network and no torch: the VLMs are fakes and the photos are drawn here.
"""

from __future__ import annotations

import json
from pathlib import Path

import cv2
import numpy as np
import pytest

from gauge_ml.timedisp import locate

DIGIT_H = 60


def draw_display(text: str, polarity: str, angle: float = 8.0, seed: int = 0) -> tuple[np.ndarray, tuple]:
    """A photo-like image of `text` ("12:34", "0123.4") on a panel, rotated and seen at a slant.

    Returns the BGR image and a rough box (x0, y0, x1, y1) around the reading,
    looser than the digits like the screening VLM's.
    """
    rng = np.random.default_rng(seed)
    face, ink = (25, 25, 25), (230, 230, 230)
    if polarity == "dark":
        face, ink = ink, face
    pitch = int(0.8 * DIGIT_H)
    band = np.zeros((int(1.6 * DIGIT_H), pitch * len(text) + 60, 3), np.uint8)
    band[:] = face
    x = 20
    for ch in text:
        if ch == ":":
            for dy in (-0.2, 0.2):
                cv2.circle(band, (x + 8, int(band.shape[0] / 2 + dy * DIGIT_H)), 4, ink, -1)
            x += 26
        elif ch == ".":
            cv2.circle(band, (x + 6, int(band.shape[0] / 2 + 0.45 * DIGIT_H)), 4, ink, -1)
            x += 20
        else:
            org = (x, int(band.shape[0] / 2 + DIGIT_H / 2))
            cv2.putText(band, ch, org, cv2.FONT_HERSHEY_SIMPLEX, DIGIT_H / 22.0, ink, 5, cv2.LINE_AA)
            x += pitch
    band = band[:, : x + 20]
    canvas = np.full((480, 640, 3), 120, np.uint8)
    canvas += rng.integers(0, 20, canvas.shape, dtype=np.uint8)
    h, w = band.shape[:2]
    ox, oy = (640 - w) // 2, (480 - h) // 2
    canvas[oy : oy + h, ox : ox + w] = band
    m = cv2.getRotationMatrix2D((320, 240), angle, 1.0)
    rotated = cv2.warpAffine(canvas, m, (640, 480), borderMode=cv2.BORDER_REPLICATE)
    src = np.float32([[0, 0], [640, 0], [640, 480], [0, 480]])
    dst = np.float32([[10, 0], [630, 15], [640, 470], [0, 480]])
    image = cv2.warpPerspective(rotated, cv2.getPerspectiveTransform(src, dst), (640, 480))
    corners = np.float32([[ox, oy], [ox + w, oy], [ox + w, oy + h], [ox, oy + h]]).reshape(-1, 1, 2)
    corners = cv2.perspectiveTransform(cv2.transform(corners, m), cv2.getPerspectiveTransform(src, dst)).reshape(-1, 2)
    x0, y0 = corners.min(axis=0)
    x1, y1 = corners.max(axis=0)
    return image, (float(x0 - 10), float(y0 - 8), float(x1 + 10), float(y1 + 8))


def cells_of(image: np.ndarray, box: tuple, polarity: str) -> list:
    quad = locate.refine_quad(image, box, polarity)
    assert quad is not None
    band = cv2.cvtColor(locate.rectify(image, quad, 64), cv2.COLOR_BGR2GRAY)
    return locate.find_cells(band, polarity)


@pytest.mark.parametrize(
    ("text", "polarity", "digits"),
    [("12:34", "light", 4), ("0123.4", "dark", 5), ("08:15:42", "light", 6), ("99999", "dark", 5)],
)
def test_cells_follow_digits_not_separators(text: str, polarity: str, digits: int) -> None:
    image, box = draw_display(text, polarity)
    cells = cells_of(image, box, polarity)
    assert len(cells) == digits
    assert [c[0] for c in cells] == sorted(c[0] for c in cells)


def test_faint_gaps_between_drums_are_not_digits() -> None:
    band = np.full((64, 260, 3), 25, np.uint8)
    for i, ch in enumerate("0193"):
        cv2.putText(band, ch, (10 + 62 * i, 54), cv2.FONT_HERSHEY_SIMPLEX, 2.0, (230, 230, 230), 5, cv2.LINE_AA)
        cv2.rectangle(band, (52 + 62 * i, 6), (58 + 62 * i, 58), (75, 75, 75), -1)  # dim drum gap
    gray = cv2.cvtColor(band, cv2.COLOR_BGR2GRAY)
    assert len(locate.find_cells(gray, "light")) == 4


def test_order_quad() -> None:
    q = locate.order_quad(np.float32([[10, 12], [0, 0], [0, 10], [10, 1]]))
    assert q.tolist() == [[0, 0], [10, 1], [10, 12], [0, 10]]


def test_refine_quad_rejects_empty_box() -> None:
    image = np.full((100, 100, 3), 128, np.uint8)
    assert locate.refine_quad(image, (10, 10, 60, 40), "light") is None
    assert locate.refine_quad(image, (50, 50, 40, 40), "light") is None


# --- consensus and licences ----------------------------------------------------------------------------------------

from gauge_ml.timedisp.autolabel import agree, label_image  # noqa: E402
from gauge_ml.timedisp.collect import dhash, hamming, normalize_licence, resize_long_side  # noqa: E402
from gauge_ml.timedisp.vlm import CachedReader, gemini_schema, parse_json  # noqa: E402


def read(text: str, rolling: str | None = None, readable: bool = True) -> dict:
    return {"readable": readable, "text": text, "rolling": rolling if rolling is not None else "0" * len(text)}


def test_agree() -> None:
    assert agree(read("01234"), read("01234"), 5) == ("01234", "00000")
    assert agree(read("12:34", "0000"), read("1234"), 4) == ("1234", "0000")  # separators are not digits
    assert agree(read("0129", "0001"), read("0129", "0001"), 4) == ("0129", "0001")
    assert agree(read("0129", "0001"), read("0129", "0000"), 4) == "disagree"
    assert agree(read("01234"), read("01284"), 5) == "disagree"
    assert agree(read("01234"), read("01234"), 6) == "cells"
    assert agree(read("", readable=False), read("01234"), 5) == "unreadable"
    assert agree(None, read("01234"), 5) == "unreadable"
    assert agree(read("12a4"), read("12a4"), 4) == "unreadable"
    assert agree(read("1234", "01"), read("1234", "01"), 4) == "unreadable"


@pytest.mark.parametrize(
    ("raw", "expected"),
    [
        ("by-sa", "CC-BY-SA"),
        ("by", "CC-BY"),
        ("CC BY-SA 4.0", "CC-BY-SA"),
        ("CC BY 2.0", "CC-BY"),
        ("cc0", "CC0"),
        ("CC0 1.0", "CC0"),
        ("Public domain", "PDM"),
        ("pdm", "PDM"),
        ("by-nc", "CC-BY-NC"),
        ("", "unknown"),
    ],
)
def test_normalize_licence(raw: str, expected: str) -> None:
    assert normalize_licence(raw) == expected


def test_dhash_finds_near_duplicates() -> None:
    image, _ = draw_display("12:34", "light")
    other, _ = draw_display("0123.4", "dark", angle=-20, seed=3)
    small = cv2.resize(image, (320, 240))
    assert hamming(dhash(image), dhash(small)) <= 6
    assert hamming(dhash(image), dhash(other)) > 6


def test_resize_long_side() -> None:
    assert resize_long_side(np.zeros((2000, 1000, 3), np.uint8)).shape[:2] == (1568, 784)
    assert resize_long_side(np.zeros((300, 200, 3), np.uint8)).shape[:2] == (300, 200)


# --- VLM cache -----------------------------------------------------------------------------------------------------


class FakeReader:
    def __init__(self, name: str, answers) -> None:
        self.name = name
        self.answers = answers
        self.calls = 0

    def ask(self, image: bytes, prompt: str, schema: dict) -> dict | None:
        self.calls += 1
        return self.answers(image, prompt) if callable(self.answers) else self.answers


def test_cache_answers_repeated_questions(tmp_path: Path) -> None:
    fake = FakeReader("model-a", {"x": 1})
    reader = CachedReader(fake, tmp_path)
    assert reader.ask(b"img", "p", {}) == {"x": 1}
    assert reader.ask(b"img", "p", {}) == {"x": 1}
    assert fake.calls == 1
    reader.ask(b"img2", "p", {})
    assert fake.calls == 2


def test_parse_json_and_gemini_schema() -> None:
    assert parse_json('```json\n{"a": 1}\n```') == {"a": 1}
    assert parse_json("not json") is None
    assert parse_json("[1, 2]") is None
    schema = {
        "type": "object",
        "properties": {"box": {"type": "array", "items": {"type": "integer", "additionalProperties": False}}},
        "additionalProperties": False,
    }
    assert "additionalProperties" not in json.dumps(gemini_schema(schema))


# --- autolabel -----------------------------------------------------------------------------------------------------


def screener_for(box: tuple, kind: str = "timer_led") -> FakeReader:
    return FakeReader("claude", {"kind": kind, "box": [int(v) for v in box], "digits": 4, "white_wheels": False})


def test_label_image_accepts_when_readers_agree() -> None:
    image, box = draw_display("12:34", "light")
    row = {"id": "op-1", "source": "openverse", "license": "CC-BY"}
    a, b = FakeReader("claude", read("1234")), FakeReader("gemini", read("1234"))
    entry = label_image(image, row, screener_for(box), (a, b))
    assert entry["status"] == "accepted", entry
    assert entry["text"] == "1234" and entry["rolling"] == "0000"
    assert entry["gauge_type"] == "timer_mmss" and entry["polarity"] == "light"
    assert len(entry["cells"]) == 4 and len(entry["quad"]) == 4
    assert entry["eval_only"] is False


def test_label_image_scales_the_screening_box_of_large_photos() -> None:
    small, box = draw_display("12:34", "light")
    image = cv2.resize(small, None, fx=3, fy=3, interpolation=cv2.INTER_CUBIC)  # 1920x1440, above Claude's limit

    def answer(jpeg: bytes, prompt: str) -> dict:
        sent_w = int(prompt.split("The image is ")[1].split("x")[0])
        k = sent_w / small.shape[1]
        return {"kind": "timer_led", "box": [round(v * k) for v in box], "digits": 4, "white_wheels": False}

    same = FakeReader("claude", read("1234"))
    entry = label_image(image, {"id": "big", "license": "CC0"}, FakeReader("claude", answer), (same, same))
    assert entry["status"] == "accepted", entry
    assert entry["screen"]["box"][2] < image.shape[1] * 0.75  # the model saw a smaller copy


def test_label_image_rejections() -> None:
    image, box = draw_display("12:34", "light")
    row = {"id": "op-2", "source": "openverse", "license": "CC-BY-NC"}
    same = FakeReader("claude", read("1234"))
    entry = label_image(image, row, screener_for(box), (same, FakeReader("gemini", read("1284"))))
    assert (entry["status"], entry["reason"], entry["eval_only"]) == ("rejected", "disagree", True)
    entry = label_image(image, row, screener_for(box, kind="other"), (same, same))
    assert entry["reason"] == "not_target"
    entry = label_image(image, row, screener_for((0, 0, 0, 0)), (same, same))
    assert entry["reason"] == "no_quad"


# --- loader and build_real -----------------------------------------------------------------------------------------


@pytest.fixture
def labelled_root(tmp_path: Path) -> Path:
    raw = tmp_path / "raw"
    raw.mkdir()
    entries = []
    for i, (text, digits, rolling, licence) in enumerate(
        [("12:34", "1234", "0000", "CC-BY"), ("01239", "01239", "00001", "CC-BY-NC")]
    ):
        polarity = "light"
        image, box = draw_display(text, polarity, seed=i)
        cv2.imwrite(str(raw / f"id-{i}.jpg"), image)
        entry = label_image(
            image,
            {"id": f"id-{i}", "license": licence},
            screener_for(box, kind="hour_mech"),
            (FakeReader("a", read(digits, rolling)), FakeReader("b", read(digits, rolling))),
        )
        assert entry["status"] == "accepted", entry
        entries.append(entry)
    entries.append({"id": "id-9", "status": "rejected", "reason": "disagree"})
    (tmp_path / "labels.jsonl").write_text("".join(json.dumps(e) + "\n" for e in entries))
    return tmp_path


def test_loader_yields_framed_slots(labelled_root: Path) -> None:
    from gauge_ml import CLASS_TRANSITION, DIGIT_H, DIGIT_W
    from gauge_ml.dataset.public import time_displays

    samples = list(time_displays.load(labelled_root))
    assert [label for _, label, _ in samples] == [1, 2, 3, 4, 0, 1, 2, 3, CLASS_TRANSITION]
    assert all(slot.shape == (DIGIT_H, DIGIT_W) for slot, _, _ in samples)
    assert [m["eval_only"] for _, _, m in samples] == [False] * 4 + [True] * 5
    assert {m["gauge_type"] for _, _, m in samples} == {"rolling_counter"}
    assert [m["slot"] for _, _, m in samples] == [0, 1, 2, 3, 0, 1, 2, 3, 4]


def test_build_real_sends_eval_only_samples_to_test(labelled_root: Path, tmp_path: Path) -> None:
    from gauge_ml.dataset import build_real

    public = tmp_path / "public"
    public.mkdir()
    (public / "time-displays").symlink_to(labelled_root)
    out = tmp_path / "out"
    summary = build_real.build_digits(public, out, ["time-displays"])
    with np.load(out / "digits" / "test.npz") as test:
        assert (test["labels"] == 11).sum() == 1  # the rolling drum of the eval-only photo
    assert summary["time-displays"]["test"] >= 5
