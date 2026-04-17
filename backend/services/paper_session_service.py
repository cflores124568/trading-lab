import uuid
from datetime import datetime

from schemas import PaperSessionStatus
from services.candidate_service import (
    _append_audit,
    _db_required,
    _make_event as make_candidate_audit_event,
    _now,
    _require_candidate,
    _save_candidate_any,
)
from services.metrics import calculate_metrics
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
from services.prop_firm_eval import evaluate_prop_firm

DEFAULT_TICK_VALUES = {
    "NQ": 20.0,
    "MNQ": 2.0,
    "ES": 50.0,
    "MES": 5.0,
    "GC": 10.0,
    "MGC": 1.0,
}
OPEN_ACTION_STATUSES = {
    PaperSessionStatus.READY.value,
    PaperSessionStatus.RUNNING.value,
}
POSITION_ACTION_STATUSES = {
    PaperSessionStatus.READY.value,
    PaperSessionStatus.RUNNING.value,
    PaperSessionStatus.PAUSED.value,
}

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
    return sorted(
        [_ensure_session_defaults(dict(session)) for session in source],
        key=lambda session: session.get("updated_at", ""),
        reverse=True,
    )


def get_paper_session_any(paper_session_id: str) -> dict | None:
    if _db_required():
        source = get_paper_session_db(paper_session_id)
    else:
        source = get_paper_session_mem(paper_session_id)
    if source is None:
        return None
    return _ensure_session_defaults(dict(source))


def get_paper_session_by_candidate_any(candidate_id: str) -> dict | None:
    if _db_required():
        source = get_paper_session_by_candidate_db(candidate_id)
    else:
        source = get_paper_session_by_candidate_mem(candidate_id)
    if source is None:
        return None
    return _ensure_session_defaults(dict(source))


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
        "commission": 5.0,
        "tick_value": _resolve_tick_value(candidate["symbol"]),
        "current_position": {},
        "trade_log": [],
        "equity_curve": [float((candidate.get("prop_firm_rules") or {}).get("account_size") or 100_000)],
        "metrics_snapshot": {},
        "guardrail_state": {},
        "last_bar_time": None,
        "last_event_at": now,
        "created_by": actor,
        "created_at": now,
        "updated_at": now,
    }
    session = _ensure_session_defaults(session)
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
    session = _ensure_session_defaults(session)
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
    _sync_candidate_paper_session(
        candidate,
        session["paper_session_id"],
        now,
        session_status=next_status,
    )
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


def execute_paper_session_action(
    paper_session_id: str,
    *,
    action: str,
    price: float,
    filled_at: str,
    actor: str = "local-user",
    note: str | None = None,
) -> dict:
    session = _ensure_session_defaults(_require_paper_session(paper_session_id))
    action_key = action.strip().lower()
    timestamp = _normalize_timestamp(filled_at)
    execution_price = round(float(price), 4)
    if execution_price <= 0:
        raise ValueError("Execution price must be greater than zero.")

    if action_key in {"buy", "sell"}:
        if session["status"] not in OPEN_ACTION_STATUSES:
            raise ValueError("Paper session must be ready or running before you can open a position.")
        if _has_open_position(session):
            raise ValueError("Close or mark the current position before opening a new one.")

        previous_status = session["status"]
        session["current_position"] = _open_position(action_key, execution_price, timestamp)
        if previous_status == PaperSessionStatus.READY.value:
            session["status"] = PaperSessionStatus.RUNNING.value

        summary = note or f"Opened a {action_key} paper position at {execution_price:.2f}."
        payload = {
            "action": action_key,
            "entry_price": execution_price,
            "entry_time": timestamp,
            "status_auto_started": previous_status != session["status"],
        }
        audit_summary = summary
        event_type = "position_opened"
    elif action_key == "mark":
        if session["status"] not in POSITION_ACTION_STATUSES:
            raise ValueError("Paper session must be ready, running, or paused before you can mark a position.")
        position = _require_open_position(session)
        _mark_position(position, execution_price, timestamp, session["tick_value"])
        session["current_position"] = position
        session["equity_curve"] = [*session.get("equity_curve", []), _marked_equity(session)]
        summary = note or f"Marked the open {position['side']} position at {execution_price:.2f}."
        payload = {
            "action": action_key,
            "mark_price": execution_price,
            "marked_equity": _marked_equity(session),
            "unrealized_pnl": position["unrealized_pnl"],
        }
        audit_summary = summary
        event_type = "position_marked"
    elif action_key == "exit":
        if session["status"] not in POSITION_ACTION_STATUSES:
            raise ValueError("Paper session must be ready, running, or paused before you can flatten a position.")
        position = _require_open_position(session)
        trade = _close_position(session, position, execution_price, timestamp)
        session["trade_log"] = [*(session.get("trade_log") or []), trade]
        session["current_position"] = {}
        session["equity_curve"] = [*session.get("equity_curve", []), _realized_equity(session)]
        summary = note or f"Closed the {trade['side']} paper trade at {execution_price:.2f} for {trade['pnl']:+.2f}."
        payload = {
            "action": action_key,
            "trade_id": trade["trade_id"],
            "exit_price": execution_price,
            "pnl": trade["pnl"],
            "realized_equity": _realized_equity(session),
        }
        audit_summary = summary
        event_type = "position_closed"
    else:
        raise ValueError(f"Unsupported paper session action '{action}'.")

    now = _now()
    session["last_bar_time"] = timestamp
    session["last_event_at"] = now
    session["updated_at"] = now
    session = _ensure_session_defaults(session)
    _save_paper_session_any(session)
    _append_paper_event_any(
        _make_paper_event(
            paper_session_id=session["paper_session_id"],
            candidate_id=session["candidate_id"],
            event_type=event_type,
            actor=actor,
            summary=summary,
            created_at=now,
            payload=payload,
        )
    )

    candidate = _require_candidate(session["candidate_id"])
    _sync_candidate_paper_session(
        candidate,
        session["paper_session_id"],
        now,
        session_status=session["status"],
    )
    _append_candidate_session_audit(
        candidate,
        actor=actor,
        summary=audit_summary,
        created_at=now,
    )
    return session


