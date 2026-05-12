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
from services.execution_model import (
    DEFAULT_RESTING_FILL_MODE,
    DEFAULT_SPREAD_TICKS,
    DEFAULT_TICK_SIZE,
    DEFAULT_VOLATILE_BAR_EXTRA_TICKS,
    DEFAULT_VOLATILE_BAR_THRESHOLD_TICKS,
    default_execution_config_for_symbol,
    make_resting_order,
    normalize_execution_action,
    normalize_resting_fill_mode,
    replace_resting_order,
    resting_order_fill_update,
    synthetic_quote_for_bar,
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
from services.prop_firm_eval import evaluate_prop_firm

DEFAULT_TICK_VALUES = {
    "NQ": 20.0,
    "MNQ": 2.0,
    "ES": 50.0,
    "MES": 5.0,
    "GC": 10.0,
    "MGC": 1.0,
}
DEFAULT_TICK_SIZES = {
    "NQ": 0.25,
    "MNQ": 0.25,
    "ES": 0.25,
    "MES": 0.25,
    "GC": 0.10,
    "MGC": 0.10,
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
        [build_paper_session_summary(dict(session)) for session in source],
        key=lambda session: session.get("updated_at", ""),
        reverse=True,
    )


def build_paper_session_summary(session: dict) -> dict:
    """Flatten one paper session into the compact list-card shape.

    This keeps the paper-session list readable without making the frontend
    reverse-engineer runner state. I pull out the bits an operator actually
    needs at a glance: health, cursor, latest runner action, and parity.
    """
    session = _ensure_session_defaults(dict(session))
    runner_state = dict(session.get("runner_state") or {})
    parity_check = dict(runner_state.get("parity_check") or {})

    health = _runner_health_label(runner_state, parity_check)
    parity_passed = parity_check.get("status") == "ok" and bool(parity_check.get("passed"))

    return {
        "paper_session_id": session["paper_session_id"],
        "candidate_id": session["candidate_id"],
        "name": session["name"],
        "symbol": session["symbol"],
        "interval": session["interval"],
        "status": session["status"],
        "runner_health": health,
        "runner_bars_processed": int(runner_state.get("bars_processed") or 0),
        "runner_last_candle_time": runner_state.get("last_candle_time"),
        "runner_last_action": runner_state.get("last_signal_action"),
        "runner_parity_passed": parity_passed if parity_check else None,
        "runner_last_error": runner_state.get("last_error"),
        "last_event_at": session.get("last_event_at"),
        "last_bar_time": session.get("last_bar_time"),
        "created_at": session["created_at"],
        "updated_at": session["updated_at"],
    }


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
    execution_defaults = default_execution_config_for_symbol(candidate["symbol"])
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
        "tick_size": _resolve_tick_size(candidate["symbol"]),
        "spread_ticks": execution_defaults["spread_ticks"],
        "volatile_bar_threshold_ticks": execution_defaults["volatile_bar_threshold_ticks"],
        "volatile_bar_extra_ticks": execution_defaults["volatile_bar_extra_ticks"],
        "resting_fill_mode": DEFAULT_RESTING_FILL_MODE,
        "current_position": {},
        "active_order": {},
        "active_orders": [],
        "last_quote": {},
        "trade_log": [],
        "equity_curve": [float((candidate.get("prop_firm_rules") or {}).get("account_size") or 100_000)],
        "metrics_snapshot": {},
        "guardrail_state": {},
        "runner_state": {},
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


def advance_paper_session_bar(
    paper_session_id: str,
    bar: dict,
    *,
    actor: str = "paper-runner",
    sync_candidate: bool = False,
) -> dict:
    """Apply one OHLCV bar to paper execution state.

    This is the bridge between the fake-live runner and the Phase 1 execution
    model. It updates the synthetic book, fills a resting order only on a later
    bar touch, and marks any open position at the bar close so the session stays
    useful even when no strategy action fires.
    """
    session = _ensure_session_defaults(_require_paper_session(paper_session_id))
    timestamp = _normalize_timestamp(str(bar["time"]))
    quote = _quote_for_bar(session, bar).as_dict()
    orders = _session_active_orders(session)
    filled_order = None
    closed_trade = None
    canceled_orders: list[dict] = []

    if orders:
        fill_candidates: list[dict] = []
        updated_orders: list[dict] = []
        current_bar_index = (session.get("runner_state") or {}).get("bars_processed")

        for order in orders:
            should_fill, updated_order = resting_order_fill_update(
                order,
                bar,
                fill_mode=str(session.get("resting_fill_mode") or DEFAULT_RESTING_FILL_MODE),
                bar_index=current_bar_index,
                timestamp=timestamp,
            )
            updated_orders.append(updated_order)
            if should_fill:
                fill_candidates.append(updated_order)

        if fill_candidates:
            filled_order = _pick_fill_candidate(fill_candidates)
            filled_order["status"] = "filled"
            filled_order["filled_at"] = timestamp
            filled_order["filled_bar_index"] = current_bar_index

            if _resting_order_intent(filled_order) == "exit":
                position = _require_open_position(session)
                closed_trade = _close_position(session, position, float(filled_order["price"]), timestamp)
                session["trade_log"] = [*(session.get("trade_log") or []), closed_trade]
                session["current_position"] = {}
                session["equity_curve"] = [*session.get("equity_curve", []), _realized_equity(session)]
            else:
                session["current_position"] = _open_position(
                    filled_order["side"],
                    float(filled_order["price"]),
                    timestamp,
                    float(filled_order.get("quantity") or 1),
                )

            next_orders: list[dict] = []
            for order in updated_orders:
                if str(order.get("id")) == str(filled_order.get("id")):
                    continue
                if _same_bracket_group(order, filled_order):
                    canceled_orders.append(
                        _cancel_order(
                            order,
                            timestamp=timestamp,
                            bar_index=current_bar_index,
                            reason="oco_sibling_filled",
                        )
                    )
                    continue
                next_orders.append(order)

            _set_session_active_orders(session, next_orders)
        else:
            _set_session_active_orders(session, updated_orders)

    if _has_open_position(session):
        position = _require_open_position(session)
        _mark_position(position, float(bar["close"]), timestamp, session["tick_value"])
        session["current_position"] = position
        session["equity_curve"] = [*session.get("equity_curve", []), _marked_equity(session)]

    now = _now()
    session["last_bar_time"] = timestamp
    session["last_quote"] = quote
    session["last_event_at"] = now
    session["updated_at"] = now
    session = _ensure_session_defaults(session)
    _save_paper_session_any(session)

    if filled_order:
        _append_paper_event_any(
            _make_paper_event(
                paper_session_id=paper_session_id,
                candidate_id=session["candidate_id"],
                event_type="order_filled",
                actor=actor,
                summary=_resting_fill_summary(filled_order, closed_trade, canceled_orders),
                created_at=now,
                payload={
                    "order": filled_order,
                    "quote": quote,
                    "closed_trade": closed_trade,
                    "canceled_sibling_orders": canceled_orders,
                },
            )
        )
    for canceled_order in canceled_orders:
        _append_paper_event_any(
            _make_paper_event(
                paper_session_id=paper_session_id,
                candidate_id=session["candidate_id"],
                event_type="order_canceled",
                actor=actor,
                summary=_resting_cancel_summary(canceled_order, reason="oco_sibling_filled"),
                created_at=now,
                payload={
                    "action": "cancel",
                    "order": canceled_order,
                    "quote": quote,
                    "reason": "oco_sibling_filled",
                    "filled_order_id": filled_order.get("id") if filled_order else None,
                },
            )
        )

    if sync_candidate:
        candidate = _require_candidate(session["candidate_id"])
        _sync_candidate_paper_session(candidate, paper_session_id, now, session_status=session["status"])
    return session


def execute_paper_session_action(
    paper_session_id: str,
    *,
    action: str,
    price: float | None = None,
    stop_price: float | None = None,
    target_price: float | None = None,
    quantity: float | None = None,
    filled_at: str | None = None,
    actor: str = "local-user",
    note: str | None = None,
    sync_candidate: bool = True,
) -> dict:
    session = _ensure_session_defaults(_require_paper_session(paper_session_id))
    raw_action = action.strip().lower()
    action_key = normalize_execution_action(raw_action)
    timestamp = _resolve_execution_timestamp(session, filled_at)
    quote = _resolve_session_quote(session, price=price)
    execution_price = _price_for_action(action_key, quote, price)
    active_orders = _session_active_orders(session)
    resolved_quantity = round(float(quantity or 1.0), 4)

    if action_key in {"lift_ask", "hit_bid"}:
        if session["status"] not in OPEN_ACTION_STATUSES:
            raise ValueError("Paper session must be ready or running before you can open a position.")

        side = "buy" if action_key == "lift_ask" else "sell"
        previous_status = session["status"]
        closed_trade = None
        if _has_open_position(session):
            position = _require_open_position(session)
            if position.get("side") == side:
                raise ValueError("That side is already open. Use `mark`, `flatten`, or the opposite action.")
            closed_trade = _close_position(session, position, execution_price, timestamp)
            session["trade_log"] = [*(session.get("trade_log") or []), closed_trade]

        _set_session_active_orders(session, [])
        session["current_position"] = _open_position(side, execution_price, timestamp, resolved_quantity)
        if previous_status == PaperSessionStatus.READY.value:
            session["status"] = PaperSessionStatus.RUNNING.value

        summary = note or f"{_execution_label(action_key)} {_contract_phrase(resolved_quantity)} filled at {execution_price:.2f}."
        payload = {
            "action": action_key,
            "raw_action": raw_action,
            "quote": quote,
            "entry_price": execution_price,
            "entry_time": timestamp,
            "side": side,
            "quantity": resolved_quantity,
            "status_auto_started": previous_status != session["status"],
            "closed_trade": closed_trade,
        }
        audit_summary = summary
        event_type = "position_opened"
    elif action_key in {"join_bid", "join_ask"}:
        if session["status"] not in OPEN_ACTION_STATUSES:
            raise ValueError("Paper session must be ready or running before you can post an order.")
        if _has_open_position(session):
            raise ValueError("Resting entry orders are only supported while flat in Phase 1.")
        if active_orders:
            raise ValueError("Cancel the current resting order before posting another one.")

        order_price = quote["bid"] if action_key == "join_bid" else quote["ask"]
        order = make_resting_order(
            order_id=str(uuid.uuid4()),
            action=action_key,
            price=order_price,
            submitted_at=timestamp,
            submitted_bar_index=(session.get("runner_state") or {}).get("bars_processed"),
            quantity=resolved_quantity,
        )
        _set_session_active_orders(session, [order])
        summary = note or f"Posted {action_key.replace('_', ' ')} {_contract_phrase(resolved_quantity)} at {order_price:.2f}."
        payload = {
            "action": action_key,
            "quote": quote,
            "order": order,
            "quantity": resolved_quantity,
        }
        audit_summary = summary
        event_type = "order_submitted"
    elif action_key == "rest_exit":
        if session["status"] not in POSITION_ACTION_STATUSES:
            raise ValueError("Paper session must be ready, running, or paused before you can post a resting exit.")
        position = _require_open_position(session)
        if active_orders:
            raise ValueError("Cancel the current resting order before posting another one.")

        order_side = "sell" if position.get("side") == "buy" else "buy"
        order_price = quote["ask"] if order_side == "sell" else quote["bid"]
        order = make_resting_order(
            order_id=str(uuid.uuid4()),
            action=action_key,
            price=order_price,
            submitted_at=timestamp,
            submitted_bar_index=(session.get("runner_state") or {}).get("bars_processed"),
            intent="exit",
            side=order_side,
            quantity=float(position.get("quantity") or position.get("contracts") or 1),
        )
        _set_session_active_orders(session, [order])
        summary = note or f"Posted resting exit for the {position['side']} trade at {order_price:.2f}."
        payload = {
            "action": action_key,
            "quote": quote,
            "order": order,
            "position_side": position["side"],
        }
        audit_summary = summary
        event_type = "order_submitted"
    elif action_key == "attach_bracket":
        if session["status"] not in POSITION_ACTION_STATUSES:
            raise ValueError("Paper session must be ready, running, or paused before you can attach a bracket.")
        position = _require_open_position(session)
        if active_orders:
            raise ValueError("Cancel the current resting order before attaching a bracket.")
        if stop_price is None or target_price is None:
            raise ValueError("Bracket exits need both `stop_price` and `target_price`.")

        stop_value = round(float(stop_price), 4)
        target_value = round(float(target_price), 4)
        _validate_bracket_prices(position, quote, stop_value, target_value)
        bracket_orders = _make_bracket_exit_orders(
            position=position,
            stop_price=stop_value,
            target_price=target_value,
            submitted_at=timestamp,
            submitted_bar_index=(session.get("runner_state") or {}).get("bars_processed"),
        )
        _set_session_active_orders(session, bracket_orders)
        summary = note or _bracket_summary(position["side"], stop_value, target_value)
        payload = {
            "action": action_key,
            "quote": quote,
            "orders": bracket_orders,
            "position_side": position["side"],
            "stop_price": stop_value,
            "target_price": target_value,
            "bracket_id": bracket_orders[0].get("bracket_id"),
        }
        audit_summary = summary
        event_type = "order_submitted"
    elif action_key == "cancel":
        if not active_orders:
            raise ValueError("There isn't a resting order to cancel.")
        canceled = [
            _cancel_order(
                order,
                timestamp=timestamp,
                bar_index=(session.get("runner_state") or {}).get("bars_processed"),
                reason="user_cancel",
            )
            for order in active_orders
        ]
        _set_session_active_orders(session, [])
        summary = note or _cancel_many_summary(canceled)
        payload = {
            "action": action_key,
            "order": canceled[0],
            "orders": canceled,
            "quote": quote,
        }
        audit_summary = summary
        event_type = "order_canceled"
    elif action_key == "replace":
        if not active_orders:
            raise ValueError("There isn't a resting order to replace.")
        if len(active_orders) != 1:
            raise ValueError("Replace only supports one live order right now. Cancel the bracket and post a new one.")
        order = dict(active_orders[0])

        replacement_price = execution_price
        if replacement_price is None:
            replacement_price = round(float(quote["bid" if order.get("side") == "buy" else "ask"]), 4)

        replaced_order, child_order = replace_resting_order(
            order,
            new_order_id=str(uuid.uuid4()),
            price=replacement_price,
            submitted_at=timestamp,
            submitted_bar_index=(session.get("runner_state") or {}).get("bars_processed"),
        )
        _set_session_active_orders(session, [child_order])
        summary = note or _resting_replace_summary(replaced_order, child_order)
        payload = {
            "action": action_key,
            "quote": quote,
            "replaced_order": replaced_order,
            "order": child_order,
        }
        audit_summary = summary
        event_type = "order_replaced"
    elif action_key == "mark":
        if session["status"] not in POSITION_ACTION_STATUSES:
            raise ValueError("Paper session must be ready, running, or paused before you can mark a position.")
        position = _require_open_position(session)
        mark_price = execution_price if execution_price is not None else quote["reference"]
        _mark_position(position, mark_price, timestamp, session["tick_value"])
        session["current_position"] = position
        session["equity_curve"] = [*session.get("equity_curve", []), _marked_equity(session)]
        summary = note or f"Marked the open {position['side']} position at {mark_price:.2f}."
        payload = {
            "action": action_key,
            "mark_price": mark_price,
            "quote": quote,
            "marked_equity": _marked_equity(session),
            "unrealized_pnl": position["unrealized_pnl"],
        }
        audit_summary = summary
        event_type = "position_marked"
    elif action_key == "flatten":
        if session["status"] not in POSITION_ACTION_STATUSES:
            raise ValueError("Paper session must be ready, running, or paused before you can flatten a position.")
        canceled_orders = [
            _cancel_order(
                order,
                timestamp=timestamp,
                bar_index=(session.get("runner_state") or {}).get("bars_processed"),
                reason="flatten",
            )
            for order in active_orders
        ]
        _set_session_active_orders(session, [])
        if _has_open_position(session):
            position = _require_open_position(session)
            flatten_price = quote["bid"] if position.get("side") == "buy" else quote["ask"]
            if price is not None:
                flatten_price = round(float(price), 4)
            trade = _close_position(session, position, flatten_price, timestamp)
            session["trade_log"] = [*(session.get("trade_log") or []), trade]
            session["current_position"] = {}
            session["equity_curve"] = [*session.get("equity_curve", []), _realized_equity(session)]
            summary = note or f"Flattened the {trade['side']} paper trade at {flatten_price:.2f} for {trade['pnl']:+.2f}."
            payload = {
                "action": action_key,
                "trade_id": trade["trade_id"],
                "exit_price": flatten_price,
                "pnl": trade["pnl"],
                "quote": quote,
                "canceled_order": canceled_orders[0] if canceled_orders else None,
                "canceled_orders": canceled_orders,
                "realized_equity": _realized_equity(session),
            }
            event_type = "position_closed"
        elif canceled_orders:
            summary = note or "Flatten canceled the resting order; no position was open."
            payload = {
                "action": action_key,
                "quote": quote,
                "canceled_order": canceled_orders[0],
                "canceled_orders": canceled_orders,
            }
            event_type = "order_canceled"
        else:
            raise ValueError("There isn't an open position or resting order to flatten.")
        audit_summary = summary
    else:
        raise ValueError(f"Unsupported paper session action '{action}'.")

    now = _now()
    session["last_bar_time"] = timestamp
    session["last_quote"] = quote
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

    if sync_candidate:
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


def _force_close_open_position(
    paper_session_id: str,
    *,
    price: float,
    filled_at: str | None = None,
    actor: str = "paper-runner",
    note: str | None = None,
    sync_candidate: bool = True,
) -> dict:
    """Close the live paper position without growing the equity curve.

    The runner uses this at the end of a window so the last candle can be
    realized instead of left hanging open. It behaves like a normal flatten,
    but rewrites the last equity point to the realized value so the saved
    curve still lines up with the final bar.
    """
    session = _ensure_session_defaults(_require_paper_session(paper_session_id))
    if not _has_open_position(session):
        return session

    timestamp = _resolve_execution_timestamp(session, filled_at)
    quote = _resolve_session_quote(session, price=price)
    close_price = _price_for_action("flatten", quote, price)
    if close_price is None:
        raise ValueError("Runner force-close needs a valid price.")

    position = _require_open_position(session)
    trade = _close_position(session, position, close_price, timestamp)
    session["trade_log"] = [*(session.get("trade_log") or []), trade]
    session["current_position"] = {}

    realized_equity = _realized_equity(session)
    if session.get("equity_curve"):
        session["equity_curve"][-1] = realized_equity
    else:
        session["equity_curve"] = [realized_equity]

    now = _now()
    session["last_bar_time"] = timestamp
    session["last_quote"] = quote
    session["last_event_at"] = now
    session["updated_at"] = now
    session = _ensure_session_defaults(session)
    _save_paper_session_any(session)

    summary = note or f"Runner force-closed the open {trade['side']} position at {close_price:.2f}."
    _append_paper_event_any(
        _make_paper_event(
            paper_session_id=session["paper_session_id"],
            candidate_id=session["candidate_id"],
            event_type="position_closed",
            actor=actor,
            summary=summary,
            created_at=now,
            payload={
                "action": "flatten",
                "trade": trade,
                "quote": quote,
                "exit_price": close_price,
                "realized_equity": realized_equity,
            },
        )
    )

    if sync_candidate:
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
            summary=summary,
            created_at=now,
        )

    return _ensure_session_defaults(_require_paper_session(paper_session_id))


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


