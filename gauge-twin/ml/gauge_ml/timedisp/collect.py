"""Downloads openly licensed photos of time displays into <root>/raw and <root>/manifest.csv.

    python -m gauge_ml.timedisp.collect --root data/public/time-displays [--max-images 1500]

Sources: Openverse (CC images from Flickr, Wikimedia and others) and Wikimedia
Commons; both need no key and give the licence of every image. Images are
scaled so the long side is at most 1568 px (what Claude takes without
downscaling, so the boxes it returns are in image pixels). Near duplicates
(dHash within 6 bits of a kept image) are skipped. The run can be stopped
and restarted: URLs already in the manifest are not fetched again.
"""

from __future__ import annotations

import argparse
import csv
import hashlib
import json
import re
import sys
import urllib.parse
import urllib.request
from collections.abc import Iterator
from pathlib import Path

import cv2
import numpy as np

LONG_SIDE = 1568
MIN_SIDE = 240
DUPLICATE_BITS = 6
MAX_BYTES = 20 * 1024 * 1024
USER_AGENT = "gauge-twin-dataset/0.1 (research dataset builder; contact: repository owner)"
FIELDS = ("id", "source", "url", "landing", "license", "author", "query", "dhash")

QUERIES = (
    "hour meter",
    "hourmeter",
    "hobbs meter",
    "engine hour meter",
    "tractor hour meter",
    "generator hour meter",
    "machine hours counter",
    "digital timer relay",
    "panel timer display",
    "industrial timer display",
    "omron timer",
    "countdown timer led display",
    "digital clock led display",
    "led wall clock",
    "lcd digital clock",
)


def normalize_licence(raw: str) -> str:
    """'by-sa', 'CC BY-SA 4.0', 'cc0', 'Public domain' -> 'CC-BY-SA', 'CC0', 'PDM'."""
    s = raw.strip().lower().replace("_", "-")
    if not s:
        return "unknown"
    if "public domain" in s or s in ("pdm", "pd"):
        return "PDM"
    if "cc0" in s or "cc-zero" in s:
        return "CC0"
    s = re.sub(r"\s+\d+(\.\d+)?$", "", s)  # version
    s = s.removeprefix("cc").strip(" -")
    parts = [p for p in re.split(r"[\s-]+", s) if p]
    if not parts or parts[0] != "by":
        return raw.strip() or "unknown"
    return "CC-" + "-".join(p.upper() for p in parts)


def resize_long_side(image: np.ndarray, side: int = LONG_SIDE) -> np.ndarray:
    h, w = image.shape[:2]
    scale = side / max(h, w)
    if scale >= 1:
        return image
    return cv2.resize(image, (round(w * scale), round(h * scale)), interpolation=cv2.INTER_AREA)


def dhash(image: np.ndarray) -> int:
    """64-bit difference hash."""
    gray = image if image.ndim == 2 else cv2.cvtColor(image, cv2.COLOR_BGR2GRAY)
    small = cv2.resize(gray, (9, 8), interpolation=cv2.INTER_AREA)
    bits = (small[:, 1:] > small[:, :-1]).flatten()
    return int("".join("1" if b else "0" for b in bits), 2)


def hamming(a: int, b: int) -> int:
    return (a ^ b).bit_count()


def _get_json(url: str) -> dict:
    request = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
    with urllib.request.urlopen(request, timeout=30) as response:
        return json.load(response)


def search_openverse(query: str, pages: int = 10) -> Iterator[dict]:
    for page in range(1, pages + 1):
        params = urllib.parse.urlencode({"q": query, "page_size": 20, "page": page, "mature": "false"})
        try:
            reply = _get_json(f"https://api.openverse.org/v1/images/?{params}")
        except Exception as e:
            print(f"openverse {query!r} page {page}: {e}", file=sys.stderr)
            return
        for item in reply.get("results", []):
            yield {
                "source": "openverse",
                "url": item.get("url", ""),
                "landing": item.get("foreign_landing_url", ""),
                "license": normalize_licence(item.get("license", "")),
                "author": item.get("creator") or "",
            }
        if page >= reply.get("page_count", 0):
            return


