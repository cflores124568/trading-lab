from __future__ import annotations

from contextlib import contextmanager
from dataclasses import dataclass
from datetime import datetime
from threading import Event, Lock, Thread
from typing import Any

import pandas as pd
from services import research_forward_qualification_repo
from services.backtest_repo import _ensure_backtests_schema
from services.backtest_repo import get_backtest as get_backtest_db
from services.backtest_store import get_backtest as get_backtest_mem
from services.candidate_store import candidate_transaction
from schemas import (
    CandidateLifecycleStatus, PaperDecisionStatus, PaperPolicyDecision, PaperPolicyMode,
    PaperSessionExecutionRequest, PaperSessionStatus,
)
from services.data_loader import normalise_interval
from services.db import _conn, db_configured, get_next_ohlcv_bar, get_ohlcv
from services.indicators import add_all_indicators
from services.paper_session_service import (
    PAPER_SESSION_TRANSITIONS,
    _db_required as _paper_storage_uses_db,
    _append_candidate_session_audit,
    _append_paper_event_any,
    _force_close_open_position,
    _ensure_session_defaults,
    _has_open_position,
    _make_paper_event,
    _get_policy_decision_resolution_any,
    _now,
    _normalize_timestamp,
    _require_candidate,
    _require_paper_session,
    _save_paper_session_any,
    _policy_event_id,
    _policy_decision_has_execution_any,
    _sync_candidate_paper_session,
    advance_paper_session_bar,
    execute_paper_session_action,
)
from services.paper_policy_service import (
    build_market_observation,
    decide_with_deterministic_policy,
    decision_requires_approval,
    normalize_policy_mode,
    plan_signal_actions,
    signal_reason,
    update_shadow_scorecard,
)
from services.paper_risk_service import assess_pretrade_risk
from services.paper_runner_lease_repo import (
    get_runner_lease,
    revoke_runner_lease,
)
from services.paper_session_repo import (
    PaperSessionWriteConflict,
    RunnerLeaseLost,
    guarded_runner_transaction,
    locked_paper_session_transaction,
)
from services.paper_session_store import paper_session_transaction
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


def _persist_control_transition(
    session: dict, *, actor: str, event_type: str, summary: str,
    payload: dict, revoke_lease: bool = True,
) -> dict:
    """Publish one control command's state, lease change, event, and projection."""
    now = _now()
    session["runner_state"]["updated_at"] = now
    session["last_event_at"] = now
    session["updated_at"] = now
    _save_paper_session_any(session)
    if revoke_lease:
        _revoke_durable_runner_lease(session["paper_session_id"])
    _append_paper_event_any(_make_paper_event(
        paper_session_id=session["paper_session_id"], candidate_id=session["candidate_id"],
        event_type=event_type, actor=actor, summary=summary, created_at=now, payload=payload,
    ))
    candidate = _require_candidate(session["candidate_id"])
    _sync_candidate_paper_session(
        candidate, session["paper_session_id"], now, session_status=session["status"],
    )
    _append_candidate_session_audit(candidate, actor=actor, summary=summary, created_at=now)
    return _ensure_session_defaults(_require_paper_session(session["paper_session_id"]))


def _validate_status_transition(session: dict, next_status: str) -> None:
    previous = session["status"]
    if next_status not in PAPER_SESSION_TRANSITIONS or (
        next_status != previous and next_status not in PAPER_SESSION_TRANSITIONS.get(previous, set())
    ):
        raise ValueError(f"Can't move paper session from '{previous}' to '{next_status}'.")


def _set_inactive_status(session: dict, status: str, *, summary: str | None = None) -> None:
    state = _ensure_runner_state(session.get("runner_state"))
    if status != "paused" or state.get("mode") not in {"completed", "failed"}:
        if status == "failed":
            state["mode"] = "failed"
        elif status in {"draft", "ready"}:
            state["mode"] = "idle"
        else:
            state["mode"] = "paused"
    if status == "ready":
        state["last_error"] = None
    elif status == "failed":
        state["last_error"] = summary or state.get("last_error") or "Marked failed by the operator."
    session["status"] = status
    session["runner_state"] = state


