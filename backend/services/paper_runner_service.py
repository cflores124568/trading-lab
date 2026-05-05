from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime
from threading import Event, Lock, Thread
from typing import Any

import pandas as pd
from services.backtest_repo import get_backtest as get_backtest_db
from services.backtest_store import get_backtest as get_backtest_mem
from schemas import PaperSessionStatus
from services.db import db_configured, get_next_ohlcv_bar, get_ohlcv
from services.indicators import add_all_indicators
from services.paper_session_service import (
    _append_candidate_session_audit,
    _append_paper_event_any,
    _force_close_open_position,
    _ensure_session_defaults,
    _has_open_position,
    _make_paper_event,
    _now,
    _normalize_timestamp,
    _require_candidate,
    _require_paper_session,
    _save_paper_session_any,
    _sync_candidate_paper_session,
    advance_paper_session_bar,
    execute_paper_session_action,
)
from services.strategy import generate_signals

DEFAULT_RUNNER_POLL_INTERVAL_MS = 750
MIN_RUNNER_POLL_INTERVAL_MS = 100
MAX_RUNNER_POLL_INTERVAL_MS = 60_000


@dataclass
class _RunnerHandle:
    stop_event: Event
    thread: Thread


_registry_lock = Lock()
_runner_handles: dict[str, _RunnerHandle] = {}
_session_locks: dict[str, Lock] = {}
_signal_bar_history: dict[str, list[dict[str, Any]]] = {}


def start_historical_runner(
    paper_session_id: str,
    *,
    actor: str = "local-user",
    start_date: str | None = None,
    end_date: str | None = None,
    poll_interval_ms: int = DEFAULT_RUNNER_POLL_INTERVAL_MS,
    reset_cursor: bool = False,
) -> dict:
    """Start or resume the fake-live historical loop for one paper session.

    This keeps time simulated, not wall-clock based, and advances one candle at
    a time in the background. I persist cursor and runner settings on the
    session itself so you can pause, resume, and inspect later without losing
    where the run left off.
    """
    _require_db_runner_support()
    poll = _validate_poll_interval(poll_interval_ms)
    start_ts = _normalize_optional_timestamp(start_date)
    end_ts = _normalize_optional_timestamp(end_date)
    _validate_range(start_ts, end_ts)

    with _session_lock(paper_session_id):
        session = _ensure_session_defaults(_require_paper_session(paper_session_id))
        _validate_runner_session_status(session, allow_running=True)
        now = _now()

        state = _ensure_runner_state(session.get("runner_state"))
        state = _apply_default_window(session, state)
        if start_ts is not None:
            state["start_date"] = start_ts
        if end_ts is not None:
            state["end_date"] = end_ts
        _validate_range(state.get("start_date"), state.get("end_date"))

        if reset_cursor:
            session["last_bar_time"] = None
            state["bars_processed"] = 0
            state["last_candle_time"] = None
            state["last_price"] = None
            state["last_signal"] = 0
            state["last_signal_action"] = None
            state["last_signal_reason"] = None
            state["parity_check"] = {}
            _reset_signal_history(paper_session_id)

        state["mode"] = "running"
        state["poll_interval_ms"] = poll
        state["last_error"] = None
        state["updated_at"] = now

        session["runner_state"] = state
        session["status"] = PaperSessionStatus.RUNNING.value
        session["last_event_at"] = now
        session["updated_at"] = now
        _save_paper_session_any(session)

        _append_paper_event_any(
            _make_paper_event(
                paper_session_id=paper_session_id,
                candidate_id=session["candidate_id"],
                event_type="runner_started",
                actor=actor,
                summary="Started the historical paper runner loop.",
                created_at=now,
                payload={
                    "start_date": state.get("start_date"),
                    "end_date": state.get("end_date"),
                    "poll_interval_ms": state.get("poll_interval_ms"),
                    "reset_cursor": reset_cursor,
                },
            )
        )

        candidate = _require_candidate(session["candidate_id"])
        _sync_candidate_paper_session(
            candidate,
            paper_session_id,
            now,
            session_status=session["status"],
        )
        _append_candidate_session_audit(
            candidate,
            actor=actor,
            summary="Started the historical paper runner.",
            created_at=now,
        )

    _spawn_runner_thread(paper_session_id)
    return _ensure_session_defaults(_require_paper_session(paper_session_id))