def search_wikimedia(query: str, limit: int = 100) -> Iterator[dict]:
    params = urllib.parse.urlencode(
        {
            "action": "query",
            "format": "json",
            "generator": "search",
            "gsrsearch": query,
            "gsrnamespace": 6,
            "gsrlimit": min(limit, 50),
            "prop": "imageinfo",
            "iiprop": "url|extmetadata",
            "iiurlwidth": LONG_SIDE,
        }
    )
    try:
        reply = _get_json(f"https://commons.wikimedia.org/w/api.php?{params}")
    except Exception as e:
        print(f"wikimedia {query!r}: {e}", file=sys.stderr)
        return
    for page in reply.get("query", {}).get("pages", {}).values():
        info = (page.get("imageinfo") or [{}])[0]
        meta = info.get("extmetadata", {})
        author = re.sub(r"<[^>]+>", "", meta.get("Artist", {}).get("value", "")).strip()
        yield {
            "source": "wikimedia",
            "url": info.get("thumburl") or info.get("url", ""),
            "landing": info.get("descriptionurl", ""),
            "license": normalize_licence(meta.get("LicenseShortName", {}).get("value", "")),
            "author": author,
        }


def download(url: str) -> np.ndarray | None:
    request = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
    try:
        with urllib.request.urlopen(request, timeout=30) as response:
            data = response.read(MAX_BYTES + 1)
    except Exception:
        return None
    if len(data) > MAX_BYTES:
        return None
    return cv2.imdecode(np.frombuffer(data, np.uint8), cv2.IMREAD_COLOR)


def read_manifest(path: Path) -> list[dict]:
    if not path.exists():
        return []
    with path.open(newline="") as f:
        return list(csv.DictReader(f))


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="collect", description=__doc__.split("\n\n")[0])
    parser.add_argument("--root", type=Path, required=True)
    parser.add_argument("--max-images", type=int, default=1500)
    parser.add_argument("--sources", nargs="*", default=["openverse", "wikimedia"])
    args = parser.parse_args(argv)

    raw = args.root / "raw"
    raw.mkdir(parents=True, exist_ok=True)
    manifest = args.root / "manifest.csv"
    rows = read_manifest(manifest)
    seen = {r["url"] for r in rows}
    hashes = [int(r["dhash"]) for r in rows]
    searches = {"openverse": search_openverse, "wikimedia": search_wikimedia}
    new_file = not manifest.exists()
    with manifest.open("a", newline="") as f:
        writer = csv.DictWriter(f, fieldnames=FIELDS)
        if new_file:
            writer.writeheader()
        for query in QUERIES:
            for name in args.sources:
                for item in searches[name](query):
                    if len(rows) >= args.max_images:
                        print(f"{len(rows)} images", flush=True)
                        return 0
                    if not item["url"] or item["url"] in seen:
                        continue
                    seen.add(item["url"])
                    image = download(item["url"])
                    if image is None or min(image.shape[:2]) < MIN_SIDE:
                        continue
                    image = resize_long_side(image)
                    h = dhash(image)
                    if any(hamming(h, other) <= DUPLICATE_BITS for other in hashes):
                        continue
                    image_id = f"{name[:2]}-{hashlib.sha1(item['url'].encode()).hexdigest()[:12]}"
                    cv2.imwrite(str(raw / f"{image_id}.jpg"), image, [cv2.IMWRITE_JPEG_QUALITY, 92])
                    row = {"id": image_id, "query": query, "dhash": str(h), **item}
                    writer.writerow(row)
                    f.flush()
                    rows.append(row)
                    hashes.append(h)
            print(f"{query!r}: {len(rows)} images", flush=True)
    return 0


if __name__ == "__main__":
    sys.exit(main())