def _session_active_orders(session: dict) -> list[dict]:
    orders = session.get("active_orders")
    if isinstance(orders, list) and orders:
        return [dict(order) for order in orders if isinstance(order, dict) and order]

    order = dict(session.get("active_order") or {})
    return [order] if order else []


def _set_session_active_orders(session: dict, orders: list[dict]) -> dict:
    normalized = []
    for order in orders:
        if not order:
            continue
        next_order = dict(order)
        next_order["intent"] = _resting_order_intent(next_order)
        normalized.append(next_order)

    session["active_orders"] = normalized
    session["active_order"] = dict(normalized[0]) if normalized else {}
    return session


def _resting_order_intent(order: dict | None) -> str:
    candidate = str((order or {}).get("intent") or "").strip().lower()
    if candidate == "exit":
        return "exit"
    if str((order or {}).get("type") or "").strip().lower() == "rest_exit":
        return "exit"
    return "entry"


def _resting_order_role(order: dict | None) -> str:
    candidate = str((order or {}).get("bracket_role") or "").strip().lower()
    if candidate in {"stop", "target"}:
        return candidate
    return "single"


def _resting_fill_summary(order: dict, closed_trade: dict | None, canceled_orders: list[dict] | None = None) -> str:
    price = float(order.get("price") or 0.0)
    canceled_orders = canceled_orders or []
    sibling_note = " OCO sibling canceled." if canceled_orders else ""
    if _resting_order_intent(order) == "exit" and closed_trade:
        role = _resting_order_role(order)
        label = "Resting exit"
        if role == "target":
            label = "Bracket target"
        elif role == "stop":
            label = "Bracket stop"
        return (
            f"{label} filled at {price:.2f} and closed the "
            f"{closed_trade['side']} trade for {float(closed_trade['pnl']):+.2f}.{sibling_note}"
        )
    return f"Resting {order['side']} entry filled at {price:.2f}."


