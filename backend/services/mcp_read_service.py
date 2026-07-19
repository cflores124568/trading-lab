"""Compact, read-only views of Trading Lab state for MCP clients."""

from __future__ import annotations

from typing import Any

from services.candidate_service import get_candidate_any, list_candidates_any
from services.paper_session_service import (
    get_paper_session_any,
    list_paper_events_any,
    list_paper_sessions_any,
)

MAX_RESULT_LIMIT = 100
POLICY_EVENT_TYPES = {
    "policy_action_blocked",
    "policy_decision",
    "policy_decision_resolved",
}


def list_candidate_snapshots(
    lifecycle_status: str | None = None,
    limit: int = 20,
) -> dict[str, Any]:
    """Return compact candidate summaries newest first."""
    normalized_limit = _normalize_limit(limit)
    candidates = list_candidates_any()
    if lifecycle_status:
        candidates = [
            candidate
            for candidate in candidates
            if candidate.get("lifecycle_status") == lifecycle_status
        ]
    items = [_candidate_summary(candidate) for candidate in candidates[:normalized_limit]]
    return {"count": len(items), "items": items}


def get_candidate_snapshot(candidate_id: str) -> dict[str, Any]:
    """Return one candidate without its unbounded audit history."""
    candidate = get_candidate_any(candidate_id)
    if candidate is None:
        raise LookupError(f"Candidate '{candidate_id}' not found.")

    result = _candidate_summary(candidate)
    result.update(
        {
            "experiment_id": candidate.get("experiment_id"),
            "experiment_name": candidate.get("experiment_name"),
            "experiment_run_id": candidate.get("experiment_run_id"),
            "backtest_id": candidate.get("backtest_id"),
            "strategy_params": dict(candidate.get("strategy_params") or {}),
            "prop_firm_rules": dict(candidate.get("prop_firm_rules") or {}),
            "promotion_reason": candidate.get("promotion_reason"),
            "metrics": candidate.get("metrics"),
            "prop_firm_eval": candidate.get("prop_firm_eval"),
            "paper_bot": _paper_bot_snapshot(candidate.get("paper_bot")),
            "note_count": len(candidate.get("notes") or []),
            "audit_event_count": len(candidate.get("audit_log") or []),
        }
    )
    return result


def list_paper_session_snapshots(
    status: str | None = None,
    limit: int = 20,
) -> dict[str, Any]:
    """Return the existing operator summaries exposed by the paper service."""
    normalized_limit = _normalize_limit(limit)
    sessions = list_paper_sessions_any()
    if status:
        sessions = [session for session in sessions if session.get("status") == status]
    items = [dict(session) for session in sessions[:normalized_limit]]
    return {"count": len(items), "items": items}


def get_paper_session_snapshot(paper_session_id: str) -> dict[str, Any]:
    """Return bounded runtime, policy, risk, and execution state for one session."""
    session = get_paper_session_any(paper_session_id)
    if session is None:
        raise LookupError(f"Paper session '{paper_session_id}' not found.")

    runner = dict(session.get("runner_state") or {})
    trades = list(session.get("trade_log") or [])
    return {
        "paper_session_id": session.get("paper_session_id"),
        "candidate_id": session.get("candidate_id"),
        "name": session.get("name"),
        "symbol": session.get("symbol"),
        "interval": session.get("interval"),
        "strategy_type": session.get("strategy_type"),
        "strategy_params": dict(session.get("strategy_params") or {}),
        "status": session.get("status"),
        "current_position": dict(session.get("current_position") or {}),
        "active_orders": list(session.get("active_orders") or []),
        "last_quote": dict(session.get("last_quote") or {}),
        "metrics_snapshot": dict(session.get("metrics_snapshot") or {}),
        "guardrail_state": dict(session.get("guardrail_state") or {}),
        "runner": {
            "mode": runner.get("mode"),
            "policy_mode": runner.get("policy_mode"),
            "bars_processed": runner.get("bars_processed"),
            "last_candle_time": runner.get("last_candle_time"),
            "last_price": runner.get("last_price"),
            "last_signal": runner.get("last_signal"),
            "last_signal_action": runner.get("last_signal_action"),
            "last_error": runner.get("last_error"),
            "kill_switch_engaged": bool(runner.get("kill_switch_engaged")),
            "kill_switch_reason": runner.get("kill_switch_reason"),
            "pending_decision": runner.get("pending_decision"),
            "last_decision": runner.get("last_decision"),
            "shadow_scorecard": dict(runner.get("shadow_scorecard") or {}),
            "market_event_cursor": dict(runner.get("market_event_cursor") or {}),
            "last_market_trade": dict(runner.get("last_market_trade") or {}),
            "updated_at": runner.get("updated_at"),
        },
        "execution": {
            "closed_trade_count": len(trades),
            "recent_closed_trades": trades[-10:],
        },
        "last_bar_time": session.get("last_bar_time"),
        "last_event_at": session.get("last_event_at"),
        "updated_at": session.get("updated_at"),
    }