def pause_historical_runner(
    paper_session_id: str,
    *,
    actor: str = "local-user",
    summary: str | None = None,
) -> dict:
    """Pause the background historical loop but keep all runner state intact.

    I don't throw away the cursor when paused, so resume continues from the next
    candle. This is the safe "hold position and inspect" control for paper
    sessions that are mid-window.
    """
    _stop_runner_thread(paper_session_id)

    with _session_lock(paper_session_id):
        session = _ensure_session_defaults(_require_paper_session(paper_session_id))
        state = _ensure_runner_state(session.get("runner_state"))
        now = _now()

        if state.get("mode") not in {"completed", "failed"}:
            state["mode"] = "paused"
        state["updated_at"] = now
        session["runner_state"] = state

        if session["status"] == PaperSessionStatus.RUNNING.value:
            session["status"] = PaperSessionStatus.PAUSED.value

        session["last_event_at"] = now
        session["updated_at"] = now
        _save_paper_session_any(session)

        note = summary or "Paused the historical paper runner."
        _append_paper_event_any(
            _make_paper_event(
                paper_session_id=paper_session_id,
                candidate_id=session["candidate_id"],
                event_type="runner_paused",
                actor=actor,
                summary=note,
                created_at=now,
                payload={
                    "last_candle_time": state.get("last_candle_time"),
                    "bars_processed": state.get("bars_processed"),
                },
            )
        )

        candidate = _require_candidate(session["candidate_id"])
        _sync_candidate_paper_session(
            candidate,
            paper_session_id,
            now,
            session_status=session["status"],
        )
        _append_candidate_session_audit(
            candidate,
            actor=actor,
            summary=note,
            created_at=now,
        )

    return _ensure_session_defaults(_require_paper_session(paper_session_id))


def step_historical_runner(
    paper_session_id: str,
    *,
    actor: str = "local-user",
    steps: int = 1,
) -> dict:
    """Advance the runner manually by N bars without starting auto-looping.

    This is the deterministic control for debugging or demos where you want to
    move a session one candle at a time. It updates the same session state as
    the background loop, just without sleeping or threading.
    """
    _require_db_runner_support()
    if steps < 1 or steps > 500:
        raise ValueError("Runner step count must stay between 1 and 500.")

    if _runner_thread_alive(paper_session_id):
        raise ValueError("Pause the running historical loop before manual stepping.")

    with _session_lock(paper_session_id):
        session = _ensure_session_defaults(_require_paper_session(paper_session_id))
        _validate_runner_session_status(session, allow_running=False)

        state = _ensure_runner_state(session.get("runner_state"))
        state = _apply_default_window(session, state)
        state["mode"] = "paused"
        state["updated_at"] = _now()
        session["runner_state"] = state
        _save_paper_session_any(session)

        completed = 0
        for _ in range(steps):
            _, outcome = _advance_one_bar_locked(paper_session_id, actor=actor, keep_running=False)
            if outcome != "stepped":
                break
            completed += 1

        refreshed = _ensure_session_defaults(_require_paper_session(paper_session_id))
        now = _now()
        if refreshed["status"] != PaperSessionStatus.FAILED.value:
            refreshed["status"] = PaperSessionStatus.PAUSED.value
        _append_paper_event_any(
            _make_paper_event(
                paper_session_id=paper_session_id,
                candidate_id=refreshed["candidate_id"],
                event_type="runner_step",
                actor=actor,
                summary=f"Stepped the historical runner by {completed} bar(s).",
                created_at=now,
                payload={
                    "requested_steps": steps,
                    "completed_steps": completed,
                    "last_candle_time": (refreshed.get("runner_state") or {}).get("last_candle_time"),
                    "mode": (refreshed.get("runner_state") or {}).get("mode"),
                },
            )
        )
        refreshed["last_event_at"] = now
        refreshed["updated_at"] = now
        _save_paper_session_any(refreshed)
        candidate = _require_candidate(refreshed["candidate_id"])
        _sync_candidate_paper_session(
            candidate,
            paper_session_id,
            now,
            session_status=refreshed["status"],
        )
        _append_candidate_session_audit(
            candidate,
            actor=actor,
            summary=f"Stepped the historical runner by {completed} bar(s).",
            created_at=now,
        )
        return _ensure_session_defaults(_require_paper_session(paper_session_id))