def _resting_cancel_summary(order: dict, *, reason: str | None = None) -> str:
    price = float(order.get("price") or 0.0)
    if _resting_order_intent(order) == "exit":
        role = _resting_order_role(order)
        if role == "target":
            base = f"Canceled bracket target {order.get('side')} order at {price:.2f}."
        elif role == "stop":
            base = f"Canceled bracket stop {order.get('side')} order at {price:.2f}."
        else:
            base = f"Canceled resting exit {order.get('side')} order at {price:.2f}."
        if reason == "oco_sibling_filled":
            return base[:-1] + " because its sibling filled first."
        if reason == "flatten":
            return base[:-1] + " while flattening."
        return base
    return f"Canceled resting {order.get('side')} entry order at {price:.2f}."


def _cancel_many_summary(orders: list[dict]) -> str:
    if len(orders) == 1:
        return _resting_cancel_summary(orders[0])
    return f"Canceled {len(orders)} live resting orders."


def _bracket_summary(position_side: str, stop_price: float, target_price: float) -> str:
    return (
        f"Attached a {position_side} bracket with stop {stop_price:.2f} "
        f"and target {target_price:.2f}."
    )


def _same_bracket_group(left: dict | None, right: dict | None) -> bool:
    left_group = str((left or {}).get("bracket_id") or "").strip()
    right_group = str((right or {}).get("bracket_id") or "").strip()
    return bool(left_group and right_group and left_group == right_group)


