"""Labels the collected photos without a human: two VLMs from different vendors must agree.

    python -m gauge_ml.timedisp.autolabel --root data/public/time-displays [--limit N] [--audit 50]

Per image:
  1. screen  Claude says whether it shows a target display, which kind, a rough
             box around the main reading and whether drums are white;
  2. refine  OpenCV turns the box into a quad hugging the digits and finds the
             box of every digit in the straightened band (locate.py);
  3. read    Claude and Gemini read the straightened crop independently;
  4. agree   accepted only when both give the same digits and the same rolling
             positions, and the digit count equals the number of boxes found.

The digit classifier under evaluation plays no part, so the test labels do not
lean towards what it already reads. Output: labels.jsonl (one line per image,
appended, so a stopped run resumes), report.json and, with --audit, audit.html.
"""

from __future__ import annotations

import argparse
import base64
import csv
import json
import random
import sys
from collections import Counter
from pathlib import Path

import cv2
import numpy as np

from gauge_ml.timedisp import GAUGE_TYPE, KINDS, TRAIN_LICENCES, polarity_of
from gauge_ml.timedisp.locate import find_cells, order_quad, rectify, refine_quad
from gauge_ml.timedisp.vlm import (
    DEFAULT_CLAUDE_MODEL,
    DEFAULT_GEMINI_MODEL,
    CachedReader,
    ClaudeReader,
    GeminiReader,
    Reader,
    TransientError,
)

# Height of the straightened band the digit boxes are measured in.
BAND_H = 64
# Height of the crop the readers see, and its margin around the digits
# (share of the band height above/below, of its width left/right).
READ_H = 160
READ_MARGIN = (0.1, 0.35)
# Largest image Claude takes without downscaling it.
SCREEN_PIXELS = 1_150_000

SCREEN_SCHEMA = {
    "type": "object",
    "properties": {
        "kind": {"type": "string", "enum": [*KINDS, "other"]},
        "box": {"type": "array", "items": {"type": "integer"}},
        "digits": {"type": "integer"},
        "white_wheels": {"type": "boolean"},
    },
    "required": ["kind", "box", "digits", "white_wheels"],
    "additionalProperties": False,
}

READ_SCHEMA = {
    "type": "object",
    "properties": {
        "readable": {"type": "boolean"},
        "text": {"type": "string"},
        "rolling": {"type": "string"},
    },
    "required": ["readable", "text", "rolling"],
    "additionalProperties": False,
}

SCREEN_PROMPT = """The image is {width}x{height} pixels.

Decide whether it is a photo of one of these devices with a legible numeric reading:
- hour_mech: mechanical hour meter (digits on rotating drums) on a machine, engine or panel;
- hour_lcd: electronic hour meter with an LCD;
- timer_led / timer_lcd: electronic panel timer or counter (LED or LCD), e.g. a timer relay or cycle timer;
- clock_led / clock_lcd: digital clock (LED or LCD).
Use kind "other" for anything else: car odometers, energy, water or gas meters, multimeters, phones, computer
screens, analog clocks, drawings, or a device whose digits are not legible.

For a target device give:
- box: [x0, y0, x1, y1] in pixels of this image, tightly around the digits of the main reading (the largest line
  of digits when there are several, e.g. the PV line of a two-line timer);
- digits: the number of digit positions in that line;
- white_wheels: true when a mechanical counter shows dark digits on light drums, otherwise false.
For kind "other" give box [0, 0, 0, 0], digits 0 and white_wheels false."""

READ_PROMPT = """The image is a straightened crop of a numeric display (hour meter, timer or clock).

Read the digits of the main line, left to right:
- text: digits only, no colon, decimal point, unit or letter; keep displayed leading zeros;
- rolling: one character per digit, "1" for a mechanical drum caught between two numbers, otherwise "0";
  such a drum is read as the number it is leaving (the lower one, and 9 when rolling from 9 to 0);
- readable: false when any digit cannot be read with confidence (then text and rolling may be empty)."""


def encode_jpeg(image: np.ndarray, quality: int = 92) -> bytes:
    ok, data = cv2.imencode(".jpg", image, [cv2.IMWRITE_JPEG_QUALITY, quality])
    if not ok:
        raise ValueError("cannot encode image")
    return data.tobytes()