def stop_all_historical_runners() -> None:
    """Stop every in-process runner thread, usually on app shutdown."""
    with _registry_lock:
        handles = list(_runner_handles.items())
        _runner_handles.clear()
        _signal_bar_history.clear()

    for _, handle in handles:
        handle.stop_event.set()
    for _, handle in handles:
        if handle.thread.is_alive():
            handle.thread.join(timeout=2.0)


def _runner_loop(paper_session_id: str, stop_event: Event) -> None:
    try:
        while not stop_event.is_set():
            with _session_lock(paper_session_id):
                session, outcome = _advance_one_bar_locked(
                    paper_session_id,
                    actor="paper-runner",
                    keep_running=True,
                )

            if outcome != "stepped":
                break

            state = _ensure_runner_state(session.get("runner_state"))
            poll_ms = _validate_poll_interval(int(state.get("poll_interval_ms") or DEFAULT_RUNNER_POLL_INTERVAL_MS))
            if stop_event.wait(poll_ms / 1000):
                break
    except Exception as exc:
        with _session_lock(paper_session_id):
            _mark_runner_failed_locked(paper_session_id, str(exc))
    finally:
        _clear_runner_handle(paper_session_id, stop_event)


def _advance_one_bar_locked(
    paper_session_id: str,
    *,
    actor: str,
    keep_running: bool,
) -> tuple[dict, str]:
    session = _ensure_session_defaults(_require_paper_session(paper_session_id))
    state = _ensure_runner_state(session.get("runner_state"))
    state = _apply_default_window(session, state)
    _validate_range(state.get("start_date"), state.get("end_date"))

    next_bar = get_next_ohlcv_bar(
        symbol=session["symbol"],
        interval=session["interval"],
        after_time=session.get("last_bar_time"),
        start_date=state.get("start_date"),
        end_date=state.get("end_date"),
    )

    if next_bar is None:
        now = _now()
        if _runner_guardrail_breached(session):
            _mark_runner_failed_locked(paper_session_id, _runner_guardrail_breach_reason(session))
            return _ensure_session_defaults(_require_paper_session(paper_session_id)), "guardrail_breached"

        if _has_open_position(session):
            close_price = _runner_window_close_price(session, state)
            session = _force_close_open_position(
                paper_session_id,
                price=close_price,
                filled_at=session.get("last_bar_time") or now,
                actor="paper-runner",
                note="Historical runner force-closed the open position at the window end.",
                sync_candidate=False,
            )

        previous_mode = state.get("mode")
        parity_check = _build_runner_parity_check(session, now=now)
        state["mode"] = "completed"
        state["last_error"] = None
        state["parity_check"] = parity_check
        state["updated_at"] = now
        session["runner_state"] = state
        if keep_running and session["status"] == PaperSessionStatus.RUNNING.value:
            session["status"] = PaperSessionStatus.PAUSED.value
        session["last_event_at"] = now
        session["updated_at"] = now
        _save_paper_session_any(session)

        if previous_mode != "completed":
            _append_paper_event_any(
                _make_paper_event(
                    paper_session_id=paper_session_id,
                    candidate_id=session["candidate_id"],
                    event_type="runner_completed",
                    actor="paper-runner" if keep_running else actor,
                    summary="Historical runner reached the end of the selected candle window.",
                    created_at=now,
                    payload={
                        "start_date": state.get("start_date"),
                        "end_date": state.get("end_date"),
                        "bars_processed": state.get("bars_processed"),
                        "parity_check": parity_check,
                    },
                )
            )
            if keep_running:
                candidate = _require_candidate(session["candidate_id"])
                _sync_candidate_paper_session(
                    candidate,
                    paper_session_id,
                    now,
                    session_status=session["status"],
                )
                _append_candidate_session_audit(
                    candidate,
                    actor="paper-runner",
                    summary="Historical runner finished the candle window and paused the session.",
                    created_at=now,
                )
        refreshed = _ensure_session_defaults(_require_paper_session(paper_session_id))
        if _runner_guardrail_breached(refreshed):
            _mark_runner_failed_locked(paper_session_id, _runner_guardrail_breach_reason(refreshed))
            return _ensure_session_defaults(_require_paper_session(paper_session_id)), "guardrail_breached"
        return refreshed, "window_exhausted"

    bar_time = _normalize_timestamp(next_bar["time"])
    close_price = round(float(next_bar["close"]), 4)
    signal_history = _get_signal_history(session, state)
    session = advance_paper_session_bar(
        paper_session_id,
        _normalize_bar(next_bar),
        actor=actor,
        sync_candidate=False,
    )
    signal_history.append(_normalize_bar(next_bar))
    _set_signal_history(session["paper_session_id"], signal_history)
    signal = _compute_strategy_signal(session, signal_history)
    actions, action_label = _plan_signal_actions(session, signal)

    for action in actions:
        execute_paper_session_action(
            paper_session_id,
            action=_runner_execution_action(action),
            price=None,
            filled_at=bar_time,
            actor=actor,
            note=_runner_note_for_action(action, signal),
            sync_candidate=False,
        )
        session = _ensure_session_defaults(_require_paper_session(paper_session_id))

    if not actions:
        now = _now()
        session["last_bar_time"] = bar_time
        session["last_event_at"] = now
        session["updated_at"] = now
        _save_paper_session_any(session)

    state = _ensure_runner_state(session.get("runner_state"))
    state["mode"] = "running" if keep_running else "paused"
    state["bars_processed"] = int(state.get("bars_processed") or 0) + 1
    state["last_candle_time"] = bar_time
    state["last_price"] = close_price
    state["last_signal"] = signal
    state["last_signal_action"] = action_label
    state["last_signal_reason"] = _signal_reason(signal)
    state["last_error"] = None
    state["updated_at"] = _now()

    session["runner_state"] = state
    if keep_running:
        session["status"] = PaperSessionStatus.RUNNING.value
    session["last_event_at"] = state["updated_at"]
    session["updated_at"] = state["updated_at"]
    _save_paper_session_any(session)

    if _runner_guardrail_breached(session):
        _mark_runner_failed_locked(paper_session_id, _runner_guardrail_breach_reason(session))
        return _ensure_session_defaults(_require_paper_session(paper_session_id)), "guardrail_breached"

    payload = {
        "bar_time": bar_time,
        "close_price": close_price,
        "synthetic_quote": session.get("last_quote"),
        "signal": signal,
        "signal_action": action_label,
        "executed_actions": actions,
        "auto_marked": "mark" in actions,
        "bars_processed": state["bars_processed"],
    }
    if not keep_running:
        _append_paper_event_any(
            _make_paper_event(
                paper_session_id=paper_session_id,
                candidate_id=session["candidate_id"],
                event_type="runner_bar_advanced",
                actor=actor,
                summary="Advanced one historical candle in manual step mode.",
                created_at=state["updated_at"],
                payload=payload,
            )
        )
    return _ensure_session_defaults(_require_paper_session(paper_session_id)), "stepped"