def _resting_order_priority(order: dict) -> int:
    role = _resting_order_role(order)
    if role == "stop":
        return 0
    if role == "target":
        return 1
    return 2


def _pick_fill_candidate(orders: list[dict]) -> dict:
    return min(
        (dict(order) for order in orders),
        key=lambda order: (
            _resting_order_priority(order),
            float(order.get("price") or 0.0),
            str(order.get("id") or ""),
        ),
    )


def _cancel_order(
    order: dict,
    *,
    timestamp: str,
    bar_index: int | None,
    reason: str | None = None,
) -> dict:
    canceled = dict(order)
    canceled["status"] = "canceled"
    canceled["canceled_at"] = timestamp
    canceled["canceled_bar_index"] = bar_index
    if reason:
        canceled["cancel_reason"] = reason
    return canceled


def _validate_bracket_prices(position: dict, quote: dict, stop_price: float, target_price: float) -> None:
    reference = float(quote.get("reference") or position.get("mark_price") or position["entry_price"])
    side = str(position.get("side") or "").strip().lower()

    if side == "buy":
        if stop_price >= reference:
            raise ValueError("Long brackets need the stop below the current reference price.")
        if target_price <= reference:
            raise ValueError("Long brackets need the target above the current reference price.")
    else:
        if stop_price <= reference:
            raise ValueError("Short brackets need the stop above the current reference price.")
        if target_price >= reference:
            raise ValueError("Short brackets need the target below the current reference price.")


