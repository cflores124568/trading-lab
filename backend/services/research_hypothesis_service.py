import hashlib
import json
import math
import uuid
from datetime import datetime, timezone
from typing import Any

from schemas import (
    ResearchHypothesisBudgetRequest,
    ResearchHypothesisExecuteRequest,
    ResearchHypothesisProposal,
    ResearchTrialCreate,
)
from services import research_hypothesis_repo, research_repo
from services.research_search_worker import execute_search_plan
from services.research_service import register_trial


NEAR_DUPLICATE_DISTANCE = 0.10
MAX_PROPOSAL_BYTES = 32 * 1024

_COMMON_BOUNDS = {
    "trend_ema_period": (0, 500, int, 0),
    "min_atr_percent": (0.0, 10.0, float, 0.0),
    "vwap_bias": (0, 1, int, 0),
    "cooldown_bars": (0, 500, int, 0),
    "atr_period": (2, 200, int, 14),
}
_PRIMITIVE_BOUNDS = {
    "ma_crossover": {
        "fast_period": (2, 200, int, None),
        "slow_period": (3, 500, int, None),
    },
    "ema_crossover": {
        "fast_period": (2, 200, int, None),
        "slow_period": (3, 500, int, None),
    },
    "rsi_overbought": {
        "rsi_period": (2, 200, int, None),
        "oversold": (1, 49, float, None),
        "overbought": (51, 99, float, None),
    },
    "bollinger_bands": {
        "bb_period": (2, 500, int, None),
        "std_dev": (0.5, 5.0, float, None),
    },
}


def configure_budget(campaign_id: str, request: ResearchHypothesisBudgetRequest) -> dict:
    campaign = research_repo.get_research_campaign(campaign_id, event_limit=1)
    if campaign is None:
        raise LookupError(f"Research campaign '{campaign_id}' not found.")
    now = datetime.now(timezone.utc)
    event = _event(
        campaign_id,
        "hypothesis_budget_configured",
        request.actor,
        f"Configured a {request.hypothesis_budget}-attempt hypothesis budget and {request.trial_budget}-trial budget.",
        {"hypothesis_budget": request.hypothesis_budget, "trial_budget": request.trial_budget},
        now,
    )
    budget = research_hypothesis_repo.configure_budget(
        campaign_id,
        hypothesis_budget=request.hypothesis_budget,
        trial_budget=request.trial_budget,
        event=event,
    )
    if budget is None:
        raise ValueError("Hypothesis budgets can only be configured once, before attempts, while the campaign is not queued or running.")
    return budget


def get_budget(campaign_id: str) -> dict:
    budget = research_hypothesis_repo.get_budget(campaign_id)
    if budget is None:
        raise LookupError(f"Research campaign '{campaign_id}' not found.")
    if budget["hypothesis_budget"] is None:
        raise ValueError("Hypothesis budgets have not been configured for this campaign.")
    return budget


