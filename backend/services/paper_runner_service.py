from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime
from threading import Event, Lock, Thread

from schemas import PaperSessionStatus
from services.db import db_configured, get_next_ohlcv_bar
from services.paper_session_service import (
    _append_candidate_session_audit,
    _append_paper_event_any,
    _ensure_session_defaults,
    _has_open_position,
    _make_paper_event,
    _now,
    _normalize_timestamp,
    _require_candidate,
    _require_paper_session,
    _save_paper_session_any,
    _sync_candidate_paper_session,
    execute_paper_session_action,
)

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
        return _ensure_session_defaults(_require_paper_session(paper_session_id))


def stop_all_historical_runners() -> None:
    """Stop every in-process runner thread, usually on app shutdown."""
    with _registry_lock:
        handles = list(_runner_handles.items())
        _runner_handles.clear()

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
        previous_mode = state.get("mode")
        state["mode"] = "completed"
        state["last_error"] = None
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
        return _ensure_session_defaults(_require_paper_session(paper_session_id)), "window_exhausted"

    bar_time = _normalize_timestamp(next_bar["time"])
    close_price = round(float(next_bar["close"]), 4)
    auto_marked = False

    if _has_open_position(session):
        execute_paper_session_action(
            paper_session_id,
            action="mark",
            price=close_price,
            filled_at=bar_time,
            actor=actor,
            note="Runner auto-marked the open position at bar close.",
            sync_candidate=False,
        )
        auto_marked = True
        session = _ensure_session_defaults(_require_paper_session(paper_session_id))
    else:
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
    state["last_error"] = None
    state["updated_at"] = _now()

    session["runner_state"] = state
    if keep_running:
        session["status"] = PaperSessionStatus.RUNNING.value
    session["last_event_at"] = state["updated_at"]
    session["updated_at"] = state["updated_at"]
    _save_paper_session_any(session)

    payload = {
        "bar_time": bar_time,
        "close_price": close_price,
        "auto_marked": auto_marked,
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


def _ensure_runner_state(state: dict | None) -> dict:
    current = dict(state or {})
    current.setdefault("mode", "idle")
    current.setdefault("bars_processed", 0)
    current.setdefault("poll_interval_ms", DEFAULT_RUNNER_POLL_INTERVAL_MS)
    current.setdefault("start_date", None)
    current.setdefault("end_date", None)
    current.setdefault("last_candle_time", None)
    current.setdefault("last_price", None)
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