def _mark_runner_failed_locked(paper_session_id: str, message: str) -> None:
    session = _ensure_session_defaults(_require_paper_session(paper_session_id))
    now = _now()
    state = _ensure_runner_state(session.get("runner_state"))
    state["mode"] = "failed"
    state["last_error"] = message
    state["updated_at"] = now
    session["runner_state"] = state
    session["status"] = PaperSessionStatus.FAILED.value
    session["last_event_at"] = now
    session["updated_at"] = now
    _save_paper_session_any(session)

    _append_paper_event_any(
        _make_paper_event(
            paper_session_id=paper_session_id,
            candidate_id=session["candidate_id"],
            event_type="runner_failed",
            actor="paper-runner",
            summary=f"Historical runner failed: {message}",
            created_at=now,
            payload={"error": message},
        )
    )

    candidate = _require_candidate(session["candidate_id"])
    _sync_candidate_paper_session(
        candidate,
        paper_session_id,
        now,
        session_status=session["status"],
    )
    _append_candidate_session_audit(
        candidate,
        actor="paper-runner",
        summary=f"Historical runner failed: {message}",
        created_at=now,
    )


def _runner_guardrail_breached(session: dict) -> bool:
    guardrail_state = session.get("guardrail_state") or {}
    return bool(guardrail_state.get("daily_loss_breached") or guardrail_state.get("drawdown_breached"))


