import uuid

from schemas import PaperSessionStatus
from services.candidate_service import (
    _append_audit,
    _db_required,
    _make_event as make_candidate_audit_event,
    _now,
    _require_candidate,
    _save_candidate_any,
)
from services.paper_session_repo import (
    append_paper_event as append_paper_event_db,
    get_paper_session as get_paper_session_db,
    get_paper_session_by_candidate as get_paper_session_by_candidate_db,
    list_paper_events as list_paper_events_db,
    list_paper_sessions as list_paper_sessions_db,
    save_paper_session as save_paper_session_db,
)
from services.paper_session_store import (
    append_paper_event as append_paper_event_mem,
    get_paper_session as get_paper_session_mem,
    get_paper_session_by_candidate as get_paper_session_by_candidate_mem,
    list_paper_events as list_paper_events_mem,
    list_paper_sessions as list_paper_sessions_mem,
    upsert_paper_session as upsert_paper_session_mem,
)

PAPER_SESSION_TRANSITIONS = {
    PaperSessionStatus.DRAFT.value: {
        PaperSessionStatus.READY.value,
        PaperSessionStatus.STOPPED.value,
        PaperSessionStatus.FAILED.value,
    },
    PaperSessionStatus.READY.value: {
        PaperSessionStatus.RUNNING.value,
        PaperSessionStatus.PAUSED.value,
        PaperSessionStatus.STOPPED.value,
        PaperSessionStatus.FAILED.value,
    },
    PaperSessionStatus.RUNNING.value: {
        PaperSessionStatus.PAUSED.value,
        PaperSessionStatus.STOPPED.value,
        PaperSessionStatus.FAILED.value,
    },
    PaperSessionStatus.PAUSED.value: {
        PaperSessionStatus.READY.value,
        PaperSessionStatus.RUNNING.value,
        PaperSessionStatus.STOPPED.value,
        PaperSessionStatus.FAILED.value,
    },
    PaperSessionStatus.STOPPED.value: {
        PaperSessionStatus.READY.value,
        PaperSessionStatus.RUNNING.value,
    },
    PaperSessionStatus.FAILED.value: {
        PaperSessionStatus.READY.value,
        PaperSessionStatus.STOPPED.value,
    },
}


def list_paper_sessions_any() -> list[dict]:
    source = list_paper_sessions_db() if _db_required() else list_paper_sessions_mem()
    return sorted(source, key=lambda session: session.get("updated_at", ""), reverse=True)


def get_paper_session_any(paper_session_id: str) -> dict | None:
    if _db_required():
        return get_paper_session_db(paper_session_id)
    return get_paper_session_mem(paper_session_id)


def get_paper_session_by_candidate_any(candidate_id: str) -> dict | None:
    if _db_required():
        return get_paper_session_by_candidate_db(candidate_id)
    return get_paper_session_by_candidate_mem(candidate_id)


def list_paper_events_any(paper_session_id: str) -> list[dict]:
    if _db_required():
        return list_paper_events_db(paper_session_id)
    return list_paper_events_mem(paper_session_id)


def create_paper_session_for_candidate(
    candidate_id: str,
    *,
    actor: str = "local-user",
    name: str | None = None,
) -> dict:
    """Create the durable paper runtime shell for one reviewed candidate.

    The paper bot config is still the handoff stub, but this session is where
    the real runtime state and append-only execution log will live next. I keep
    it one-per-candidate for now so the first Phase 3 loop stays simple.
    """
    candidate = _require_candidate(candidate_id)
    if candidate["lifecycle_status"] == "rejected":
        raise ValueError("Rejected candidates can't create paper sessions.")

    paper_bot = candidate.get("paper_bot")
    if paper_bot is None:
        raise ValueError("Create the paper bot draft first so the session has a runtime config.")

    existing = get_paper_session_by_candidate_any(candidate_id)
    if existing is not None:
        _sync_candidate_paper_session(candidate, existing["paper_session_id"], existing.get("last_event_at"))
        return existing

    now = _now()
    session = {
        "paper_session_id": str(uuid.uuid4()),
        "candidate_id": candidate["candidate_id"],
        "paper_bot_id": paper_bot.get("paper_bot_id"),
        "name": name.strip() if isinstance(name, str) and name.strip() else _default_session_name(candidate),
        "symbol": candidate["symbol"],
        "interval": candidate["interval"],
        "strategy_type": candidate["strategy_type"],
        "strategy_params": candidate.get("strategy_params") or {},
        "prop_firm_rules": candidate.get("prop_firm_rules") or {},
        "guardrails": paper_bot.get("guardrails") or {},
        "status": _paper_bot_to_session_status(paper_bot.get("status")),
        "current_position": {},
        "metrics_snapshot": {},
        "guardrail_state": {
            "prop_firm_rules": candidate.get("prop_firm_rules") or {},
            "required_prop_pass": bool((paper_bot.get("guardrails") or {}).get("required_prop_pass")),
        },
        "last_bar_time": None,
        "last_event_at": now,
        "created_by": actor,
        "created_at": now,
        "updated_at": now,
    }
    event = _make_paper_event(
        paper_session_id=session["paper_session_id"],
        candidate_id=candidate["candidate_id"],
        event_type="session_created",
        actor=actor,
        summary="Created the durable paper session shell from the candidate handoff.",
        created_at=now,
        payload={
            "paper_bot_id": paper_bot.get("paper_bot_id"),
            "status": session["status"],
        },
    )

    _save_paper_session_any(session)
    _append_paper_event_any(event)
    _sync_candidate_paper_session(candidate, session["paper_session_id"], now)
    _append_candidate_session_audit(candidate, actor=actor, summary="Created a durable paper session for this candidate.", created_at=now)
    return session