def _require_paper_session(paper_session_id: str) -> dict:
    session = get_paper_session_any(paper_session_id)
    if session is None:
        raise LookupError(f"Paper session '{paper_session_id}' not found.")
    return session


def _save_paper_session_any(session: dict) -> dict:
    session = _ensure_session_defaults(session)
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


def _sync_candidate_paper_session(
    candidate: dict,
    paper_session_id: str,
    last_event_at: str | None,
    *,
    session_status: str | None = None,
) -> None:
    paper_bot = candidate.get("paper_bot")
    if paper_bot is None:
        return

    updated_at = _now()
    paper_bot["paper_session_id"] = paper_session_id
    paper_bot["last_event_at"] = last_event_at
    paper_bot["updated_at"] = updated_at
    if session_status is not None:
        candidate["lifecycle_status"] = _session_status_to_candidate_status(
            session_status,
            candidate.get("lifecycle_status"),
        )
        paper_bot["status"] = _session_status_to_paper_bot_status(session_status, paper_bot.get("status"))
    candidate["paper_bot"] = paper_bot
    candidate["updated_at"] = updated_at
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


def _ensure_session_defaults(session: dict) -> dict:
    account_size = _account_size(session)
    session["commission"] = float(session.get("commission") or 5.0)
    session["tick_value"] = float(session.get("tick_value") or _resolve_tick_value(session.get("symbol")))
    session["current_position"] = dict(session.get("current_position") or {})
    session["trade_log"] = list(session.get("trade_log") or [])
    session["equity_curve"] = [
        round(float(value), 2) for value in (session.get("equity_curve") or [account_size])
    ]
    if not session["equity_curve"]:
        session["equity_curve"] = [account_size]

    if _has_open_position(session):
        mark_price = session["current_position"].get("mark_price")
        if mark_price:
            _mark_position(
                session["current_position"],
                float(mark_price),
                session["current_position"].get("last_mark_time") or session["current_position"]["entry_time"],
                session["tick_value"],
            )

    session["metrics_snapshot"] = _build_metrics_snapshot(session)
    session["guardrail_state"] = _build_guardrail_state(session)
    return session


def _build_metrics_snapshot(session: dict) -> dict:
    account_size = _account_size(session)
    trades = list(session.get("trade_log") or [])
    equity_curve = list(session.get("equity_curve") or [account_size])
    metrics = calculate_metrics(trades, equity_curve, account_size)
    current_position = session.get("current_position") or {}
    metrics["account_size"] = round(account_size, 2)
    metrics["commission"] = round(float(session.get("commission") or 0.0), 2)
    metrics["tick_value"] = round(float(session.get("tick_value") or 0.0), 2)
    metrics["realized_equity"] = _realized_equity(session)
    metrics["marked_equity"] = _marked_equity(session)
    metrics["open_position"] = bool(current_position)
    metrics["unrealized_pnl"] = round(float(current_position.get("unrealized_pnl") or 0.0), 2)
    metrics["last_trade_pnl"] = trades[-1]["pnl"] if trades else None
    return metrics


