"""MLflow setup: a local SQLite tracking store and registry by default."""

from __future__ import annotations

import os
from pathlib import Path

import mlflow
from mlflow.tracking import MlflowClient

DEFAULT_DIR = Path("data/mlflow")


def setup(experiment: str) -> None:
    """Points MLflow at MLFLOW_TRACKING_URI, or at data/mlflow/mlflow.db with
    artifacts in data/mlflow/artifacts, and selects the experiment."""
    uri = os.environ.get("MLFLOW_TRACKING_URI")
    if not uri:
        DEFAULT_DIR.mkdir(parents=True, exist_ok=True)
        uri = f"sqlite:///{(DEFAULT_DIR / 'mlflow.db').resolve()}"
    mlflow.set_tracking_uri(uri)
    if mlflow.get_experiment_by_name(experiment) is None:
        location = os.environ.get("MLFLOW_ARTIFACT_ROOT")
        if not location:
            artifacts = (DEFAULT_DIR / "artifacts").resolve()
            artifacts.mkdir(parents=True, exist_ok=True)
            location = artifacts.as_uri()
        mlflow.create_experiment(experiment, artifact_location=location)
    mlflow.set_experiment(experiment)


def register(name: str, artifact_path: str, tags: dict[str, str]) -> str:
    """Registers an artifact of the active run as a new version of a model."""
    run = mlflow.active_run()
    if run is None:
        raise RuntimeError("register() needs an active MLflow run")
    client = MlflowClient()
    try:
        client.create_registered_model(name)
    except mlflow.exceptions.MlflowException:
        pass  # already registered
    source = f"{run.info.artifact_uri}/{artifact_path}"
    version = client.create_model_version(name, source=source, run_id=run.info.run_id, tags=tags)
    return str(version.version)