def expand_quad(quad: np.ndarray, margin_x: float, margin_y: float) -> np.ndarray:
    """The quad grown along its own axes by a share of its width (left/right) and height (top/bottom)."""
    tl, tr, br, bl = order_quad(quad)
    ex = ((tr - tl) + (br - bl)) / 2
    ey = ((bl - tl) + (br - tr)) / 2
    dx, dy = margin_x * ex, margin_y * ey
    return np.array([tl - dx - dy, tr + dx - dy, br + dx + dy, bl - dx + dy], np.float32)


def _clean(read: dict | None) -> tuple[str, str] | None:
    if not read or not read.get("readable"):
        return None
    text = "".join(ch for ch in str(read.get("text", "")) if not ch.isspace() and ch not in ":.,")
    rolling = str(read.get("rolling", "")).replace(" ", "")
    if not text.isdigit() or len(rolling) != len(text) or set(rolling) - {"0", "1"}:
        return None
    return text, rolling


def agree(a: dict | None, b: dict | None, cells: int) -> tuple[str, str] | str:
    """(text, rolling) when both reads match each other and the cell count, else the reason for rejection."""
    ca, cb = _clean(a), _clean(b)
    if ca is None or cb is None:
        return "unreadable"
    if ca != cb:
        return "disagree"
    if len(ca[0]) != cells:
        return "cells"
    return ca


def label_image(image: np.ndarray, row: dict, screener: Reader, readers: tuple[Reader, Reader]) -> dict:
    """One labels.jsonl entry for a manifest row."""
    licence = row.get("license", "unknown")
    entry = {
        "id": row["id"],
        "group": row["id"],
        "source": row.get("source", ""),
        "licence": licence,
        "eval_only": licence not in TRAIN_LICENCES,
        "status": "rejected",
    }
    # Claude downscales images above about 1.15 megapixels; send it a copy that
    # fits so the box it returns is in the pixels it saw, then scale back.
    height, width = image.shape[:2]
    scale = min(1.0, (SCREEN_PIXELS / (width * height)) ** 0.5)
    sent = (
        image
        if scale == 1.0
        else cv2.resize(image, (round(width * scale), round(height * scale)), interpolation=cv2.INTER_AREA)
    )
    prompt = SCREEN_PROMPT.format(width=sent.shape[1], height=sent.shape[0])
    screen = screener.ask(encode_jpeg(sent), prompt, SCREEN_SCHEMA)
    if screen is None:
        return {**entry, "reason": "unreadable"}
    kind = screen.get("kind")
    if kind not in KINDS:
        return {**entry, "reason": "not_target"}
    polarity = polarity_of(kind, bool(screen.get("white_wheels")))
    entry.update(kind=kind, gauge_type=GAUGE_TYPE[kind], polarity=polarity, screen=screen)
    box = [v / scale for v in screen.get("box") or []]
    quad = refine_quad(image, tuple(box), polarity) if len(box) == 4 else None
    if quad is None:
        return {**entry, "reason": "no_quad"}
    band = cv2.cvtColor(rectify(image, quad, BAND_H), cv2.COLOR_BGR2GRAY)
    cells = find_cells(band, polarity)
    entry.update(quad=np.round(quad, 1).tolist(), band_h=BAND_H, cells=[list(map(int, c)) for c in cells])
    if not cells:
        return {**entry, "reason": "cells"}
    crop = encode_jpeg(rectify(image, expand_quad(quad, *READ_MARGIN), READ_H))
    answers = [r.ask(crop, READ_PROMPT, READ_SCHEMA) for r in readers]
    entry["reads"] = [{"reader": r.name, "answer": a} for r, a in zip(readers, answers, strict=True)]
    result = agree(*answers, len(cells))
    if isinstance(result, str):
        return {**entry, "reason": result}
    text, rolling = result
    return {**entry, "status": "accepted", "reason": "", "text": text, "rolling": rolling}


def read_labels(path: Path) -> list[dict]:
    if not path.exists():
        return []
    return [json.loads(line) for line in path.read_text().splitlines() if line.strip()]


def report(entries: list[dict]) -> dict:
    by = Counter((e.get("kind", "-"), e["status"], e.get("reason", "")) for e in entries)
    accepted = [e for e in entries if e["status"] == "accepted"]
    return {
        "images": len(entries),
        "accepted": len(accepted),
        "accepted_train_licence": sum(not e["eval_only"] for e in accepted),
        "digits": sum(len(e["text"]) for e in accepted),
        "by_kind_status_reason": [
            {"kind": k, "status": s, "reason": r, "count": n} for (k, s, r), n in sorted(by.items())
        ],
    }