def _make_bracket_exit_orders(
    *,
    position: dict,
    stop_price: float,
    target_price: float,
    submitted_at: str,
    submitted_bar_index: int | None,
) -> list[dict]:
    """Build the two OCO exit legs for one open trade.

    I keep both legs as explicit resting exits so the paper and replay layers
    can show the real lifecycle instead of pretending the bracket is magical
    hidden state. One fills, the sibling gets canceled.
    """
    exit_side = "sell" if position.get("side") == "buy" else "buy"
    quantity = float(position.get("quantity") or position.get("contracts") or 1)
    bracket_id = str(uuid.uuid4())
    stop_id = str(uuid.uuid4())
    target_id = str(uuid.uuid4())

    stop_order = make_resting_order(
        order_id=stop_id,
        action="bracket_stop",
        price=stop_price,
        submitted_at=submitted_at,
        submitted_bar_index=submitted_bar_index,
        intent="exit",
        side=exit_side,
        quantity=quantity,
    )
    stop_order["reduce_only"] = True
    stop_order["bracket_id"] = bracket_id
    stop_order["bracket_role"] = "stop"
    stop_order["sibling_order_id"] = target_id

    target_order = make_resting_order(
        order_id=target_id,
        action="bracket_target",
        price=target_price,
        submitted_at=submitted_at,
        submitted_bar_index=submitted_bar_index,
        intent="exit",
        side=exit_side,
        quantity=quantity,
    )
    target_order["reduce_only"] = True
    target_order["bracket_id"] = bracket_id
    target_order["bracket_role"] = "target"
    target_order["sibling_order_id"] = stop_id

    return [target_order, stop_order]


