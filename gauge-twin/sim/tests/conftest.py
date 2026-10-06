"""Shared fixtures: a small rendered dataset reused by several tests."""

from pathlib import Path

import pytest
from gauge_renderer.render import RenderResult, render_station

SEED = 7
FPS = 10.0
N_FRAMES = 20
N_STATIONS = 2


@pytest.fixture(scope="session")
def rendered(tmp_path_factory: pytest.TempPathFactory) -> list[RenderResult]:
    out = tmp_path_factory.mktemp("sim")
    return [
        render_station(SEED, i, Path(out), N_FRAMES, FPS, "medium", keep_frames=3)
        for i in range(N_STATIONS)
    ]
