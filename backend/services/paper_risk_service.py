from __future__ import annotations

import uuid
from datetime import datetime, time
from typing import Any

from schemas import PaperPolicyDecision, PaperRiskAssessment, PaperRiskCheck


def assess_pretrade_risk(
    session: dict[str, Any],
    decision: PaperPolicyDecision,
    *,
    checked_at: str,
) -> PaperRiskAssessment:
    """Return the independent risk verdict for one policy trade intent."""
    actions = list(decision.actions)
    runner_state = dict(session.get("runner_state") or {})
    guardrail_state = dict(session.get("guardrail_state") or {})
    guardrails = dict(session.get("guardrails") or {})
    position = dict(session.get("current_position") or {})
    active_orders = list(session.get("active_orders") or [])

    checks = [
        _check(
            "kill_switch",
            not bool(runner_state.get("kill_switch_engaged")),
            "Emergency kill switch is engaged.",
            "Emergency kill switch is clear.",
        ),
        _check(
            "hard_guardrails",
            not bool(
                guardrail_state.get("daily_loss_breached")
                or guardrail_state.get("drawdown_breached")
            ),
            _hard_guardrail_failure(guardrail_state),
            "Daily-loss and drawdown guardrails are clear.",
        ),
        _check(
            "pending_approval",
            not bool(runner_state.get("pending_decision")),
            "Another policy decision is still awaiting resolution.",
            "No policy decision is awaiting resolution.",
        ),
        _market_state_check(session, decision),
        _order_conflict_check(actions, position, active_orders),
        _exposure_check(actions, position, guardrails),
        _session_hours_check(decision.observed_at, guardrails),
    ]
    violations = [check.summary for check in checks if not check.passed]
    return PaperRiskAssessment(
        assessment_id=str(uuid.uuid4()),
        decision_id=decision.decision_id,
        status="blocked" if violations else "approved",
        checks=checks,
        violations=violations,
        checked_at=checked_at,
    )


def _check(code: str, passed: bool, failure: str, success: str) -> PaperRiskCheck:
    return PaperRiskCheck(code=code, passed=passed, summary=success if passed else failure)


def _hard_guardrail_failure(state: dict[str, Any]) -> str:
    breached = []
    if state.get("daily_loss_breached"):
        breached.append("daily-loss")
    if state.get("drawdown_breached"):
        breached.append("drawdown")
    return f"Hard {' and '.join(breached) if breached else 'risk'} guardrail is breached."


def _market_state_check(session: dict[str, Any], decision: PaperPolicyDecision) -> PaperRiskCheck:
    bar = decision.observation.bar
    quote = dict(session.get("last_quote") or {})
    prices_valid = all(_positive_number(bar.get(key)) for key in ("open", "high", "low", "close"))
    bid = _number(quote.get("bid"))
    ask = _number(quote.get("ask"))
    quote_valid = bid is not None and ask is not None and bid > 0 and ask > bid
    current_bar = _same_timestamp(session.get("last_bar_time"), decision.observed_at)
    passed = prices_valid and quote_valid and current_bar
    return _check(
        "market_state",
        passed,
        "Market observation is missing, stale, or has an invalid synthetic quote.",
        "Market observation and synthetic quote are current and valid.",
    )


def _order_conflict_check(
    actions: list[str],
    position: dict[str, Any],
    active_orders: list[dict[str, Any]],
) -> PaperRiskCheck:
    entry_actions = {action for action in actions if action in {"buy", "sell"}}
    exits_first = "exit" in actions
    side = position.get("side")
    duplicate_side = ("buy" in entry_actions and side == "buy") or (
        "sell" in entry_actions and side == "sell"
    )
    conflicting_entries = len(entry_actions) > 1
    resting_conflict = bool(entry_actions and active_orders)
    missing_flip_exit = bool(entry_actions and side in {"buy", "sell"} and not duplicate_side and not exits_first)
    passed = not (duplicate_side or conflicting_entries or resting_conflict or missing_flip_exit)
    return _check(
        "order_conflicts",
        passed,
        "Proposed actions duplicate or conflict with the current position or resting orders.",
        "Proposed actions do not conflict with current exposure or resting orders.",
    )


def _exposure_check(
    actions: list[str],
    position: dict[str, Any],
    guardrails: dict[str, Any],
) -> PaperRiskCheck:
    try:
        max_size = float(guardrails.get("max_position_size") or 1.0)
        order_size = float(guardrails.get("autonomous_order_quantity") or 1.0)
        current_size = float(position.get("quantity") or position.get("contracts") or 0.0)
    except (TypeError, ValueError):
        max_size = 0.0
        order_size = 1.0
        current_size = 0.0

    opens_position = any(action in {"buy", "sell"} for action in actions)
    projected_size = order_size if opens_position else current_size
    passed = max_size > 0 and order_size > 0 and current_size <= max_size and projected_size <= max_size
    return _check(
        "position_exposure",
        passed,
        f"Projected position size {projected_size:g} exceeds the autonomous limit {max_size:g}.",
        f"Projected position size {projected_size:g} is within the autonomous limit {max_size:g}.",
    )


def _session_hours_check(observed_at: str, guardrails: dict[str, Any]) -> PaperRiskCheck:
    start_raw = guardrails.get("session_start_utc")
    end_raw = guardrails.get("session_end_utc")
    if not start_raw and not end_raw:
        return _check(
            "session_hours",
            True,
            "Observation is outside configured session hours.",
            "No restricted autonomous session hours are configured.",
        )

    observed = _parse_timestamp(observed_at)
    start = _parse_clock(start_raw)
    end = _parse_clock(end_raw)
    if observed is None or start is None or end is None:
        return _check(
            "session_hours",
            False,
            "Configured autonomous session hours or observation time are invalid.",
            "Observation is inside configured autonomous session hours.",
        )

    current = observed.time().replace(tzinfo=None)
    inside = start <= current <= end if start <= end else current >= start or current <= end
    return _check(
        "session_hours",
        inside,
        "Observation is outside configured autonomous session hours.",
        "Observation is inside configured autonomous session hours.",
    )


def _number(value: Any) -> float | None:
    try:
        return float(value)
    except (TypeError, ValueError):
        return None


def _positive_number(value: Any) -> bool:
    parsed = _number(value)
    return parsed is not None and parsed > 0


def _parse_timestamp(value: Any) -> datetime | None:
    if not value:
        return None
    try:
        return datetime.fromisoformat(str(value).replace("Z", "+00:00"))
    except ValueError:
        return None


def _same_timestamp(left: Any, right: Any) -> bool:
    left_time = _parse_timestamp(left)
    right_time = _parse_timestamp(right)
    return left_time is not None and right_time is not None and left_time == right_time


def _parse_clock(value: Any) -> time | None:
    if not isinstance(value, str):
        return None
    try:
        return time.fromisoformat(value)
    except ValueError:
        return None