def _prepare_runner_start(
    session: dict, *, start_date: str | None = None, end_date: str | None = None,
    poll_interval_ms: int | None = None, reset_cursor: bool = False,
    policy_mode: str | PaperPolicyMode | None = None,
) -> dict:
    candidate = _require_unrejected_candidate(session)
    _validate_runner_session_status(session)
    state = _ensure_runner_state(session.get("runner_state"))
    state = _apply_default_window(session, state)
    if state.get("kill_switch_engaged"):
        raise ValueError("Reset the emergency kill switch before starting the runner.")
    if state.get("pending_decision"):
        raise ValueError("Resolve the pending policy decision before restarting the runner.")
    _validate_forward_qualification_mode(
        state, policy_mode, paper_session_id=session["paper_session_id"], candidate=candidate,
    )
    poll = _validate_poll_interval(
        poll_interval_ms if poll_interval_ms is not None else int(state.get("poll_interval_ms") or DEFAULT_RUNNER_POLL_INTERVAL_MS)
    )
    start_ts = _normalize_optional_timestamp(start_date)
    end_ts = _normalize_optional_timestamp(end_date)
    if policy_mode is not None:
        state["policy_mode"] = normalize_policy_mode(policy_mode).value
    if start_ts is not None:
        state["start_date"] = start_ts
    if end_ts is not None:
        state["end_date"] = end_ts
    _validate_range(state.get("start_date"), state.get("end_date"))
    if reset_cursor:
        session["last_bar_time"] = None
        state.update(
            bars_processed=0, last_candle_time=None, last_price=None, last_signal=0,
            last_signal_action=None, last_signal_reason=None, parity_check={},
            last_decision=None, pending_decision=None, shadow_scorecard={},
        )
    state.update(
        mode="running", poll_interval_ms=poll, last_error=None,
        execution_backend="durable_worker", worker_requested_at=_now(),
    )
    session["runner_state"] = state
    session["status"] = PaperSessionStatus.RUNNING.value
    return {
        "start_date": state.get("start_date"), "end_date": state.get("end_date"),
        "poll_interval_ms": poll, "reset_cursor": reset_cursor,
        "policy_mode": state.get("policy_mode"),
    }


def start_historical_runner(
    paper_session_id: str, *, actor: str = "local-user", start_date: str | None = None,
    end_date: str | None = None, poll_interval_ms: int = DEFAULT_RUNNER_POLL_INTERVAL_MS,
    reset_cursor: bool = False, policy_mode: str | PaperPolicyMode | None = None,
) -> dict:
    """Atomically queue runnable intent; only the leased worker advances bars."""
    _require_db_runner_support()
    with _session_lock(paper_session_id):
        with _paper_control_transaction(paper_session_id):
            session = _ensure_session_defaults(_require_paper_session(paper_session_id))
            payload = _prepare_runner_start(
                session, start_date=start_date, end_date=end_date,
                poll_interval_ms=poll_interval_ms, reset_cursor=reset_cursor, policy_mode=policy_mode,
            )
            result = _persist_control_transition(
                session, actor=actor, event_type="runner_started",
                summary="Queued the historical paper runner for durable execution.", payload=payload,
            )
        if reset_cursor:
            _reset_signal_history(paper_session_id)
        return result


def transition_paper_session_status(
    paper_session_id: str, status: str, *, actor: str = "local-user", summary: str | None = None,
) -> dict:
    """Use the same start/stop guards and transaction for status-button controls."""
    next_status = status.strip()
    if next_status == "running":
        _require_db_runner_support()
    else:
        _stop_runner_thread(paper_session_id)
    with _session_lock(paper_session_id), _paper_control_transaction(paper_session_id):
        session = _ensure_session_defaults(_require_paper_session(paper_session_id))
        previous = session["status"]
        _validate_status_transition(session, next_status)
        if next_status == "running":
            _prepare_runner_start(session)
        else:
            if next_status == "ready":
                _require_unrejected_candidate(session)
            _set_inactive_status(session, next_status, summary=summary)
        return _persist_control_transition(
            session, actor=actor, event_type="status_changed",
            summary=summary or f"Moved paper session from `{previous}` to `{next_status}`.",
            payload={"from": previous, "to": next_status},
        )


