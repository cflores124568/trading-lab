import uuid
from datetime import datetime, timezone

from schemas import ResearchForwardDecisionRequest, ResearchForwardHandoffRequest
from services import (
    research_evaluation_repo,
    research_forward_qualification_repo,
    research_repo,
)
from services.candidate_service import (
    create_paper_bot_from_candidate,
    create_research_candidate_handoff,
)
from services.paper_session_service import (
    _save_paper_session_any,
    create_paper_session_for_candidate,
    get_paper_session_any,
    list_paper_events_any,
)
from services.research_service import _event


def create_handoff(
    campaign_id: str,
    research_candidate_id: str,
    request: ResearchForwardHandoffRequest,
) -> dict:
    promotion = research_evaluation_repo.get_research_candidate_promotion(
        campaign_id, research_candidate_id
    )
    if promotion is None:
        raise LookupError(f"Research candidate '{research_candidate_id}' not found.")
    campaign = research_repo.get_research_campaign(campaign_id)
    trial = research_repo.get_research_trial(campaign_id, promotion["trial_id"])
    finalist = research_evaluation_repo.get_finalist(campaign_id, promotion["trial_id"])
    if campaign is None or trial is None:
        raise LookupError("The promoted research provenance is incomplete.")
    if finalist is None or finalist.get("holdout_status") != "evaluated":
        raise ValueError("Evaluate the sealed holdout before forward-paper handoff.")
    if (finalist.get("holdout_result") or {}).get("outcome") != "holdout_qualified":
        raise ValueError("A holdout-rejected finalist cannot enter forward-paper qualification.")

    existing = research_forward_qualification_repo.get_by_research_candidate(research_candidate_id)
    if existing is not None:
        _tag_session(existing)
        return existing

    candidate = create_research_candidate_handoff(
        campaign,
        trial,
        promotion,
        prop_firm_rules=request.prop_firm_rules.model_dump(mode="json"),
        handoff_rationale=request.handoff_rationale,
        actor=request.actor,
    )
    create_paper_bot_from_candidate(candidate["candidate_id"], actor=request.actor)
    session = create_paper_session_for_candidate(
        candidate["candidate_id"],
        actor=request.actor,
        name=f"{campaign['name']} · forward qualification",
    )

    now = datetime.now(timezone.utc)
    qualification = {
        "qualification_id": str(uuid.uuid4()),
        "research_candidate_id": research_candidate_id,
        "campaign_id": campaign_id,
        "trial_id": trial["trial_id"],
        "candidate_id": candidate["candidate_id"],
        "paper_session_id": session["paper_session_id"],
        "status": "collecting",
        "min_forward_observations": request.min_forward_observations,
        "min_forward_decisions": request.min_forward_decisions,
        "expected_behavior": request.expected_behavior.model_dump(mode="json"),
        "evidence": {},
        "diagnostics": {},
        "gates": {},
        "approval_required": request.approval_required,
        "handoff_rationale": request.handoff_rationale.strip(),
        "handed_off_by": request.actor,
        "handed_off_at": now,
    }
    event = _event(
        campaign_id=campaign_id,
        event_type="forward_qualification_started",
        actor=request.actor,
        summary=f"Explicitly handed research candidate {research_candidate_id} to a draft shadow-first paper session.",
        payload={
            "research_candidate_id": research_candidate_id,
            "candidate_id": candidate["candidate_id"],
            "paper_session_id": session["paper_session_id"],
            "min_forward_observations": request.min_forward_observations,
            "min_forward_decisions": request.min_forward_decisions,
        },
        created_at=now,
    )
    stored, _ = research_forward_qualification_repo.create_qualification(qualification, event)
    _tag_session(stored)
    return stored


def get_for_research_candidate(campaign_id: str, research_candidate_id: str) -> dict | None:
    result = research_forward_qualification_repo.get_by_research_candidate(research_candidate_id)
    if result is not None and result["campaign_id"] != campaign_id:
        return None
    return result


def refresh(campaign_id: str, qualification_id: str, *, actor: str) -> dict:
    qualification = _require_qualification(campaign_id, qualification_id)
    if qualification["status"] != "collecting":
        raise ValueError("Terminal forward qualifications are immutable.")
    evidence, diagnostics, gates = _collect_evidence(qualification)
    now = datetime.now(timezone.utc)
    event = _event(
        campaign_id=campaign_id,
        event_type="forward_evidence_refreshed",
        actor=actor,
        summary=f"Refreshed forward evidence for qualification {qualification_id}.",
        payload={"qualification_id": qualification_id, "gates": gates},
        created_at=now,
    )
    stored = research_forward_qualification_repo.refresh_evidence(
        qualification_id,
        evidence=evidence,
        diagnostics=diagnostics,
        gates=gates,
        refreshed_at=now,
        event=event,
    )
    if stored is None:
        raise ValueError("Forward qualification is no longer collecting evidence.")
    _tag_session(stored)
    return stored


