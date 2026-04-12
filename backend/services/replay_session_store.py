from copy import deepcopy
from datetime import datetime
from threading import Lock
from typing import Optional

_replay_session_store: dict[str, dict] = {}
_store_lock = Lock()


def upsert_replay_session(replay_session_id: str, result: dict) -> None:
    entry = deepcopy(result)
    entry["stored_at"] = datetime.utcnow().isoformat()
    with _store_lock:
        _replay_session_store[replay_session_id] = entry


def get_replay_session(replay_session_id: str) -> Optional[dict]:
    with _store_lock:
        data = _replay_session_store.get(replay_session_id)
        if data is None:
            return None
        return deepcopy(data)


def list_replay_sessions() -> list[dict]:
    with _store_lock:
        return [deepcopy(entry) for entry in _replay_session_store.values()]


def delete_replay_session(replay_session_id: str) -> bool:
    with _store_lock:
        if replay_session_id not in _replay_session_store:
            return False
        del _replay_session_store[replay_session_id]
        return True
