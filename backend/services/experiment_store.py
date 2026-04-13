from copy import deepcopy
from datetime import datetime
from threading import Lock
from typing import Optional

_experiment_store: dict[str, dict] = {}
_experiment_runs_store: dict[str, list[dict]] = {}
_store_lock = Lock()


def add_experiment(experiment_id: str, experiment: dict) -> None:
    entry = deepcopy(experiment)
    entry["stored_at"] = datetime.utcnow().isoformat()
    with _store_lock:
        _experiment_store[experiment_id] = entry


def get_experiment(experiment_id: str) -> Optional[dict]:
    with _store_lock:
        data = _experiment_store.get(experiment_id)
        if data is None:
            return None
        return deepcopy(data)


def list_experiments() -> list[dict]:
    with _store_lock:
        return [deepcopy(entry) for entry in _experiment_store.values()]


def replace_experiment_runs(experiment_id: str, runs: list[dict]) -> None:
    payload = [deepcopy(run) for run in runs]
    with _store_lock:
        _experiment_runs_store[experiment_id] = payload


def list_experiment_runs(experiment_id: str) -> list[dict]:
    with _store_lock:
        runs = _experiment_runs_store.get(experiment_id, [])
        return [deepcopy(run) for run in runs]


def delete_experiment_runs(experiment_id: str) -> None:
    with _store_lock:
        _experiment_runs_store.pop(experiment_id, None)