def _runner_guardrail_breach_reason(session: dict) -> str:
    guardrail_state = session.get("guardrail_state") or {}
    reasons: list[str] = []
    if guardrail_state.get("daily_loss_breached"):
        reasons.append("daily loss")
    if guardrail_state.get("drawdown_breached"):
        reasons.append("drawdown")
    if not reasons:
        reasons.append("guardrail")
    return f"Historical runner stopped on {', '.join(reasons)} breach."


def _runner_window_close_price(session: dict, state: dict) -> float:
    last_price = state.get("last_price")
    if last_price is not None:
        return round(float(last_price), 4)

    last_quote = session.get("last_quote") or {}
    if last_quote.get("reference") is not None:
        return round(float(last_quote["reference"]), 4)

    current_position = session.get("current_position") or {}
    if current_position.get("mark_price") is not None:
        return round(float(current_position["mark_price"]), 4)

    if current_position.get("entry_price") is not None:
        return round(float(current_position["entry_price"]), 4)

    raise ValueError("Historical runner needs a final price to close the open position.")


def _spawn_runner_thread(paper_session_id: str) -> None:
    with _registry_lock:
        existing = _runner_handles.get(paper_session_id)
        if existing and existing.thread.is_alive():
            return

        stop_event = Event()
        thread = Thread(
            target=_runner_loop,
            args=(paper_session_id, stop_event),
            daemon=True,
            name=f"paper-runner-{paper_session_id[:8]}",
        )
        _runner_handles[paper_session_id] = _RunnerHandle(stop_event=stop_event, thread=thread)
        thread.start()


def _stop_runner_thread(paper_session_id: str) -> None:
    handle: _RunnerHandle | None = None
    with _registry_lock:
        handle = _runner_handles.pop(paper_session_id, None)

    if handle is None:
        return

    handle.stop_event.set()
    if handle.thread.is_alive():
        handle.thread.join(timeout=2.0)


def _clear_runner_handle(paper_session_id: str, stop_event: Event) -> None:
    with _registry_lock:
        handle = _runner_handles.get(paper_session_id)
        if handle and handle.stop_event is stop_event:
            _runner_handles.pop(paper_session_id, None)


def _runner_thread_alive(paper_session_id: str) -> bool:
    with _registry_lock:
        handle = _runner_handles.get(paper_session_id)
        return bool(handle and handle.thread.is_alive())


def _session_lock(paper_session_id: str) -> Lock:
    with _registry_lock:
        lock = _session_locks.get(paper_session_id)
        if lock is None:
            lock = Lock()
            _session_locks[paper_session_id] = lock
        return lock


def _reset_signal_history(paper_session_id: str) -> None:
    with _registry_lock:
        _signal_bar_history.pop(paper_session_id, None)


def _set_signal_history(paper_session_id: str, bars: list[dict[str, Any]]) -> None:
    with _registry_lock:
        _signal_bar_history[paper_session_id] = bars


def _get_signal_history(session: dict, state: dict) -> list[dict[str, Any]]:
    paper_session_id = session["paper_session_id"]
    with _registry_lock:
        existing = _signal_bar_history.get(paper_session_id)
    if existing is not None:
        return [*existing]

    if not session.get("last_bar_time"):
        return []

    history_df = get_ohlcv(
        symbol=session["symbol"],
        interval=session["interval"],
        start_date=state.get("start_date"),
        end_date=session["last_bar_time"],
    )
    if history_df.empty:
        return []

    bars: list[dict[str, Any]] = []
    for ts, row in history_df.iterrows():
        bars.append(
            {
                "time": ts.isoformat() if hasattr(ts, "isoformat") else str(ts),
                "open": float(row["open"]),
                "high": float(row["high"]),
                "low": float(row["low"]),
                "close": float(row["close"]),
                "volume": float(row["volume"]),
            }
        )
    _set_signal_history(paper_session_id, bars)
    return bars