def decide(
    campaign_id: str,
    qualification_id: str,
    request: ResearchForwardDecisionRequest,
) -> dict:
    qualification = refresh(campaign_id, qualification_id, actor=request.actor)
    session = get_paper_session_any(qualification["paper_session_id"])
    if session is None:
        raise LookupError("The forward paper session no longer exists.")
    if session["status"] == "running":
        raise ValueError("Pause the paper session before recording a terminal qualification decision.")
    if request.outcome == "qualified":
        if not all(qualification["gates"].values()):
            raise ValueError("Every forward evidence gate must pass before qualification.")
        if qualification["approval_required"] and not request.approved:
            raise ValueError("This qualification requires explicit operator approval.")

    now = datetime.now(timezone.utc)
    event = _event(
        campaign_id=campaign_id,
        event_type=f"forward_{request.outcome}",
        actor=request.actor,
        summary=f"Recorded forward-paper outcome {request.outcome} for qualification {qualification_id}.",
        payload={
            "qualification_id": qualification_id,
            "candidate_id": qualification["candidate_id"],
            "paper_session_id": qualification["paper_session_id"],
            "reason": request.decision_reason.strip(),
        },
        created_at=now,
    )
    stored = research_forward_qualification_repo.decide(
        qualification_id,
        outcome=request.outcome,
        actor=request.actor,
        decided_at=now,
        reason=request.decision_reason.strip(),
        event=event,
    )
    if stored is None:
        raise ValueError("Forward qualification already has a terminal outcome.")
    _tag_session(stored)
    return stored


def _collect_evidence(qualification: dict) -> tuple[dict, dict, dict]:
    session = get_paper_session_any(qualification["paper_session_id"])
    if session is None:
        raise LookupError("The forward paper session no longer exists.")
    state = dict(session.get("runner_state") or {})
    scorecard = dict(state.get("shadow_scorecard") or {})
    shadow_observations = int(scorecard.get("total_decisions") or 0)
    actionable_decisions = int(scorecard.get("actionable_decisions") or 0)
    actionable_rate = actionable_decisions / shadow_observations if shadow_observations else 0.0
    events = list_paper_events_any(session["paper_session_id"])
    risk_blocks = sum(event.get("event_type") == "risk_blocked" for event in events)
    policy_decisions = sum(event.get("event_type") == "policy_decision" for event in events)
    risk_block_rate = risk_blocks / policy_decisions if policy_decisions else 0.0
    trades = list(session.get("trade_log") or [])
    total_execution_cost = sum(abs(float(trade.get("commission") or 0.0)) for trade in trades)
    average_execution_cost = total_execution_cost / len(trades) if trades else 0.0
    expected = qualification["expected_behavior"]
    gates = {
        "minimum_forward_observations": shadow_observations >= qualification["min_forward_observations"],
        "minimum_forward_decisions": actionable_decisions >= qualification["min_forward_decisions"],
        "expected_actionable_rate": (
            float(expected["min_actionable_rate"])
            <= actionable_rate
            <= float(expected["max_actionable_rate"])
        ),
        "risk_block_rate": risk_block_rate <= float(expected["max_risk_block_rate"]),
    }
    evidence = {
        "shadow_observations": shadow_observations,
        "actionable_decisions": actionable_decisions,
        "actionable_rate": round(actionable_rate, 6),
        "bars_processed": int(state.get("bars_processed") or 0),
        "paper_trades": len(trades),
        "paper_total_pnl": float((session.get("metrics_snapshot") or {}).get("total_pnl") or 0.0),
        "policy_mode": state.get("policy_mode"),
        "session_status": session.get("status"),
    }
    diagnostics = {
        "expected_actionable_rate": {
            "minimum": expected["min_actionable_rate"],
            "maximum": expected["max_actionable_rate"],
            "observed": round(actionable_rate, 6),
        },
        "execution_cost": {
            "total_commission": round(total_execution_cost, 2),
            "average_commission_per_trade": round(average_execution_cost, 2),
            "trade_count": len(trades),
        },
        "risk_blocks": {
            "blocked_decisions": risk_blocks,
            "policy_decisions": policy_decisions,
            "observed_rate": round(risk_block_rate, 6),
            "maximum_rate": expected["max_risk_block_rate"],
        },
    }
    return evidence, diagnostics, gates


def _require_qualification(campaign_id: str, qualification_id: str) -> dict:
    qualification = research_forward_qualification_repo.get_qualification(qualification_id)
    if qualification is None or qualification["campaign_id"] != campaign_id:
        raise LookupError(f"Forward qualification '{qualification_id}' not found.")
    return qualification


def _tag_session(qualification: dict) -> None:
    session = get_paper_session_any(qualification["paper_session_id"])
    if session is None:
        return
    state = dict(session.get("runner_state") or {})
    state["policy_mode"] = "shadow" if not state.get("bars_processed") else state.get("policy_mode", "shadow")
    state["forward_qualification"] = {
        "qualification_id": qualification["qualification_id"],
        "status": qualification["status"],
        "min_forward_observations": qualification["min_forward_observations"],
        "min_forward_decisions": qualification["min_forward_decisions"],
        "shadow_gates_passed": all(qualification.get("gates", {}).get(key, False) for key in (
            "minimum_forward_observations", "minimum_forward_decisions"
        )),
    }
    session["runner_state"] = state
    _save_paper_session_any(session)