def _stop_session_for_candidate_rejection(session: dict, *, actor: str) -> None:
    """Stop the session while the caller holds the candidate and session locks."""
    previous_status = session["status"]
    if previous_status == "stopped" and session["runner_state"]["mode"] == "paused":
        _revoke_durable_runner_lease(session["paper_session_id"])
        return
    _set_inactive_status(session, PaperSessionStatus.STOPPED.value)
    _persist_control_transition(
        session,
        actor=actor,
        event_type="status_changed",
        summary="Stopped the paper session because its candidate was rejected.",
        payload={"from": previous_status, "to": "stopped", "reason": "candidate_rejected"},
    )


def _require_unrejected_candidate(session: dict) -> dict:
    candidate = _require_candidate(session["candidate_id"])
    if candidate.get("lifecycle_status") == CandidateLifecycleStatus.REJECTED.value:
        raise ValueError("This paper session belongs to a rejected candidate.")
    return candidate


def _forward_qualification(state: dict, paper_session_id: str | None) -> dict:
    if paper_session_id and _paper_storage_uses_db():
        forward = research_forward_qualification_repo.get_by_paper_session(paper_session_id)
        if forward is not None:
            return forward
    return state.get("forward_qualification") or {}


def _validate_forward_qualification_mode(
    state: dict,
    requested_mode: str | PaperPolicyMode | None,
    *,
    paper_session_id: str | None = None,
    candidate: dict | None = None,
) -> None:
    forward = _forward_qualification(state, paper_session_id)
    if not forward:
        snapshot = (candidate or {}).get("experiment_snapshot") or {}
        if snapshot.get("source_kind") == "alpha_lab":
            raise ValueError("Complete the forward qualification handoff before using the paper runner.")
        return
    status = forward.get("status")
    if status == "rejected":
        raise ValueError("Rejected forward qualifications cannot resume their paper runner.")
    if status != "collecting":
        return

    mode = normalize_policy_mode(requested_mode or state.get("policy_mode"))
    if mode == PaperPolicyMode.AUTONOMOUS_PAPER:
        raise ValueError("Forward qualification remains paper-only and cannot use autonomous-paper mode while collecting evidence.")
    if mode != PaperPolicyMode.APPROVAL_REQUIRED:
        return

    scorecard = dict(state.get("shadow_scorecard") or {})
    observations = int(scorecard.get("total_decisions") or 0)
    decisions = int(scorecard.get("actionable_decisions") or 0)
    if observations < int(forward.get("min_forward_observations") or 1):
        raise ValueError("Complete the minimum shadow observation count before approval-required paper mode.")
    if decisions < int(forward.get("min_forward_decisions") or 1):
        raise ValueError("Complete the minimum actionable shadow decision count before approval-required paper mode.")


def pause_historical_runner(
    paper_session_id: str, *, actor: str = "local-user", summary: str | None = None,
) -> dict:
    """Pause intent and revoke ownership together while retaining execution state."""
    _stop_runner_thread(paper_session_id)
    with _session_lock(paper_session_id), _paper_control_transaction(paper_session_id):
        session = _ensure_session_defaults(_require_paper_session(paper_session_id))
        _validate_status_transition(session, PaperSessionStatus.PAUSED.value)
        _set_inactive_status(session, PaperSessionStatus.PAUSED.value)
        state = session["runner_state"]
        return _persist_control_transition(
            session, actor=actor, event_type="runner_paused",
            summary=summary or "Paused the historical paper runner.",
            payload={"last_candle_time": state.get("last_candle_time"), "bars_processed": state.get("bars_processed")},
        )


