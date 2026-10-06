"""Shared fixtures: a small rendered dataset built once per test session.

These tests need the ml image (torch); in the tools image they are skipped.
"""

from pathlib import Path

import pytest

try:
    import torch  # noqa: F401
except ImportError:
    # The tools image has no torch: only the schema test runs there.
    collect_ignore = [
        "test_dataset.py",
        "test_models.py",
        "test_eval.py",
        "test_pipeline.py",
        "test_ds_sim_parity.py",
        "test_public.py",
    ]

SEED = 11
FPS = 10.0
N_FRAMES = 30
# Station indices chosen so that dials and every digit display type appear.
STATIONS = range(6)


@pytest.fixture(scope="session")
def sim_dir(tmp_path_factory: pytest.TempPathFactory) -> Path:
    from gauge_renderer.render import render_station

    root = tmp_path_factory.mktemp("sim")
    for index in STATIONS:
        level = ("medium", "high", "low")[index % 3]
        render_station(SEED, index, root / level, N_FRAMES, FPS, level, keep_frames=0)
    return root


@pytest.fixture(scope="session")
def dataset_dir(sim_dir: Path, tmp_path_factory: pytest.TempPathFactory) -> Path:
    from gauge_ml.dataset.builder import build

    out = tmp_path_factory.mktemp("ml")
    build([sim_dir], out, sample_fps=5.0, seed=0)
    return out


@pytest.fixture()
def mlflow_dir(tmp_path, monkeypatch):
    """Keeps MLflow runs of a test inside its temporary directory."""
    monkeypatch.setenv("MLFLOW_TRACKING_URI", f"sqlite:///{tmp_path / 'mlflow.db'}")
    monkeypatch.setenv("MLFLOW_ARTIFACT_ROOT", (tmp_path / "artifacts").as_uri())
    return tmp_path