def submit_hypothesis(campaign_id: str, proposal: ResearchHypothesisProposal) -> dict:
    campaign = research_repo.get_research_campaign(campaign_id, event_limit=1)
    if campaign is None:
        raise LookupError(f"Research campaign '{campaign_id}' not found.")
    budget = research_hypothesis_repo.get_budget(campaign_id)
    if budget is None or budget["hypothesis_budget"] is None:
        raise ValueError("Configure explicit hypothesis and trial budgets before submitting proposals.")

    raw = proposal.model_dump(mode="json")
    if len(_canonical_json(raw)) > MAX_PROPOSAL_BYTES:
        reasons = [f"proposal exceeds the {MAX_PROPOSAL_BYTES}-byte limit"]
        normalized_params = None
    else:
        normalized_params, reasons = validate_and_normalize(proposal.strategy_primitive, proposal.strategy_params)

    fingerprint = hypothesis_fingerprint(proposal.strategy_primitive, normalized_params or proposal.strategy_params)
    status = "rejected" if reasons else "accepted"
    duplicate_of = None
    near_key = None
    comparable = research_hypothesis_repo.list_comparable_attempts(
        campaign_id, proposal.strategy_primitive.strip().lower()
    )

    exact = next((item for item in comparable if item["fingerprint"] == fingerprint), None)
    if not reasons and exact is not None:
        status = "duplicate"
        duplicate_of = exact["hypothesis_attempt_id"]
        reasons = ["an accepted hypothesis already compiles to the same trial specification"]
    elif not reasons:
        near = _find_near_duplicate(normalized_params, comparable)
        if near is not None:
            status = "near_duplicate"
            duplicate_of = near["hypothesis_attempt_id"]
            near_key = near["fingerprint"]
            reasons = [f"proposal is within {NEAR_DUPLICATE_DISTANCE:.2f} normalized parameter distance of an accepted hypothesis"]

    if status == "accepted" and budget["attempted_hypotheses"] >= budget["hypothesis_budget"]:
        status = "budget_rejected"
        reasons = ["campaign hypothesis-attempt budget is exhausted"]
    if status == "accepted" and budget["accepted_hypotheses"] >= budget["trial_budget"]:
        status = "budget_rejected"
        reasons = ["campaign compiled-trial budget is exhausted"]

    compiled = None
    if status == "accepted":
        execution_config = dict(campaign.get("search_config") or {}).get("execution_config") or {}
        compiled = {
            "strategy_type": proposal.strategy_primitive.strip().lower(),
            "strategy_params": normalized_params,
            "execution_config": execution_config,
            "random_seed": int(fingerprint[:15], 16),
        }

    now = datetime.now(timezone.utc)
    attempt = {
        "hypothesis_attempt_id": str(uuid.uuid4()),
        "campaign_id": campaign_id,
        "fingerprint": fingerprint,
        "near_duplicate_key": near_key,
        "status": status,
        "proposal": raw,
        "compiled_trial": compiled,
        "rejection_reasons": reasons,
        "duplicate_of_attempt_id": duplicate_of,
        "created_at": now,
        "near_duplicate_ranges": {
            key: float(spec[1]) - float(spec[0])
            for key, spec in ({**_PRIMITIVE_BOUNDS.get(proposal.strategy_primitive.strip().lower(), {}), **_COMMON_BOUNDS}).items()
        },
    }
    event = _event(
        campaign_id,
        "hypothesis_attempt_recorded",
        proposal.proposed_by,
        f"Recorded {status} research hypothesis attempt {attempt['hypothesis_attempt_id']}.",
        {
            "hypothesis_attempt_id": attempt["hypothesis_attempt_id"],
            "fingerprint": fingerprint,
            "status": status,
            "duplicate_of_attempt_id": duplicate_of,
            "rejection_reasons": reasons,
        },
        now,
    )
    return research_hypothesis_repo.create_attempt(attempt, event)


def list_hypotheses(campaign_id: str, *, limit: int, offset: int, status: str | None = None) -> list[dict]:
    if research_repo.get_research_campaign(campaign_id, event_limit=1) is None:
        raise LookupError(f"Research campaign '{campaign_id}' not found.")
    return research_hypothesis_repo.list_attempts(campaign_id, limit=limit, offset=offset, status=status)


def get_hypothesis(campaign_id: str, attempt_id: str) -> dict | None:
    return research_hypothesis_repo.get_attempt(campaign_id, attempt_id)


def execute_hypothesis(
    campaign_id: str,
    attempt_id: str,
    request: ResearchHypothesisExecuteRequest,
    *,
    executor=execute_search_plan,
) -> dict:
    campaign = research_repo.get_research_campaign(campaign_id)
    if campaign is None:
        raise LookupError(f"Research campaign '{campaign_id}' not found.")
    if campaign["status"] in {"queued", "running"}:
        raise ValueError("Pause the campaign worker before executing a reviewed hypothesis.")
    attempt = research_hypothesis_repo.get_attempt(campaign_id, attempt_id)
    if attempt is None:
        raise LookupError(f"Research hypothesis attempt '{attempt_id}' not found.")
    if attempt.get("trial_id"):
        return attempt
    if attempt["status"] != "accepted" or not attempt.get("compiled_trial"):
        raise ValueError("Only statically accepted hypotheses can be executed.")

    contract = attempt["compiled_trial"]
    try:
        result = executor(campaign, {
            "strategy_type": contract["strategy_type"],
            "strategy_params": contract["strategy_params"],
        })
        trial_request = ResearchTrialCreate(
            **contract, status="completed", result=result, created_by=request.actor
        )
    except Exception as exc:
        trial_request = ResearchTrialCreate(
            **contract,
            status="failed",
            error=(str(exc) or exc.__class__.__name__)[:4000],
            created_by=request.actor,
        )
    trial = register_trial(campaign_id, trial_request)
    now = datetime.now(timezone.utc)
    event = _event(
        campaign_id,
        "hypothesis_trial_executed",
        request.actor,
        f"Executed reviewed hypothesis {attempt_id} as terminal research trial {trial['trial_id']}.",
        {"hypothesis_attempt_id": attempt_id, "trial_id": trial["trial_id"], "trial_status": trial["status"]},
        now,
    )
    research_hypothesis_repo.link_trial(
        attempt_id, trial["trial_id"], actor=request.actor, executed_at=now, event=event
    )
    return research_hypothesis_repo.get_attempt(campaign_id, attempt_id)


