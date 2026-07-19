"""Narrow, audited MCP controls over the paper-session boundary."""

import uuid
from typing import Any

from services.candidate_service import _db_required, _now
from services.paper_session_repo import (
    append_paper_event as append_paper_event_db,
    get_paper_event as get_paper_event_db,
)
from services.paper_session_service import get_paper_session_any
from services.paper_session_store import (
    append_paper_event as append_paper_event_mem,
    get_paper_event as get_paper_event_mem,
)

MCP_AUDIT_ACTOR = "mcp-operator"
OPERATOR_NOTE_EVENT_TYPE = "operator_note_added"
_OPERATOR_NOTE_NAMESPACE = uuid.UUID("d87c720e-9e73-4b12-8aec-0df2e3f1128d")


def add_operator_note(
    paper_session_id: str,
    *,
    note: str,
    idempotency_key: str,
) -> dict[str, Any]:
    """Append one paper-only operator note, or return its exact prior result."""
    session_id = paper_session_id.strip()
    note_text = note.strip()
    key = idempotency_key.strip()
    if not session_id:
        raise ValueError("Paper session id can't be empty.")
    if not note_text:
        raise ValueError("Operator note can't be empty.")
    if len(note_text) > 1000:
        raise ValueError("Operator note can't exceed 1000 characters.")
    if not key:
        raise ValueError("Idempotency key can't be empty.")
    if len(key) > 200:
        raise ValueError("Idempotency key can't exceed 200 characters.")

    event_id = str(uuid.uuid5(_OPERATOR_NOTE_NAMESPACE, key))
    existing = _get_paper_event_any(event_id)
    if existing is not None:
        _validate_idempotent_retry(existing, session_id=session_id, note=note_text, key=key)
        return existing

    session = get_paper_session_any(session_id)
    if session is None:
        raise LookupError(f"Paper session '{session_id}' not found.")

    event = {
        "paper_event_id": event_id,
        "paper_session_id": session_id,
        "candidate_id": session["candidate_id"],
        "event_type": OPERATOR_NOTE_EVENT_TYPE,
        "actor": MCP_AUDIT_ACTOR,
        "summary": note_text,
        "payload": {
            "control_tool": "add_operator_note",
            "scope": "paper",
            "note": note_text,
            "idempotency_key": key,
        },
        "created_at": _now(),
    }
    _append_paper_event_any(event)

    persisted = _get_paper_event_any(event_id)
    if persisted is None:
        raise RuntimeError("Operator note was not persisted.")
    _validate_idempotent_retry(persisted, session_id=session_id, note=note_text, key=key)
    return persisted


def _get_paper_event_any(paper_event_id: str) -> dict | None:
    if _db_required():
        return get_paper_event_db(paper_event_id)
    return get_paper_event_mem(paper_event_id)


def _append_paper_event_any(event: dict) -> None:
    if _db_required():
        append_paper_event_db(event)
    append_paper_event_mem(event["paper_session_id"], event)


def _validate_idempotent_retry(
    event: dict,
    *,
    session_id: str,
    note: str,
    key: str,
) -> None:
    payload = event.get("payload") or {}
    matches = (
        event.get("paper_session_id") == session_id
        and event.get("event_type") == OPERATOR_NOTE_EVENT_TYPE
        and event.get("actor") == MCP_AUDIT_ACTOR
        and event.get("summary") == note
        and payload.get("control_tool") == "add_operator_note"
        and payload.get("scope") == "paper"
        and payload.get("note") == note
        and payload.get("idempotency_key") == key
    )
    if not matches:
        raise ValueError("Idempotency key was already used for a different operator note request.")