def step_historical_runner(
    paper_session_id: str,
    *,
    actor: str = "local-user",
    steps: int = 1,
) -> dict:
    """Commit each manual bar before allowing the next control or bar."""
    _require_db_runner_support()
    if steps < 1 or steps > 500:
        raise ValueError("Runner step count must stay between 1 and 500.")

    if _paper_storage_uses_db():
        # End-of-window parity can read a backtest from inside the bar transaction.
        with _conn() as conn:
            _ensure_backtests_schema(conn)

    expected_version = None
    completed = 0
    for index in range(steps):
        with _session_lock(paper_session_id):
            try:
                with _paper_control_transaction(paper_session_id):
                    session = _require_paper_session(paper_session_id)
                    if expected_version is not None and session["_state_version"] != expected_version:
                        raise PaperSessionWriteConflict(
                            f"Paper session changed after {completed} bar(s) committed. Refresh before stepping again."
                        )
                    state = _validate_manual_step(session)
                    previous_status = session["status"]
                    previous_bars = int(state.get("bars_processed") or 0)
                    session, outcome = _advance_one_bar_locked(paper_session_id, actor=actor, keep_running=False)
                    state = session["runner_state"]
                    completed += int(state.get("bars_processed") or 0) - previous_bars
                    if outcome != "stepped" or index == steps - 1:
                        session = _persist_control_transition(
                            session,
                            actor=actor,
                            event_type="runner_step",
                            summary=f"Stepped the historical runner by {completed} bar(s).",
                            payload={
                                "requested_steps": steps,
                                "completed_steps": completed,
                                "last_candle_time": state.get("last_candle_time"),
                                "mode": state["mode"],
                            },
                            revoke_lease=False,
                        )
                    elif session["status"] != previous_status:
                        candidate = _require_candidate(session["candidate_id"])
                        _sync_candidate_paper_session(
                            candidate, paper_session_id, session["last_event_at"], session_status=session["status"],
                        )
            except Exception:
                _reset_signal_history(paper_session_id)
                raise
        expected_version = session.get("_state_version")
        if outcome != "stepped":
            break
    return session


def _validate_manual_step(session: dict) -> dict:
    state = _ensure_runner_state(session.get("runner_state"))
    # Older manual fills could leave a running label with idle runner intent.
    _validate_runner_session_status(session)
    session_id = session["paper_session_id"]
    if state["mode"] == "running" or _runner_thread_alive(session_id) or _runner_worker_active(session_id):
        raise ValueError("Pause the running historical worker before manual stepping.")
    if state["kill_switch_engaged"]:
        raise ValueError("Reset the emergency kill switch before stepping the runner.")
    if state.get("pending_decision"):
        raise ValueError("Resolve the pending policy decision before stepping the runner.")
    candidate = _require_unrejected_candidate(session)
    _validate_forward_qualification_mode(state, None, paper_session_id=session_id, candidate=candidate)
    return state


def execute_manual_paper_session_action(paper_session_id: str, request: PaperSessionExecutionRequest) -> dict:
    """Commit an operator fill, its event, and its candidate audit together."""
    with _session_lock(paper_session_id), _paper_control_transaction(paper_session_id):
        _require_unrejected_candidate(_require_paper_session(paper_session_id))
        return execute_paper_session_action(
            paper_session_id,
            action=request.action.value,
            price=request.price,
            stop_price=request.stop_price,
            target_price=request.target_price,
            quantity=request.quantity,
            filled_at=request.filled_at,
            actor=request.actor,
            note=request.note,
        )


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


def set_runner_kill_switch(
    paper_session_id: str, *, engaged: bool, actor: str = "local-user", reason: str | None = None,
) -> dict:
    """Change the emergency latch without publishing a partial pause or reset."""
    if engaged:
        _stop_runner_thread(paper_session_id)
    with _session_lock(paper_session_id), _paper_control_transaction(paper_session_id):
        session = _ensure_session_defaults(_require_paper_session(paper_session_id))
        state = _ensure_runner_state(session.get("runner_state"))
        was_engaged = bool(state.get("kill_switch_engaged"))
        state["kill_switch_engaged"] = bool(engaged)
        state["kill_switch_reason"] = reason.strip() if isinstance(reason, str) and reason.strip() else None
        session["runner_state"] = state
        revoke_lease = engaged or was_engaged or session["status"] != "running"
        if engaged or was_engaged or (session["status"] == "running" and state.get("mode") != "running"):
            target = "paused" if session["status"] == "running" else session["status"]
            _set_inactive_status(session, target)
            revoke_lease = True
        elif session["status"] != "running":
            _set_inactive_status(session, session["status"])
        summary = (state["kill_switch_reason"] or "Emergency kill switch engaged.") if engaged else "Emergency kill switch reset."
        return _persist_control_transition(
            session, actor=actor, event_type="kill_switch_engaged" if engaged else "kill_switch_reset",
            summary=summary, payload={"engaged": bool(engaged), "reason": state["kill_switch_reason"]},
            revoke_lease=revoke_lease,
        )


