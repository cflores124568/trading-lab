from __future__ import annotations

import uuid
from typing import Any

from schemas import (
    PaperDecisionStatus,
    PaperMarketObservation,
    PaperPolicyDecision,
    PaperPolicyMode,
    PaperShadowScorecard,
)

DETERMINISTIC_POLICY_NAME = "deterministic_signal"
DETERMINISTIC_POLICY_VERSION = "1"


def normalize_policy_mode(value: str | PaperPolicyMode | None) -> PaperPolicyMode:
    if isinstance(value, PaperPolicyMode):
        return value
    try:
        return PaperPolicyMode(str(value or PaperPolicyMode.AUTONOMOUS_PAPER.value))
    except ValueError as exc:
        supported = ", ".join(mode.value for mode in PaperPolicyMode)
        raise ValueError(f"Unknown paper policy mode '{value}'. Expected one of: {supported}.") from exc


def build_market_observation(
    session: dict[str, Any],
    bar: dict[str, Any],
    *,
    signal: int,
    bar_index: int,
) -> PaperMarketObservation:
    normalized_signal = signal if signal in {-1, 0, 1} else 0
    return PaperMarketObservation(
        paper_session_id=session["paper_session_id"],
        candidate_id=session["candidate_id"],
        symbol=session["symbol"],
        interval=session["interval"],
        observed_at=str(bar["time"]),
        bar_index=max(0, int(bar_index)),
        bar=dict(bar),
        signal=normalized_signal,
        current_position=dict(session.get("current_position") or {}),
        active_orders=[dict(order) for order in (session.get("active_orders") or [])],
        metrics_snapshot=dict(session.get("metrics_snapshot") or {}),
        guardrail_state=dict(session.get("guardrail_state") or {}),
    )


def decide_with_deterministic_policy(
    observation: PaperMarketObservation,
    *,
    policy_mode: str | PaperPolicyMode | None,
    created_at: str,
) -> PaperPolicyDecision:
    actions, action_label = plan_signal_actions(
        observation.current_position,
        observation.signal,
    )
    return PaperPolicyDecision(
        decision_id=str(uuid.uuid4()),
        paper_session_id=observation.paper_session_id,
        policy_name=DETERMINISTIC_POLICY_NAME,
        policy_version=DETERMINISTIC_POLICY_VERSION,
        policy_mode=normalize_policy_mode(policy_mode),
        observed_at=observation.observed_at,
        signal=observation.signal,
        actions=actions,
        action_label=action_label,
        rationale=signal_reason(observation.signal),
        observation=observation,
        created_at=created_at,
    )


def plan_signal_actions(position: dict[str, Any], signal: int) -> tuple[list[str], str]:
    normalized_signal = signal if signal in {-1, 0, 1} else 0
    side = position.get("side")

    if normalized_signal == 1:
        if side == "sell":
            return ["exit", "buy"], "flip_to_buy"
        if side == "buy":
            return ["mark"], "hold_long"
        return ["buy"], "open_long"

    if normalized_signal == -1:
        if side == "buy":
            return ["exit", "sell"], "flip_to_sell"
        if side == "sell":
            return ["mark"], "hold_short"
        return ["sell"], "open_short"

    if side in {"buy", "sell"}:
        return ["mark"], "mark_open_position"
    return [], "flat_no_signal"


def signal_reason(signal: int) -> str:
    if signal == 1:
        return "Latest strategy signal crossed bullish (+1)."
    if signal == -1:
        return "Latest strategy signal crossed bearish (-1)."
    return "Latest strategy signal is flat (0)."


def decision_requires_approval(decision: PaperPolicyDecision | dict[str, Any]) -> bool:
    actions = decision.actions if isinstance(decision, PaperPolicyDecision) else decision.get("actions", [])
    return any(action in {"buy", "sell", "exit"} for action in actions)


def update_shadow_scorecard(
    current: dict[str, Any] | PaperShadowScorecard | None,
    decision: PaperPolicyDecision,
) -> PaperShadowScorecard:
    """Fold one shadow decision into the durable operator scorecard."""
    if isinstance(current, PaperShadowScorecard):
        scorecard = current.model_copy(deep=True)
    elif current:
        scorecard = PaperShadowScorecard.model_validate(current)
    else:
        scorecard = PaperShadowScorecard(
            policy_name=decision.policy_name,
            policy_version=decision.policy_version,
        )

    scorecard.total_decisions += 1
    scorecard.actionable_decisions += int(decision_requires_approval(decision))
    scorecard.no_action_decisions += int(not decision.actions)
    scorecard.mark_decisions += int("mark" in decision.actions)
    scorecard.buy_proposals += decision.actions.count("buy")
    scorecard.sell_proposals += decision.actions.count("sell")
    scorecard.exit_proposals += decision.actions.count("exit")
    scorecard.bullish_observations += int(decision.signal == 1)
    scorecard.bearish_observations += int(decision.signal == -1)
    scorecard.flat_observations += int(decision.signal == 0)
    scorecard.first_observed_at = scorecard.first_observed_at or decision.observed_at
    scorecard.last_observed_at = decision.observed_at
    scorecard.last_decision_id = decision.decision_id
    return scorecard
