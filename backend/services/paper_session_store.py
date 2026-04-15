from copy import deepcopy
from datetime import datetime
from threading import Lock
from typing import Optional

_paper_session_store: dict[str, dict] = {}
_paper_session_candidate_index: dict[str, str] = {}
_paper_event_store: dict[str, list[dict]] = {}
_store_lock = Lock()


def upsert_paper_session(paper_session_id: str, session: dict) -> None:
    """Keep one deep-copied runtime snapshot per candidate paper session.

    I want Phase 3 work to stay debuggable even without a real DB, so the
    in-memory fallback mirrors the durable shape and keeps a candidate index
    too. That makes the nested candidate routes behave the same either way.
    """
    entry = deepcopy(session)
    entry["stored_at"] = datetime.utcnow().isoformat()

    with _store_lock:
        _paper_session_store[paper_session_id] = entry
        candidate_id = entry.get("candidate_id")
        if isinstance(candidate_id, str) and candidate_id:
            _paper_session_candidate_index[candidate_id] = paper_session_id


def get_paper_session(paper_session_id: str) -> Optional[dict]:
    with _store_lock:
        data = _paper_session_store.get(paper_session_id)
        if data is None:
            return None
        return deepcopy(data)


def get_paper_session_by_candidate(candidate_id: str) -> Optional[dict]:
    with _store_lock:
        paper_session_id = _paper_session_candidate_index.get(candidate_id)
        if paper_session_id is None:
            return None
        data = _paper_session_store.get(paper_session_id)
        if data is None:
            _paper_session_candidate_index.pop(candidate_id, None)
            return None
        return deepcopy(data)


def list_paper_sessions() -> list[dict]:
    with _store_lock:
        return [deepcopy(entry) for entry in _paper_session_store.values()]


def append_paper_event(paper_session_id: str, event: dict) -> None:
    entry = deepcopy(event)
    with _store_lock:
        _paper_event_store.setdefault(paper_session_id, []).append(entry)


def list_paper_events(paper_session_id: str) -> list[dict]:
    with _store_lock:
        return [deepcopy(entry) for entry in _paper_event_store.get(paper_session_id, [])]