def _resting_replace_summary(order: dict, child_order: dict) -> str:
    old_price = float(order.get("price") or 0.0)
    new_price = float(child_order.get("price") or 0.0)
    if _resting_order_intent(order) == "exit":
        return (
            f"Replaced resting exit {order.get('side')} order "
            f"from {old_price:.2f} to {new_price:.2f}."
        )
    return (
        f"Replaced resting {order.get('side')} entry order "
        f"from {old_price:.2f} to {new_price:.2f}."
    )


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
    session["tick_size"] = float(session.get("tick_size") or _resolve_tick_size(session.get("symbol")))
    session["spread_ticks"] = int(session.get("spread_ticks") or DEFAULT_SPREAD_TICKS)
    session["volatile_bar_threshold_ticks"] = int(session.get("volatile_bar_threshold_ticks") or DEFAULT_VOLATILE_BAR_THRESHOLD_TICKS)
    session["volatile_bar_extra_ticks"] = int(session.get("volatile_bar_extra_ticks") or DEFAULT_VOLATILE_BAR_EXTRA_TICKS)
    session["resting_fill_mode"] = normalize_resting_fill_mode(session.get("resting_fill_mode"))
    session["current_position"] = dict(session.get("current_position") or {})
    _set_session_active_orders(
        session,
        _session_active_orders(session),
    )
    session["last_quote"] = dict(session.get("last_quote") or {})
    session["trade_log"] = list(session.get("trade_log") or [])
    session["equity_curve"] = [
        round(float(value), 2) for value in (session.get("equity_curve") or [account_size])
    ]
    session["runner_state"] = _ensure_runner_state_defaults(session.get("runner_state"))
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
    metrics["tick_size"] = round(float(session.get("tick_size") or 0.0), 4)
    metrics["spread_ticks"] = int(session.get("spread_ticks") or DEFAULT_SPREAD_TICKS)
    metrics["volatile_bar_threshold_ticks"] = int(
        session.get("volatile_bar_threshold_ticks") or DEFAULT_VOLATILE_BAR_THRESHOLD_TICKS
    )
    metrics["volatile_bar_extra_ticks"] = int(
        session.get("volatile_bar_extra_ticks") or DEFAULT_VOLATILE_BAR_EXTRA_TICKS
    )
    metrics["resting_fill_mode"] = normalize_resting_fill_mode(session.get("resting_fill_mode"))
    metrics["realized_equity"] = _realized_equity(session)
    metrics["marked_equity"] = _marked_equity(session)
    metrics["open_position"] = bool(current_position)
    metrics["active_order"] = bool(_session_active_orders(session))
    metrics["active_order_count"] = len(_session_active_orders(session))
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
    commission = float(session.get("commission") or 0.0) if _has_open_position(session) else 0.0
    return round(_realized_equity(session) + float(current_position.get("unrealized_pnl") or 0.0) - commission, 2)