def _normalize_bar(bar: dict[str, Any]) -> dict[str, Any]:
    return {
        "time": _normalize_timestamp(str(bar["time"])),
        "open": round(float(bar["open"]), 6),
        "high": round(float(bar["high"]), 6),
        "low": round(float(bar["low"]), 6),
        "close": round(float(bar["close"]), 6),
        "volume": float(bar["volume"]),
    }


def _compute_strategy_signal(session: dict, bars: list[dict[str, Any]]) -> int:
    if not bars:
        return 0

    df = pd.DataFrame.from_records(bars)
    df["ts"] = pd.to_datetime(df["time"], utc=True, errors="coerce")
    df = df.dropna(subset=["ts"]).set_index("ts")
    if df.empty:
        return 0

    for column in ["open", "high", "low", "close", "volume"]:
        df[column] = df[column].astype(float)

    strategy_type = str(session.get("strategy_type") or "").strip()
    strategy_params = dict(session.get("strategy_params") or {})
    if not strategy_type:
        return 0

    enriched = add_all_indicators(df, strategy_params, strategy_type=strategy_type)
    signaled = generate_signals(enriched, strategy_type, strategy_params)
    signal_value = signaled.iloc[-1].get("signal", 0)
    try:
        return int(signal_value)
    except (TypeError, ValueError):
        return 0


def _plan_signal_actions(session: dict, signal: int) -> tuple[list[str], str]:
    if signal not in {-1, 0, 1}:
        signal = 0

    position = session.get("current_position") or {}
    side = position.get("side")

    if signal == 1:
        if side == "sell":
            return ["exit", "buy"], "flip_to_buy"
        if side == "buy":
            return ["mark"], "hold_long"
        return ["buy"], "open_long"

    if signal == -1:
        if side == "buy":
            return ["exit", "sell"], "flip_to_sell"
        if side == "sell":
            return ["mark"], "hold_short"
        return ["sell"], "open_short"

    if side in {"buy", "sell"}:
        return ["mark"], "mark_open_position"
    return [], "flat_no_signal"


def _signal_reason(signal: int) -> str:
    if signal == 1:
        return "Latest strategy signal crossed bullish (+1)."
    if signal == -1:
        return "Latest strategy signal crossed bearish (-1)."
    return "Latest strategy signal is flat (0)."


def _runner_note_for_action(action: str, signal: int) -> str:
    if action == "buy":
        return f"Runner opened long from strategy signal {signal:+d}."
    if action == "sell":
        return f"Runner opened short from strategy signal {signal:+d}."
    if action == "exit":
        return f"Runner exited on strategy signal flip {signal:+d}."
    return "Runner marked the open position at bar close."


def _runner_execution_action(action: str) -> str:
    if action == "buy":
        return "lift_ask"
    if action == "sell":
        return "hit_bid"
    if action == "exit":
        return "flatten"
    return action


def _build_runner_parity_check(session: dict, *, now: str) -> dict:
    candidate = _require_candidate(session["candidate_id"])
    backtest_id = candidate.get("backtest_id")
    if not backtest_id:
        return {"status": "missing_backtest", "checked_at": now}

    try:
        reference = _load_backtest_any(str(backtest_id))
    except Exception as exc:
        return {
            "status": "parity_unavailable",
            "backtest_id": backtest_id,
            "checked_at": now,
            "error": str(exc),
        }
    if reference is None:
        return {
            "status": "backtest_not_found",
            "backtest_id": backtest_id,
            "checked_at": now,
        }

    session_metrics = dict((session.get("metrics_snapshot") or {}))
    reference_metrics = dict((reference.get("metrics") or {}))
    session_trade_count = len(session.get("trade_log") or [])
    reference_trade_count = len(reference.get("trades") or [])
    total_pnl_delta = round(
        float(session_metrics.get("total_pnl") or 0.0) - float(reference_metrics.get("total_pnl") or 0.0),
        4,
    )
    max_drawdown_delta = round(
        float(session_metrics.get("max_drawdown") or 0.0) - float(reference_metrics.get("max_drawdown") or 0.0),
        6,
    )
    win_rate_delta = round(
        float(session_metrics.get("win_rate") or 0.0) - float(reference_metrics.get("win_rate") or 0.0),
        6,
    )
    parity_passed = (
        session_trade_count == reference_trade_count
        and abs(total_pnl_delta) <= 0.01
        and abs(max_drawdown_delta) <= 0.0001
        and abs(win_rate_delta) <= 0.0001
    )
    return {
        "status": "ok",
        "checked_at": now,
        "backtest_id": backtest_id,
        "passed": parity_passed,
        "trade_count_delta": session_trade_count - reference_trade_count,
        "total_pnl_delta": total_pnl_delta,
        "max_drawdown_delta": max_drawdown_delta,
        "win_rate_delta": win_rate_delta,
    }