def _build_guardrail_state(session: dict) -> dict:
    account_size = _account_size(session)
    trades = list(session.get("trade_log") or [])
    equity_curve = list(session.get("equity_curve") or [account_size])
    evaluation = evaluate_prop_firm(
        session.get("prop_firm_rules") or {},
        trades,
        equity_curve,
        account_size,
    )
    evaluation["required_prop_pass"] = bool((session.get("guardrails") or {}).get("required_prop_pass"))
    evaluation["realized_equity"] = _realized_equity(session)
    evaluation["marked_equity"] = _marked_equity(session)
    evaluation["unrealized_pnl"] = round(
        float((session.get("current_position") or {}).get("unrealized_pnl") or 0.0),
        2,
    )
    evaluation["closed_trade_count"] = len(trades)
    evaluation["open_position"] = _has_open_position(session)
    return evaluation


def _account_size(session: dict) -> float:
    return round(float((session.get("prop_firm_rules") or {}).get("account_size") or 100_000), 2)


def _realized_equity(session: dict) -> float:
    realized = _account_size(session) + sum(float(trade.get("pnl") or 0.0) for trade in session.get("trade_log") or [])
    return round(realized, 2)


def _marked_equity(session: dict) -> float:
    current_position = session.get("current_position") or {}
    return round(_realized_equity(session) + float(current_position.get("unrealized_pnl") or 0.0), 2)


def _has_open_position(session: dict) -> bool:
    return bool((session.get("current_position") or {}).get("entry_time"))


def _require_open_position(session: dict) -> dict:
    position = session.get("current_position") or {}
    if not position.get("entry_time"):
        raise ValueError("There isn't an open paper position to manage yet.")
    return position


def _open_position(side: str, price: float, timestamp: str) -> dict:
    return {
        "side": side,
        "contracts": 1,
        "entry_price": round(price, 4),
        "entry_time": timestamp,
        "mark_price": round(price, 4),
        "last_mark_time": timestamp,
        "unrealized_pnl": 0.0,
        "status": "open",
    }


def _mark_position(position: dict, price: float, timestamp: str, tick_value: float) -> dict:
    position["mark_price"] = round(price, 4)
    position["last_mark_time"] = timestamp
    position["unrealized_pnl"] = round(_position_pnl(position, price, tick_value, commission=0.0), 2)
    return position


def _close_position(session: dict, position: dict, price: float, timestamp: str) -> dict:
    pnl = round(
        _position_pnl(
            position,
            price,
            float(session.get("tick_value") or 1.0),
            commission=float(session.get("commission") or 0.0),
        ),
        2,
    )
    return {
        "trade_id": len(session.get("trade_log") or []),
        "entry_time": position["entry_time"],
        "exit_time": timestamp,
        "side": position["side"],
        "entry_price": round(float(position["entry_price"]), 4),
        "exit_price": round(float(price), 4),
        "pnl": pnl,
        "status": "closed",
        "commission": round(float(session.get("commission") or 0.0), 2),
    }


def _position_pnl(position: dict, price: float, tick_value: float, *, commission: float) -> float:
    entry_price = float(position["entry_price"])
    if position["side"] == "buy":
        pnl = (price - entry_price) * tick_value
    else:
        pnl = (entry_price - price) * tick_value
    return pnl - commission


def _normalize_timestamp(raw: str) -> str:
    try:
        candidate = raw.strip().replace("Z", "+00:00")
        return datetime.fromisoformat(candidate).isoformat()
    except ValueError as exc:
        raise ValueError("Use a valid ISO timestamp for paper execution.") from exc


def _resolve_tick_value(symbol: str | None) -> float:
    if not symbol:
        return 1.0

    try:
        from services.db import get_symbol_info

        info = get_symbol_info(symbol)
        if info and info.get("tick_value"):
            return float(info["tick_value"])
    except Exception:
        pass

    return float(DEFAULT_TICK_VALUES.get(symbol.upper(), 1.0))


def _session_status_to_candidate_status(session_status: str, current_status: str | None) -> str:
    if session_status == PaperSessionStatus.READY.value:
        return "paper_ready"
    if session_status == PaperSessionStatus.RUNNING.value:
        return "paper_running"
    if session_status in {
        PaperSessionStatus.PAUSED.value,
        PaperSessionStatus.STOPPED.value,
        PaperSessionStatus.FAILED.value,
    }:
        return "paper_paused"
    return current_status or "approved"


def _session_status_to_paper_bot_status(session_status: str, current_status: str | None) -> str | None:
    if session_status == PaperSessionStatus.READY.value:
        return "ready"
    if session_status == PaperSessionStatus.RUNNING.value:
        return "paper_running"
    if session_status in {
        PaperSessionStatus.PAUSED.value,
        PaperSessionStatus.STOPPED.value,
        PaperSessionStatus.FAILED.value,
    }:
        return "stopped"
    return current_status