def _has_open_position(session: dict) -> bool:
    return bool((session.get("current_position") or {}).get("entry_time"))


def _require_open_position(session: dict) -> dict:
    position = session.get("current_position") or {}
    if not position.get("entry_time"):
        raise ValueError("There isn't an open paper position to manage yet.")
    return position


def _open_position(side: str, price: float, timestamp: str, quantity: float = 1.0) -> dict:
    size = round(float(quantity), 4)
    return {
        "side": side,
        "contracts": size,
        "quantity": size,
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
        "quantity": float(position.get("quantity") or position.get("contracts") or 1),
        "entry_price": round(float(position["entry_price"]), 4),
        "exit_price": round(float(price), 4),
        "pnl": pnl,
        "status": "closed",
        "commission": round(float(session.get("commission") or 0.0), 2),
    }


def _position_pnl(position: dict, price: float, tick_value: float, *, commission: float) -> float:
    entry_price = float(position["entry_price"])
    quantity = float(position.get("quantity") or position.get("contracts") or 1)
    if position["side"] == "buy":
        pnl = (price - entry_price) * tick_value * quantity
    else:
        pnl = (entry_price - price) * tick_value * quantity
    return pnl - commission


def _normalize_timestamp(raw: str) -> str:
    try:
        candidate = raw.strip().replace("Z", "+00:00")
        return datetime.fromisoformat(candidate).isoformat()
    except ValueError as exc:
        raise ValueError("Use a valid ISO timestamp for paper execution.") from exc


def _resolve_execution_timestamp(session: dict, filled_at: str | None) -> str:
    if filled_at:
        return _normalize_timestamp(filled_at)

    last_bar_time = session.get("last_bar_time")
    if last_bar_time:
        return _normalize_timestamp(str(last_bar_time))

    return _now()