@contextmanager
def _paper_control_transaction(paper_session_id: str):
    if _paper_storage_uses_db():
        with locked_paper_session_transaction(paper_session_id):
            yield
    else:
        with paper_session_transaction(paper_session_id) as candidate_id:
            with candidate_transaction(candidate_id):
                yield


@contextmanager
def _policy_decision_transaction(paper_session_id: str):
    with _paper_control_transaction(paper_session_id):
        yield


def resolve_pending_policy_decision(
    paper_session_id: str,
    *,
    decision_id: str,
    approved: bool,
    actor: str = "local-user",
    note: str | None = None,
) -> dict:
    """Resolve a specific proposal once, atomically with its execution effects."""
    requested_id = decision_id.strip()
    if not requested_id:
        raise ValueError("A policy decision id is required for resolution.")
    _stop_runner_thread(paper_session_id)

    with _session_lock(paper_session_id), _policy_decision_transaction(paper_session_id):
        session = _ensure_session_defaults(_require_paper_session(paper_session_id))
        state = _ensure_runner_state(session.get("runner_state"))
        receipt = _get_policy_decision_resolution_any(paper_session_id, requested_id)
        if receipt is not None:
            if receipt["payload"]["approved"] != approved:
                raise PaperSessionWriteConflict("This policy decision already has a different resolution.")
            # A retry must leave any newer pending decision and runtime state alone.
            return session
        _require_unrejected_candidate(session)
        pending = state.get("pending_decision")
        if not pending:
            raise ValueError("This paper session has no pending policy decision.")
        if pending.get("decision_id") != requested_id:
            raise PaperSessionWriteConflict("The pending policy decision changed. Refresh before resolving it.")
        if _policy_decision_has_execution_any(paper_session_id, requested_id):
            raise PaperSessionWriteConflict(
                "This decision has execution records without a resolution receipt. Inspect the session before retrying."
            )

        decision = PaperPolicyDecision.model_validate(pending)
        if decision.paper_session_id != paper_session_id or decision.status != PaperDecisionStatus.PENDING_APPROVAL:
            raise ValueError("The requested policy decision is not awaiting approval for this session.")
        decision.resolved_by = actor

        if approved:
            if _runner_guardrail_breached(session):
                raise ValueError("The pending decision cannot execute while a hard guardrail is breached.")
            for index, action in enumerate(decision.actions):
                execute_paper_session_action(
                    paper_session_id,
                    action=_runner_execution_action(action),
                    price=None,
                    filled_at=decision.observed_at,
                    actor=actor,
                    note=note or f"Approved policy decision {decision.decision_id}.",
                    sync_candidate=False,
                    approved_decision_id=decision.decision_id,
                    approved_action_index=index,
                )
            decision.status = PaperDecisionStatus.EXECUTED
            summary = note or f"Approved and executed policy decision {decision.decision_id}."
        else:
            decision.status = PaperDecisionStatus.REJECTED
            summary = note or f"Rejected policy decision {decision.decision_id}."

        now = _now()
        decision.resolved_at = now
        session = _ensure_session_defaults(_require_paper_session(paper_session_id))
        state = _ensure_runner_state(session.get("runner_state"))
        state["pending_decision"] = None
        state["last_decision"] = decision.model_dump(mode="json")
        state["mode"] = "paused"
        state["updated_at"] = now
        session["runner_state"] = state
        session["status"] = PaperSessionStatus.PAUSED.value
        session["last_event_at"] = now
        session["updated_at"] = now
        _save_paper_session_any(session)
        _revoke_durable_runner_lease(paper_session_id)
        receipt = _make_paper_event(
            paper_session_id=paper_session_id,
            candidate_id=session["candidate_id"],
            event_type="policy_decision_resolved",
            actor=actor,
            summary=summary,
            created_at=now,
            payload={
                "decision": decision.model_dump(mode="json"),
                "approved": approved,
                "action_event_ids": [
                    _policy_event_id(paper_session_id, requested_id, f"action:{index}")
                    for index in range(len(decision.actions))
                ] if approved else [],
            },
        )
        receipt["paper_event_id"] = _policy_event_id(paper_session_id, requested_id, "resolution")
        _append_paper_event_any(receipt)

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
            summary=summary,
            created_at=now,
        )
        return _ensure_session_defaults(_require_paper_session(paper_session_id))


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