def update_paper_session_status(
    paper_session_id: str,
    status: str,
    *,
    actor: str = "local-user",
    summary: str | None = None,
) -> dict:
    session = _require_paper_session(paper_session_id)
    next_status = status.strip()
    previous_status = session["status"]

    if next_status == previous_status:
        return session

    allowed = PAPER_SESSION_TRANSITIONS.get(previous_status, set())
    if next_status not in allowed:
        raise ValueError(f"Can't move paper session from '{previous_status}' to '{next_status}'.")

    now = _now()
    session["status"] = next_status
    session["last_event_at"] = now
    session["updated_at"] = now
    _save_paper_session_any(session)
    _append_paper_event_any(
        _make_paper_event(
            paper_session_id=session["paper_session_id"],
            candidate_id=session["candidate_id"],
            event_type="status_changed",
            actor=actor,
            summary=summary or f"Moved paper session from `{previous_status}` to `{next_status}`.",
            created_at=now,
            payload={"from": previous_status, "to": next_status},
        )
    )

    candidate = _require_candidate(session["candidate_id"])
    _sync_candidate_paper_session(candidate, session["paper_session_id"], now)
    _append_candidate_session_audit(
        candidate,
        actor=actor,
        summary=summary or f"Moved paper session from `{previous_status}` to `{next_status}`.",
        created_at=now,
    )
    return session


def add_paper_session_event(
    paper_session_id: str,
    *,
    event_type: str,
    summary: str,
    actor: str = "local-user",
    payload: dict | None = None,
) -> dict:
    session = _require_paper_session(paper_session_id)
    event_kind = event_type.strip()
    note = summary.strip()
    if not event_kind:
        raise ValueError("Paper event type can't be empty.")
    if not note:
        raise ValueError("Paper event summary can't be empty.")

    now = _now()
    event = _make_paper_event(
        paper_session_id=paper_session_id,
        candidate_id=session["candidate_id"],
        event_type=event_kind,
        actor=actor,
        summary=note,
        created_at=now,
        payload=payload or {},
    )
    session["last_event_at"] = now
    session["updated_at"] = now
    _save_paper_session_any(session)
    _append_paper_event_any(event)

    candidate = _require_candidate(session["candidate_id"])
    _sync_candidate_paper_session(candidate, paper_session_id, now)
    return event


def _require_paper_session(paper_session_id: str) -> dict:
    session = get_paper_session_any(paper_session_id)
    if session is None:
        raise LookupError(f"Paper session '{paper_session_id}' not found.")
    return session


def _save_paper_session_any(session: dict) -> dict:
    if _db_required():
        save_paper_session_db(session)
    upsert_paper_session_mem(session["paper_session_id"], session)
    return session


def _append_paper_event_any(event: dict) -> dict:
    if _db_required():
        append_paper_event_db(event)
    append_paper_event_mem(event["paper_session_id"], event)
    return event


def _default_session_name(candidate: dict) -> str:
    return f"{candidate['symbol']} {candidate['interval']} paper session"


def _paper_bot_to_session_status(paper_bot_status: str | None) -> str:
    if paper_bot_status == "ready":
        return PaperSessionStatus.READY.value
    if paper_bot_status == "paper_running":
        return PaperSessionStatus.RUNNING.value
    if paper_bot_status == "stopped":
        return PaperSessionStatus.PAUSED.value
    return PaperSessionStatus.DRAFT.value


def _sync_candidate_paper_session(candidate: dict, paper_session_id: str, last_event_at: str | None) -> None:
    paper_bot = candidate.get("paper_bot")
    if paper_bot is None:
        return

    paper_bot["paper_session_id"] = paper_session_id
    paper_bot["last_event_at"] = last_event_at
    paper_bot["updated_at"] = _now()
    candidate["paper_bot"] = paper_bot
    candidate["updated_at"] = paper_bot["updated_at"]
    _save_candidate_any(candidate)


def _append_candidate_session_audit(candidate: dict, *, actor: str, summary: str, created_at: str) -> None:
    candidate["audit_log"] = _append_audit(
        candidate,
        make_candidate_audit_event(
            event_type="paper_session_updated",
            actor=actor,
            summary=summary,
            created_at=created_at,
            changes={"paper_session_id": candidate.get("paper_bot", {}).get("paper_session_id")},
        ),
    )
    candidate["updated_at"] = created_at
    _save_candidate_any(candidate)


def _make_paper_event(
    *,
    paper_session_id: str,
    candidate_id: str,
    event_type: str,
    actor: str,
    summary: str,
    created_at: str,
    payload: dict,
) -> dict:
    return {
        "paper_event_id": str(uuid.uuid4()),
        "paper_session_id": paper_session_id,
        "candidate_id": candidate_id,
        "event_type": event_type,
        "actor": actor,
        "summary": summary,
        "payload": payload,
        "created_at": created_at,
    }
