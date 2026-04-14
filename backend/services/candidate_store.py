from copy import deepcopy
from datetime import datetime
from threading import Lock
from typing import Optional

_candidate_store: dict[str, dict] = {}
_candidate_run_index: dict[str, str] = {}
_store_lock = Lock()


def upsert_candidate(candidate_id: str, candidate: dict) -> None:
    """Keep a safe in-memory snapshot of one promoted candidate.

    Candidates are the handoff seam between research and whatever comes next,
    so I store them as deep copies and index them by run id too. That keeps the
    detail view snappy without letting accidental mutation leak across requests.
    """
    entry = deepcopy(candidate)
    entry["stored_at"] = datetime.utcnow().isoformat()

    with _store_lock:
        _candidate_store[candidate_id] = entry
        experiment_run_id = entry.get("experiment_run_id")
        if isinstance(experiment_run_id, str) and experiment_run_id:
            _candidate_run_index[experiment_run_id] = candidate_id


def get_candidate(candidate_id: str) -> Optional[dict]:
    with _store_lock:
        data = _candidate_store.get(candidate_id)
        if data is None:
            return None
        return deepcopy(data)


def get_candidate_by_run(experiment_run_id: str) -> Optional[dict]:
    with _store_lock:
        candidate_id = _candidate_run_index.get(experiment_run_id)
        if candidate_id is None:
            return None
        data = _candidate_store.get(candidate_id)
        if data is None:
            _candidate_run_index.pop(experiment_run_id, None)
            return None
        return deepcopy(data)


def list_candidates() -> list[dict]:
    with _store_lock:
        return [deepcopy(entry) for entry in _candidate_store.values()]


def delete_candidate(candidate_id: str) -> bool:
    with _store_lock:
        data = _candidate_store.pop(candidate_id, None)
        if data is None:
            return False
        experiment_run_id = data.get("experiment_run_id")
        if isinstance(experiment_run_id, str) and experiment_run_id:
            _candidate_run_index.pop(experiment_run_id, None)
        return True