def advance_historical_runner_worker_once(
    paper_session_id: str,
    *,
    owner_id: str,
    lease_token: str,
) -> tuple[dict, str]:
    """Advance one bar only for the process holding the active durable lease."""
    lease = get_runner_lease(paper_session_id)
    if not lease or not lease.get("active"):
        raise RuntimeError("The paper runner lease is missing or expired.")
    if lease.get("owner_id") != owner_id or lease.get("lease_token") != lease_token:
        raise RuntimeError("The paper runner lease is owned by another worker.")

    with _session_lock(paper_session_id):
        session = _ensure_session_defaults(_require_paper_session(paper_session_id))
        state = _ensure_runner_state(session.get("runner_state"))
        if session.get("status") != PaperSessionStatus.RUNNING.value or state.get("mode") != "running":
            return session, "not_running"
        guard = None
        try:
            with guarded_runner_transaction(
                paper_session_id, owner_id=owner_id, lease_token=lease_token
            ) as guard:
                session = _ensure_session_defaults(_require_paper_session(paper_session_id))
                state = _ensure_runner_state(session.get("runner_state"))
                if session.get("status") != PaperSessionStatus.RUNNING.value or state.get("mode") != "running":
                    return session, "not_running"
                if _forward_qualification(state, paper_session_id).get("status") == "rejected":
                    return session, "not_running"
                return _advance_one_bar_locked(
                    paper_session_id,
                    actor="paper-runner",
                    keep_running=True,
                )
        except (PaperSessionWriteConflict, RunnerLeaseLost):
            _reset_signal_history(paper_session_id)
            raise
        except Exception as exc:
            _reset_signal_history(paper_session_id)
            if guard is None:
                raise
            # The failed bar was rolled back. A failure marker is another
            # fenced write and must not overwrite a newer control or owner.
            with guarded_runner_transaction(
                paper_session_id,
                owner_id=owner_id,
                lease_token=lease_token,
                expected_version=guard.starting_version,
            ):
                _mark_runner_failed_locked(paper_session_id, str(exc))
                return _ensure_session_defaults(_require_paper_session(paper_session_id)), "failed"


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
        interval=normalise_interval(session["interval"]),
        after_time=session.get("last_bar_time"),
        start_date=state.get("start_date"),
        end_date=state.get("end_date"),
    )

    if next_bar is None:
        if _runner_guardrail_breached(session):
            _mark_runner_failed_locked(paper_session_id, _runner_guardrail_breach_reason(session))
            return _ensure_session_defaults(_require_paper_session(paper_session_id)), "guardrail_breached"

        if _has_open_position(session):
            close_price = _runner_window_close_price(session, state)
            session = _force_close_open_position(
                paper_session_id,
                price=close_price,
                filled_at=session.get("last_bar_time") or _now(),
                actor="paper-runner",
                note="Historical runner force-closed the open position at the window end.",
                sync_candidate=False,
            )

        now = _now()
        previous_mode = state.get("mode")
        parity_check = _build_runner_parity_check(session, now=now)
        state["mode"] = "completed"
        state["last_error"] = None
        state["parity_check"] = parity_check
        state["updated_at"] = now
        session["runner_state"] = state
        if not keep_running or session["status"] == PaperSessionStatus.RUNNING.value:
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
    policy_mode = normalize_policy_mode(state.get("policy_mode"))
    observation = build_market_observation(
        session,
        _normalize_bar(next_bar),
        signal=signal,
        bar_index=int(state.get("bars_processed") or 0),
    )
    decision = decide_with_deterministic_policy(
        observation,
        policy_mode=policy_mode,
        created_at=_now(),
    )
    actions = list(decision.actions)
    action_label = decision.action_label
    approval_pending = policy_mode == PaperPolicyMode.APPROVAL_REQUIRED and decision_requires_approval(decision)
    actions_to_execute = actions
    risk_blocked = False

    if policy_mode == PaperPolicyMode.SHADOW:
        actions_to_execute = []
        decision.status = PaperDecisionStatus.SHADOWED
    elif approval_pending:
        actions_to_execute = []
        decision.status = PaperDecisionStatus.PENDING_APPROVAL
    elif policy_mode == PaperPolicyMode.AUTONOMOUS_PAPER and actions:
        decision.risk_assessment = assess_pretrade_risk(session, decision, checked_at=_now())
        if decision.risk_assessment.status == "blocked":
            actions_to_execute = []
            decision.status = PaperDecisionStatus.BLOCKED
            risk_blocked = True
        else:
            decision.status = PaperDecisionStatus.EXECUTED
    elif actions:
        decision.status = PaperDecisionStatus.EXECUTED
    else:
        decision.status = PaperDecisionStatus.NO_ACTION

    for action in actions_to_execute:
        execute_paper_session_action(
            paper_session_id,
            action=_runner_execution_action(action),
            price=None,
            filled_at=bar_time,
            actor=actor,
            note=_runner_note_for_action(action, signal),
            sync_candidate=False,
            manual_step=not keep_running,
        )
        session = _ensure_session_defaults(_require_paper_session(paper_session_id))

    if not actions_to_execute:
        now = _now()
        session["last_bar_time"] = bar_time
        session["last_event_at"] = now
        session["updated_at"] = now
        _save_paper_session_any(session)

    if policy_mode == PaperPolicyMode.SHADOW:
        state["shadow_scorecard"] = update_shadow_scorecard(
            state.get("shadow_scorecard"),
            decision,
        ).model_dump(mode="json")
    state["mode"] = "paused" if approval_pending or risk_blocked else ("running" if keep_running else "paused")
    state["bars_processed"] = int(state.get("bars_processed") or 0) + 1
    state["last_candle_time"] = bar_time
    state["last_price"] = close_price
    state["last_signal"] = signal
    state["last_signal_action"] = action_label
    state["last_signal_reason"] = signal_reason(signal)
    state["policy_mode"] = policy_mode.value
    state["last_decision"] = decision.model_dump(mode="json")
    state["pending_decision"] = decision.model_dump(mode="json") if approval_pending else None
    state["last_error"] = None
    state["updated_at"] = _now()

    session["runner_state"] = state
    if not keep_running or approval_pending or risk_blocked:
        session["status"] = PaperSessionStatus.PAUSED.value
    else:
        session["status"] = PaperSessionStatus.RUNNING.value
    session["last_event_at"] = state["updated_at"]
    session["updated_at"] = state["updated_at"]
    _save_paper_session_any(session)
    _append_policy_decision_event(
        session,
        decision,
        actor=actor,
        created_at=state["updated_at"],
    )
    if risk_blocked:
        _append_risk_blocked_event(session, decision, actor=actor, created_at=state["updated_at"])

    if _runner_guardrail_breached(session):
        _mark_runner_failed_locked(paper_session_id, _runner_guardrail_breach_reason(session))
        return _ensure_session_defaults(_require_paper_session(paper_session_id)), "guardrail_breached"

    if approval_pending:
        candidate = _require_candidate(session["candidate_id"])
        _sync_candidate_paper_session(
            candidate,
            paper_session_id,
            state["updated_at"],
            session_status=session["status"],
        )
        _append_candidate_session_audit(
            candidate,
            actor=actor,
            summary=f"Paused for approval of policy decision {decision.decision_id}.",
            created_at=state["updated_at"],
        )
        return _ensure_session_defaults(_require_paper_session(paper_session_id)), "approval_required"

    if risk_blocked:
        candidate = _require_candidate(session["candidate_id"])
        _sync_candidate_paper_session(
            candidate,
            paper_session_id,
            state["updated_at"],
            session_status=session["status"],
        )
        violations = decision.risk_assessment.violations if decision.risk_assessment else []
        _append_candidate_session_audit(
            candidate,
            actor=actor,
            summary=f"Risk blocked policy decision {decision.decision_id}: {'; '.join(violations)}",
            created_at=state["updated_at"],
        )
        return _ensure_session_defaults(_require_paper_session(paper_session_id)), "risk_blocked"

    payload = {
        "bar_time": bar_time,
        "close_price": close_price,
        "synthetic_quote": session.get("last_quote"),
        "signal": signal,
        "signal_action": action_label,
        "policy_mode": policy_mode.value,
        "decision_id": decision.decision_id,
        "proposed_actions": actions,
        "executed_actions": actions_to_execute,
        "auto_marked": "mark" in actions_to_execute,
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


def _append_policy_decision_event(
    session: dict,
    decision: PaperPolicyDecision,
    *,
    actor: str,
    created_at: str,
) -> None:
    mode = decision.policy_mode.value
    if decision.status == PaperDecisionStatus.PENDING_APPROVAL:
        summary = f"Policy proposed {decision.action_label} and paused for approval."
    elif decision.status == PaperDecisionStatus.SHADOWED:
        summary = f"Shadow policy observed {decision.action_label} without execution."
    elif decision.status == PaperDecisionStatus.EXECUTED:
        summary = f"Policy executed {decision.action_label}."
    elif decision.status == PaperDecisionStatus.BLOCKED:
        summary = f"Risk blocked policy action {decision.action_label}."
    else:
        summary = f"Policy recorded {decision.action_label}."

    _append_paper_event_any(
        _make_paper_event(
            paper_session_id=session["paper_session_id"],
            candidate_id=session["candidate_id"],
            event_type="policy_decision",
            actor=actor,
            summary=summary,
            created_at=created_at,
            payload={
                "policy_mode": mode,
                "decision": decision.model_dump(mode="json"),
            },
        )
    )


def _append_risk_blocked_event(
    session: dict,
    decision: PaperPolicyDecision,
    *,
    actor: str,
    created_at: str,
) -> None:
    assessment = decision.risk_assessment
    violations = assessment.violations if assessment else ["Pre-trade risk assessment blocked execution."]
    _append_paper_event_any(
        _make_paper_event(
            paper_session_id=session["paper_session_id"],
            candidate_id=session["candidate_id"],
            event_type="policy_action_blocked",
            actor=actor,
            summary=f"Blocked {decision.action_label}: {'; '.join(violations)}",
            created_at=created_at,
            payload={
                "decision_id": decision.decision_id,
                "risk_assessment": assessment.model_dump(mode="json") if assessment else None,
            },
        )
    )


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


def _runner_worker_active(paper_session_id: str) -> bool:
    if not _paper_storage_uses_db():
        return False
    lease = get_runner_lease(paper_session_id)
    return bool(lease and lease.get("active"))


def _revoke_durable_runner_lease(paper_session_id: str) -> None:
    if db_configured():
        revoke_runner_lease(paper_session_id)


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
    if not session.get("last_bar_time"):
        _reset_signal_history(paper_session_id)
        return []
    if existing and _normalize_timestamp(str(existing[-1]["time"])) == _normalize_timestamp(session["last_bar_time"]):
        return [*existing]

    history_df = get_ohlcv(
        symbol=session["symbol"],
        interval=normalise_interval(session["interval"]),
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
    return plan_signal_actions(session.get("current_position") or {}, signal)


def _signal_reason(signal: int) -> str:
    return signal_reason(signal)


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
    current.setdefault("policy_mode", PaperPolicyMode.AUTONOMOUS_PAPER.value)
    current.setdefault("last_decision", None)
    current.setdefault("pending_decision", None)
    current.setdefault("shadow_scorecard", {})
    current.setdefault("kill_switch_engaged", False)
    current.setdefault("kill_switch_reason", None)
    current.setdefault("parity_check", {})
    current.setdefault("last_error", None)
    current.setdefault("execution_backend", "durable_worker")
    current.setdefault("worker_requested_at", None)
    current.setdefault("market_event_cursor", {})
    current.setdefault("last_market_trade", None)
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


def _validate_runner_session_status(session: dict) -> None:
    disallowed = {
        PaperSessionStatus.DRAFT.value,
        PaperSessionStatus.STOPPED.value,
        PaperSessionStatus.FAILED.value,
    }
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