def validate_and_normalize(strategy_primitive: str, params: dict[str, Any]) -> tuple[dict[str, Any] | None, list[str]]:
    primitive = strategy_primitive.strip().lower()
    bounds = _PRIMITIVE_BOUNDS.get(primitive)
    if bounds is None:
        return None, [f"unsupported strategy primitive '{strategy_primitive}'"]
    if not isinstance(params, dict):
        return None, ["strategy_params must be an object"]

    allowed = {**bounds, **_COMMON_BOUNDS}
    reasons = [f"unsupported parameter '{key}'" for key in sorted(set(params) - set(allowed))]
    normalized: dict[str, Any] = {}
    for key, (minimum, maximum, kind, default) in allowed.items():
        if key not in params:
            if default is None:
                reasons.append(f"required parameter '{key}' is missing")
            else:
                normalized[key] = default
            continue
        value = params[key]
        if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(float(value)):
            reasons.append(f"parameter '{key}' must be a finite number")
            continue
        if kind is int and float(value) != int(value):
            reasons.append(f"parameter '{key}' must be an integer")
            continue
        converted = int(value) if kind is int else float(value)
        if converted < minimum or converted > maximum:
            reasons.append(f"parameter '{key}' must be between {minimum} and {maximum}")
            continue
        normalized[key] = converted

    if not reasons and primitive in {"ma_crossover", "ema_crossover"}:
        if normalized["fast_period"] >= normalized["slow_period"]:
            reasons.append("fast_period must be less than slow_period")
    if not reasons and primitive == "rsi_overbought":
        if normalized["oversold"] >= normalized["overbought"]:
            reasons.append("oversold must be less than overbought")
    return (normalized if not reasons else None), reasons


def hypothesis_fingerprint(strategy_primitive: str, params: dict[str, Any]) -> str:
    value = {"strategy_primitive": strategy_primitive.strip().lower(), "strategy_params": params}
    return hashlib.sha256(_canonical_json(value)).hexdigest()


def _find_near_duplicate(params: dict[str, Any], attempts: list[dict]) -> dict | None:
    for attempt in attempts:
        other, reasons = validate_and_normalize(
            attempt["proposal"]["strategy_primitive"], attempt["proposal"]["strategy_params"]
        )
        if reasons or set(other) != set(params):
            continue
        primitive = attempt["proposal"]["strategy_primitive"].strip().lower()
        bounds = {**_PRIMITIVE_BOUNDS[primitive], **_COMMON_BOUNDS}
        distance = max(
            abs(float(params[key]) - float(other[key])) / max(float(bounds[key][1]) - float(bounds[key][0]), 1.0)
            for key in params
        )
        if 0 < distance <= NEAR_DUPLICATE_DISTANCE:
            return attempt
    return None


def _canonical_json(value: Any) -> bytes:
    try:
        return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False, allow_nan=False).encode()
    except (TypeError, ValueError) as exc:
        raise ValueError(f"Hypothesis must be canonical JSON: {exc}") from exc


def _event(campaign_id: str, event_type: str, actor: str, summary: str, payload: dict, created_at) -> dict:
    return {
        "research_campaign_event_id": str(uuid.uuid4()),
        "campaign_id": campaign_id,
        "event_type": event_type,
        "actor": actor,
        "summary": summary,
        "payload": payload,
        "created_at": created_at,
    }
