"""Leave-one-source-out digit datasets: how well does the classifier read a
kind of display it has never seen?

    python -m gauge_ml.dataset.holdout --data data/ml-real --out data/loso/trodo --hold trodo

The digit archives of build_real carry the dataset name of every slot in
"color". The held-out datasets are removed from train and val; test becomes
every slot of the held-out datasets (their train, val and test parts), so the
test accuracy is that of unseen devices.
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

import numpy as np

SPLITS = ("train", "val", "test")


def load(data: Path, split: str) -> dict[str, np.ndarray]:
    with np.load(data / "digits" / f"{split}.npz") as archive:
        return {key: archive[key] for key in archive.files}


def select(split: dict[str, np.ndarray], mask: np.ndarray) -> dict[str, np.ndarray]:
    return {key: value[mask] for key, value in split.items()}


def concat(parts: list[dict[str, np.ndarray]]) -> dict[str, np.ndarray]:
    return {key: np.concatenate([p[key] for p in parts]) for key in parts[0]}


def hold_out(data: Path, out: Path, held: list[str]) -> dict:
    splits = {s: load(data, s) for s in SPLITS}
    known = set(np.unique(np.concatenate([splits[s]["color"] for s in SPLITS])))
    missing = [h for h in held if h not in known]
    if missing:
        raise SystemExit(f"not in {data}: {missing}; datasets are {sorted(known)}")
    is_held = {s: np.isin(splits[s]["color"], held) for s in SPLITS}
    result = {
        "train": select(splits["train"], ~is_held["train"]),
        "val": select(splits["val"], ~is_held["val"]),
        "test": concat([select(splits[s], is_held[s]) for s in SPLITS]),
    }
    (out / "digits").mkdir(parents=True, exist_ok=True)
    for split, arrays in result.items():
        np.savez_compressed(out / "digits" / f"{split}.npz", **arrays)
    summary = {"held_out": held, **{s: int(len(result[s]["labels"])) for s in SPLITS}}
    (out / "summary.json").write_text(json.dumps(summary, indent=2) + "\n")
    return summary


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="holdout", description=__doc__.split("\n\n")[0])
    parser.add_argument("--data", type=Path, required=True, help="dataset written by build_real")
    parser.add_argument("--out", type=Path, required=True)
    parser.add_argument("--hold", nargs="+", required=True, help="dataset names to hold out")
    args = parser.parse_args(argv)
    print(json.dumps(hold_out(args.data, args.out, args.hold), indent=2))
    return 0


if __name__ == "__main__":
    sys.exit(main())