def audit_page(root: Path, entries: list[dict], n: int, seed: int = 0) -> str:
    """A page of n random accepted labels; clicking a wrong one counts it."""
    accepted = [e for e in entries if e["status"] == "accepted"]
    sample = random.Random(seed).sample(accepted, min(n, len(accepted)))
    cards = []
    for e in sample:
        image = cv2.imread(str(root / "raw" / f"{e['id']}.jpg"))
        if image is None:
            continue
        band = rectify(image, np.array(e["quad"], np.float32), e["band_h"])
        for x0, y0, x1, y1 in e["cells"]:
            cv2.rectangle(band, (x0, y0), (x1, y1), (0, 200, 0), 1)
        crop = rectify(image, expand_quad(np.array(e["quad"], np.float32), *READ_MARGIN), 120)
        imgs = "".join(
            f'<img src="data:image/jpeg;base64,{base64.b64encode(encode_jpeg(x, 85)).decode()}">' for x in (crop, band)
        )
        rolling = "".join("↕" if r == "1" else "·" for r in e["rolling"])
        cards.append(
            f'<div class="card" onclick="this.classList.toggle(\'bad\');count()">{imgs}'
            f'<p><b>{e["text"]}</b> <span>{rolling}</span><br>{e["kind"]} · {e["id"]}</p></div>'
        )
    return f"""<!doctype html><meta charset="utf-8"><title>Time display audit</title>
<style>
body{{font:14px system-ui;margin:16px;background:#fafafa;color:#222}}
.grid{{display:flex;flex-wrap:wrap;gap:10px}}
.card{{background:#fff;border:3px solid #ddd;border-radius:6px;padding:6px;cursor:pointer;max-width:100%}}
.card img{{display:block;max-width:100%;margin-bottom:4px}}
.card.bad{{border-color:#d33;background:#fee}}
#n{{font-size:18px;font-weight:600}}
</style>
<p>Click every card whose digits are wrong. <span id="n"></span></p>
<div class="grid">{''.join(cards)}</div>
<script>
function count(){{const bad=document.querySelectorAll('.card.bad').length,all={len(cards)};
document.getElementById('n').textContent=bad+' wrong of '+all+' ('+(100*bad/Math.max(all,1)).toFixed(1)+'%)';}}
count();
</script>"""


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="autolabel", description=__doc__.split("\n\n")[0])
    parser.add_argument("--root", type=Path, required=True)
    parser.add_argument("--limit", type=int, help="label at most this many new images")
    parser.add_argument("--audit", type=int, default=0, help="write audit.html with this many accepted labels")
    parser.add_argument("--claude-model", default=DEFAULT_CLAUDE_MODEL)
    parser.add_argument("--gemini-model", default=DEFAULT_GEMINI_MODEL)
    args = parser.parse_args(argv)

    cache = args.root / "cache"
    claude = CachedReader(ClaudeReader(args.claude_model), cache)
    gemini = CachedReader(GeminiReader(args.gemini_model), cache)
    labels_path = args.root / "labels.jsonl"
    entries = read_labels(labels_path)
    done = {e["id"] for e in entries}
    with (args.root / "manifest.csv").open(newline="") as f:
        rows = [r for r in csv.DictReader(f) if r["id"] not in done]
    if args.limit is not None:
        rows = rows[: args.limit]
    with labels_path.open("a") as out:
        for i, row in enumerate(rows, 1):
            image = cv2.imread(str(args.root / "raw" / f"{row['id']}.jpg"))
            if image is None:
                continue
            try:
                entry = label_image(image, row, claude, (claude, gemini))
            except TransientError as e:
                print(f"{row['id']}: {e} (left for the next run)", file=sys.stderr)
                continue
            out.write(json.dumps(entry) + "\n")
            out.flush()
            entries.append(entry)
            print(
                f"[{i}/{len(rows)}] {row['id']} {entry['status']} {entry.get('reason') or entry.get('text')}",
                flush=True,
            )
    summary = report(entries)
    (args.root / "report.json").write_text(json.dumps(summary, indent=2) + "\n")
    print(json.dumps({k: v for k, v in summary.items() if k != "by_kind_status_reason"}))
    if args.audit:
        (args.root / "audit.html").write_text(audit_page(args.root, entries, args.audit))
    return 0


if __name__ == "__main__":
    sys.exit(main())