def _quote_for_bar(session: dict, bar: dict) -> object:
    return synthetic_quote_for_bar(
        bar,
        tick_size=float(session.get("tick_size") or DEFAULT_TICK_SIZE),
        spread_ticks=int(session.get("spread_ticks") or DEFAULT_SPREAD_TICKS),
        volatile_bar_threshold_ticks=int(
            session.get("volatile_bar_threshold_ticks") or DEFAULT_VOLATILE_BAR_THRESHOLD_TICKS
        ),
        volatile_bar_extra_ticks=int(
            session.get("volatile_bar_extra_ticks") or DEFAULT_VOLATILE_BAR_EXTRA_TICKS
        ),
    )


def _resolve_session_quote(session: dict, *, price: float | None = None) -> dict:
    quote = dict(session.get("last_quote") or {})
    if quote:
        return quote

    if price is None:
        raise ValueError("Run or step the session to build a synthetic bid/ask before executing.")

    synthetic = synthetic_quote_for_bar(
        {"close": float(price), "high": float(price), "low": float(price)},
        tick_size=float(session.get("tick_size") or DEFAULT_TICK_SIZE),
        spread_ticks=int(session.get("spread_ticks") or DEFAULT_SPREAD_TICKS),
        volatile_bar_threshold_ticks=int(
            session.get("volatile_bar_threshold_ticks") or DEFAULT_VOLATILE_BAR_THRESHOLD_TICKS
        ),
        volatile_bar_extra_ticks=int(
            session.get("volatile_bar_extra_ticks") or DEFAULT_VOLATILE_BAR_EXTRA_TICKS
        ),
    )
    return synthetic.as_dict()


def _price_for_action(action: str, quote: dict, price: float | None) -> float | None:
    if price is not None:
        value = round(float(price), 4)
        if value <= 0:
            raise ValueError("Execution price must be greater than zero.")
        return value

    if action == "lift_ask":
        return round(float(quote["ask"]), 4)
    if action == "hit_bid":
        return round(float(quote["bid"]), 4)
    if action == "mark":
        return round(float(quote["reference"]), 4)
    return None


def _execution_label(action: str) -> str:
    if action == "lift_ask":
        return "Lift ask"
    if action == "hit_bid":
        return "Hit bid"
    return action.replace("_", " ").title()


def _contract_phrase(quantity: float) -> str:
    rounded = round(float(quantity), 4)
    label = f"{rounded:g}"
    return f"{label} contract" if rounded == 1 else f"{label} contracts"


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


def _resolve_tick_size(symbol: str | None) -> float:
    if not symbol:
        return DEFAULT_TICK_SIZE

    try:
        from services.db import get_symbol_info

        info = get_symbol_info(symbol)
        if info and info.get("tick_size"):
            return float(info["tick_size"])
    except Exception:
        pass

    return float(DEFAULT_TICK_SIZES.get(symbol.upper(), DEFAULT_TICK_SIZE))


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


def _ensure_runner_state_defaults(state: dict | None) -> dict:
    payload = dict(state or {})
    payload.setdefault("mode", "idle")
    payload.setdefault("bars_processed", 0)
    payload.setdefault("poll_interval_ms", 750)
    payload.setdefault("start_date", None)
    payload.setdefault("end_date", None)
    payload.setdefault("last_candle_time", None)
    payload.setdefault("last_price", None)
    payload.setdefault("last_signal", 0)
    payload.setdefault("last_signal_action", None)
    payload.setdefault("last_signal_reason", None)
    payload.setdefault("auto_trade_enabled", True)
    payload.setdefault("parity_check", {})
    payload.setdefault("last_error", None)
    payload.setdefault("updated_at", None)
    return payload


def _runner_health_label(runner_state: dict, parity_check: dict | None = None) -> str:
    parity_check = parity_check or {}
    mode = str(runner_state.get("mode") or "idle")
    last_error = runner_state.get("last_error")

    if mode == "failed" or last_error:
        return "failed"
    if mode == "completed":
        if parity_check.get("status") == "ok" and parity_check.get("passed"):
            return "quiet"
        if parity_check:
            return "drift"
        return "completed"
    if mode == "running":
        return "healthy"
    if mode == "paused":
        return "paused"
    if int(runner_state.get("bars_processed") or 0) > 0:
        return "observed"
    return "idle"