def list_policy_decision_snapshots(
    paper_session_id: str,
    limit: int = 20,
) -> dict[str, Any]:
    """Return recent policy proposal, risk-block, and resolution events."""
    if get_paper_session_any(paper_session_id) is None:
        raise LookupError(f"Paper session '{paper_session_id}' not found.")

    normalized_limit = _normalize_limit(limit)
    events = [
        event
        for event in list_paper_events_any(paper_session_id)
        if event.get("event_type") in POLICY_EVENT_TYPES
    ]
    items = [_policy_event_snapshot(event) for event in reversed(events[-normalized_limit:])]
    return {"paper_session_id": paper_session_id, "count": len(items), "items": items}


def _candidate_summary(candidate: dict[str, Any]) -> dict[str, Any]:
    paper_bot = dict(candidate.get("paper_bot") or {})
    return {
        "candidate_id": candidate.get("candidate_id"),
        "symbol": candidate.get("symbol"),
        "interval": candidate.get("interval"),
        "strategy_type": candidate.get("strategy_type"),
        "lifecycle_status": candidate.get("lifecycle_status"),
        "score": candidate.get("score"),
        "rank": candidate.get("rank"),
        "total_pnl": candidate.get("total_pnl"),
        "win_rate": candidate.get("win_rate"),
        "max_drawdown": candidate.get("max_drawdown"),
        "profit_factor": candidate.get("profit_factor"),
        "passed": candidate.get("passed"),
        "paper_bot_status": paper_bot.get("status"),
        "paper_session_id": paper_bot.get("paper_session_id"),
        "updated_at": candidate.get("updated_at"),
    }


def _paper_bot_snapshot(raw: Any) -> dict[str, Any] | None:
    if not raw:
        return None
    paper_bot = dict(raw)
    return {
        "paper_bot_id": paper_bot.get("paper_bot_id"),
        "status": paper_bot.get("status"),
        "paper_session_id": paper_bot.get("paper_session_id"),
        "guardrails": dict(paper_bot.get("guardrails") or {}),
        "last_event_at": paper_bot.get("last_event_at"),
        "updated_at": paper_bot.get("updated_at"),
    }


def _policy_event_snapshot(event: dict[str, Any]) -> dict[str, Any]:
    payload = dict(event.get("payload") or {})
    decision = payload.get("decision")
    return {
        "paper_event_id": event.get("paper_event_id"),
        "event_type": event.get("event_type"),
        "actor": event.get("actor"),
        "summary": event.get("summary"),
        "policy_mode": payload.get("policy_mode"),
        "approved": payload.get("approved"),
        "decision": decision,
        "decision_id": payload.get("decision_id") or (decision or {}).get("decision_id"),
        "risk_assessment": payload.get("risk_assessment"),
        "created_at": event.get("created_at"),
    }


def _normalize_limit(limit: int) -> int:
    if isinstance(limit, bool) or not isinstance(limit, int):
        raise ValueError("limit must be an integer.")
    if limit < 1 or limit > MAX_RESULT_LIMIT:
        raise ValueError(f"limit must be between 1 and {MAX_RESULT_LIMIT}.")
    return limit
