"""Train/val/test split by station, so no machine appears in two splits."""

from __future__ import annotations

from pathlib import Path

SPLITS = ("train", "val", "test")


def assign_splits(stations: list[Path], val_share: float = 0.15, test_share: float = 0.15) -> dict[Path, str]:
    """Deterministic split: stations are sorted, then dealt out in a fixed pattern.

    Every split gets at least one station as soon as there are three.
    """
    ordered = sorted(stations)
    n = len(ordered)
    n_val = max(1, round(n * val_share)) if n >= 3 else 0
    n_test = max(1, round(n * test_share)) if n >= 3 else 0
    # Spread val/test stations evenly instead of taking the tail, so that
    # every noise level (one directory each) contributes to every split.
    assignment = {station: "train" for station in ordered}
    if n_test:
        for i in range(n_test):
            assignment[ordered[(i * n) // n_test]] = "test"
    if n_val:
        remaining = [s for s in ordered if assignment[s] == "train"]
        for i in range(n_val):
            assignment[remaining[(i * len(remaining)) // n_val + (len(remaining) // (2 * n_val))]] = "val"
    return assignment