def _load_backtest_any(backtest_id: str) -> dict | None:
    if db_configured():
        return get_backtest_db(backtest_id)
    return get_backtest_mem(backtest_id)


def _ensure_runner_state(state: dict | None) -> dict:
    current = dict(state or {})
    current.setdefault("mode", "idle")
    current.setdefault("bars_processed", 0)
    current.setdefault("poll_interval_ms", DEFAULT_RUNNER_POLL_INTERVAL_MS)
    current.setdefault("start_date", None)
    current.setdefault("end_date", None)
    current.setdefault("last_candle_time", None)
    current.setdefault("last_price", None)
    current.setdefault("last_signal", 0)
    current.setdefault("last_signal_action", None)
    current.setdefault("last_signal_reason", None)
    current.setdefault("auto_trade_enabled", True)
    current.setdefault("parity_check", {})
    current.setdefault("last_error", None)
    current.setdefault("updated_at", None)
    return current


def _apply_default_window(session: dict, state: dict) -> dict:
    if state.get("start_date") and state.get("end_date"):
        return state

    candidate = _require_candidate(session["candidate_id"])
    snapshot = candidate.get("experiment_snapshot") or {}
    if not state.get("start_date") and snapshot.get("start_date"):
        state["start_date"] = _normalize_optional_timestamp(snapshot.get("start_date"))
    if not state.get("end_date") and snapshot.get("end_date"):
        state["end_date"] = _normalize_optional_timestamp(snapshot.get("end_date"))
    return state


def _require_db_runner_support() -> None:
    if not db_configured():
        raise RuntimeError("Historical runner needs a configured TimescaleDB connection.")


def _validate_runner_session_status(session: dict, *, allow_running: bool) -> None:
    disallowed = {
        PaperSessionStatus.DRAFT.value,
        PaperSessionStatus.STOPPED.value,
        PaperSessionStatus.FAILED.value,
    }
    if not allow_running:
        disallowed.add(PaperSessionStatus.RUNNING.value)

    if session["status"] in disallowed:
        raise ValueError(
            f"Paper session is '{session['status']}'. Move it to ready or paused before using the runner."
        )


def _validate_poll_interval(value: int) -> int:
    if value < MIN_RUNNER_POLL_INTERVAL_MS or value > MAX_RUNNER_POLL_INTERVAL_MS:
        raise ValueError(
            f"Runner poll interval must stay between {MIN_RUNNER_POLL_INTERVAL_MS} and {MAX_RUNNER_POLL_INTERVAL_MS} ms."
        )
    return value


def _normalize_optional_timestamp(value: str | None) -> str | None:
    if value is None:
        return None
    cleaned = value.strip()
    if not cleaned:
        return None
    return _normalize_timestamp(cleaned)


def _validate_range(start_date: str | None, end_date: str | None) -> None:
    if not start_date or not end_date:
        return
    start_dt = datetime.fromisoformat(_normalize_timestamp(start_date).replace("Z", "+00:00"))
    end_dt = datetime.fromisoformat(_normalize_timestamp(end_date).replace("Z", "+00:00"))
    if start_dt > end_dt:
        raise ValueError("Runner start_date must be earlier than end_date.")
