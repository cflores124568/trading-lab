import hashlib
import json
import statistics
import uuid
from collections import defaultdict
from datetime import datetime, timezone

from schemas import (
    ResearchCandidatePromotionRequest,
    ResearchFinalistFreezeRequest,
    ResearchHoldoutEvaluationRequest,
    ResearchValidationRequest,
)
from services import research_evaluation_repo, research_repo
from services.research_service import _event


def evaluate_validation(campaign_id: str, trial_id: str, request: ResearchValidationRequest) -> dict:
    campaign = research_repo.get_research_campaign(campaign_id)
    trial = research_repo.get_research_trial(campaign_id, trial_id)
    if campaign is None:
        raise LookupError(f"Research campaign '{campaign_id}' not found.")
    if trial is None:
        raise LookupError(f"Research trial '{trial_id}' not found.")
    if trial["status"] != "completed":
        raise ValueError("Only completed research trials can enter validation.")

    _validate_walk_forward_boundaries(campaign["partitions"], request)
    _validate_neighbors(trial.get("strategy_params") or {}, request)
    evidence = request.model_dump(mode="json")
    evidence_fingerprint = _fingerprint(evidence)
    result = _score_validation(request)
    now = datetime.now(timezone.utc)
    evaluation = {
        "evaluation_id": str(uuid.uuid4()),
        "campaign_id": campaign_id,
        "trial_id": trial_id,
        "evidence_fingerprint": evidence_fingerprint,
        **result,
        "evidence": evidence,
        "created_at": now,
    }
    event = _event(
        campaign_id=campaign_id,
        event_type="validation_evaluated",
        actor=request.actor,
        summary=f"Validation marked trial {trial_id} as {result['outcome']}.",
        payload={
            "trial_id": trial_id,
            "evaluation_id": evaluation["evaluation_id"],
            "outcome": result["outcome"],
            "robustness_score": result["robustness_score"],
        },
        created_at=now,
    )
    stored, created = research_evaluation_repo.save_validation_evaluation(evaluation, event)
    if not created and _fingerprint(stored["evidence"]) != evidence_fingerprint:
        raise ValueError("This trial already has a different frozen validation evaluation.")
    return stored


def get_validation(campaign_id: str, trial_id: str) -> dict | None:
    return research_evaluation_repo.get_validation_evaluation(campaign_id, trial_id)


def freeze_finalist(campaign_id: str, trial_id: str, request: ResearchFinalistFreezeRequest) -> dict:
    evaluation = get_validation(campaign_id, trial_id)
    if evaluation is None:
        raise ValueError("Run and persist validation before freezing a finalist.")
    if evaluation["outcome"] != "research_finalist":
        raise ValueError("Rejected trials cannot be frozen as research finalists.")

    now = datetime.now(timezone.utc)
    finalist = {
        "campaign_id": campaign_id,
        "trial_id": trial_id,
        "evaluation_id": evaluation["evaluation_id"],
        "frozen_validation_score": evaluation["robustness_score"],
        "frozen_by": request.actor,
        "frozen_at": now,
    }
    event = _event(
        campaign_id=campaign_id,
        event_type="research_finalist_frozen",
        actor=request.actor,
        summary=f"Froze trial {trial_id} before its one-time holdout evaluation.",
        payload={"trial_id": trial_id, "evaluation_id": evaluation["evaluation_id"]},
        created_at=now,
    )
    stored, _ = research_evaluation_repo.freeze_finalist(finalist, event)
    return stored


def evaluate_holdout(
    campaign_id: str,
    trial_id: str,
    request: ResearchHoldoutEvaluationRequest,
) -> dict:
    finalist = research_evaluation_repo.get_finalist(campaign_id, trial_id)
    if finalist is None:
        raise ValueError("Freeze the research finalist before evaluating holdout evidence.")
    if finalist["holdout_status"] != "sealed":
        raise ValueError("The final holdout has already been evaluated for this finalist.")

    by_multiplier = {item.cost_multiplier: item.metrics for item in request.cost_stresses}
    base = by_multiplier[1.0]
    stressed = by_multiplier[2.0]
    result = {
        "outcome": "holdout_qualified" if base.total_pnl > 0 and stressed.total_pnl > 0 else "holdout_rejected",
        "base_total_pnl": base.total_pnl,
        "base_total_trades": base.total_trades,
        "base_max_drawdown": base.max_drawdown,
        "two_x_cost_total_pnl": stressed.total_pnl,
        "cost_stresses": [item.model_dump(mode="json") for item in request.cost_stresses],
        "note": "This is a one-time sealed-holdout result, not a guarantee of future profitability.",
    }
    now = datetime.now(timezone.utc)
    event = _event(
        campaign_id=campaign_id,
        event_type="holdout_evaluated",
        actor=request.actor,
        summary=f"Recorded the one-time sealed holdout result for finalist {trial_id}.",
        payload={"trial_id": trial_id, "outcome": result["outcome"]},
        created_at=now,
    )
    stored = research_evaluation_repo.record_holdout_once(campaign_id, trial_id, result, now, event)
    if stored is None:
        raise ValueError("The final holdout has already been evaluated for this finalist.")
    return stored


def list_finalists(campaign_id: str, *, limit: int, offset: int) -> list[dict]:
    if research_repo.get_research_campaign(campaign_id, event_limit=1) is None:
        raise LookupError(f"Research campaign '{campaign_id}' not found.")
    return research_evaluation_repo.list_finalists(campaign_id, limit=limit, offset=offset)


def promote_candidate(
    campaign_id: str,
    trial_id: str,
    request: ResearchCandidatePromotionRequest,
) -> dict:
    finalist = research_evaluation_repo.get_finalist(campaign_id, trial_id)
    if finalist is None:
        raise ValueError("Only a frozen, gate-passing research finalist can be promoted.")
    evaluation = get_validation(campaign_id, trial_id)
    if evaluation is None or evaluation["outcome"] != "research_finalist" or not all(evaluation["gates"].values()):
        raise ValueError("Research candidate promotion requires every validation gate to pass.")

    now = datetime.now(timezone.utc)
    promotion = {
        "research_candidate_id": str(uuid.uuid4()),
        "campaign_id": campaign_id,
        "trial_id": trial_id,
        "evaluation_id": evaluation["evaluation_id"],
        "validation_score": finalist["frozen_validation_score"],
        "promotion_reason": request.promotion_reason.strip(),
        "promoted_by": request.actor,
        "promoted_at": now,
    }
    event = _event(
        campaign_id=campaign_id,
        event_type="research_candidate_promoted",
        actor=request.actor,
        summary=f"Manually promoted frozen finalist {trial_id} to a validated research candidate.",
        payload={
            "trial_id": trial_id,
            "evaluation_id": evaluation["evaluation_id"],
            "research_candidate_id": promotion["research_candidate_id"],
        },
        created_at=now,
    )
    stored, _ = research_evaluation_repo.promote_research_candidate(promotion, event)
    return stored


def list_candidate_promotions(campaign_id: str, *, limit: int, offset: int) -> list[dict]:
    if research_repo.get_research_campaign(campaign_id, event_limit=1) is None:
        raise LookupError(f"Research campaign '{campaign_id}' not found.")
    return research_evaluation_repo.list_research_candidate_promotions(
        campaign_id,
        limit=limit,
        offset=offset,
    )


def _validate_walk_forward_boundaries(partitions: list[dict], request: ResearchValidationRequest) -> None:
    by_name = {item["partition_name"]: item for item in partitions}
    development = by_name["development"]
    validation = by_name["validation"]
    holdout = by_name["holdout"]
    folds = sorted(request.folds, key=lambda fold: fold.fold_index)
    if [fold.fold_index for fold in folds] != list(range(1, len(folds) + 1)):
        raise ValueError("Walk-forward fold indexes must be consecutive starting at 1.")

    previous_test_end = None
    first_train_start = _utc(folds[0].train_start)
    previous_train_end = None
    previous_train_start = None
    for fold in folds:
        train_start, train_end = _utc(fold.train_start), _utc(fold.train_end)
        test_start, test_end = _utc(fold.test_start), _utc(fold.test_end)
        if train_start < _utc(development["start_time"]) or train_end >= test_start:
            raise ValueError("Every training window must start in development and end before its test window.")
        if test_start < _utc(validation["start_time"]) or test_end > _utc(validation["end_time"]):
            raise ValueError("Walk-forward test windows must stay entirely inside validation.")
        if test_end >= _utc(holdout["start_time"]):
            raise ValueError("Final holdout bars cannot appear in validation evidence.")
        if test_start > test_end or (previous_test_end is not None and test_start <= previous_test_end):
            raise ValueError("Walk-forward test windows must be chronological and non-overlapping.")
        if previous_train_end is not None and train_end <= previous_train_end:
            raise ValueError("Walk-forward training windows must advance chronologically.")
        if request.walk_forward_mode == "expanding" and train_start != first_train_start:
            raise ValueError("Expanding walk-forward folds must keep one fixed training start.")
        if request.walk_forward_mode == "rolling" and previous_train_start is not None and train_start < previous_train_start:
            raise ValueError("Rolling walk-forward training starts cannot move backward.")
        previous_test_end, previous_train_end, previous_train_start = test_end, train_end, train_start


def _score_validation(request: ResearchValidationRequest) -> dict:
    base_metrics = [_stress(fold, 1.0) for fold in request.folds]
    pnl_by_cost = {
        multiplier: [_stress(fold, multiplier).total_pnl for fold in request.folds]
        for multiplier in (1.0, 1.5, 2.0)
    }
    eligible = sum(item.total_trades >= request.min_trades_per_fold for item in base_metrics)
    coverage = eligible / len(base_metrics)
    profitable_rate = sum(item.total_pnl > 0 for item in base_metrics) / len(base_metrics)
    median_pnl = float(statistics.median(pnl_by_cost[1.0]))
    worst_pnl = float(min(pnl_by_cost[1.0]))
    worst_drawdown = float(max(item.max_drawdown for item in base_metrics))
    cost_positive_rates = {
        str(multiplier): sum(value > 0 for value in values) / len(values)
        for multiplier, values in pnl_by_cost.items()
    }

    neighbor_pnls = [item.validation_total_pnl for item in request.neighbors]
    neighbor_positive_rate = sum(value > 0 for value in neighbor_pnls) / len(neighbor_pnls) if neighbor_pnls else 0.0
    neighbor_median = float(statistics.median(neighbor_pnls)) if neighbor_pnls else 0.0
    parameter_cliff = (
        len(neighbor_pnls) < 2
        or median_pnl <= 0
        or neighbor_median < median_pnl * (1 - request.parameter_cliff_threshold)
    )

    concentration = _concentration(request)
    regime = _regime_diagnostics(request)
    regime_positive_rate = (
        sum(item["median_pnl"] > 0 for item in regime.values()) / len(regime)
        if regime else 0.0
    )
    gates = {
        "minimum_trade_coverage": coverage >= request.min_fold_coverage,
        "median_fold_profitable": median_pnl > 0,
        "worst_fold_drawdown": worst_drawdown <= request.max_allowed_drawdown,
        "two_x_cost_median_profitable": statistics.median(pnl_by_cost[2.0]) > 0,
        "parameter_stability": not parameter_cliff,
        "regime_stability": regime_positive_rate >= 0.50,
    }
    reasons = {
        "minimum_trade_coverage": "Too few validation folds met the minimum-trade requirement.",
        "median_fold_profitable": "Median validation-fold PnL was not positive.",
        "worst_fold_drawdown": "Worst-fold drawdown exceeded the configured limit.",
        "two_x_cost_median_profitable": "Median validation PnL was not positive at 2x transaction costs.",
        "parameter_stability": "Neighboring parameters were missing or showed a parameter cliff.",
        "regime_stability": "Fewer than half of the observed regimes had positive median validation PnL.",
    }
    rejection_reasons = [reasons[key] for key, passed in gates.items() if not passed]
    warnings = []
    if request.campaign_trial_count >= 100:
        warnings.append("This campaign tested at least 100 trials; apparent winners face substantial selection risk.")
    elif request.campaign_trial_count >= 20:
        warnings.append("This campaign tested at least 20 trials; interpret the best score with multiple-testing caution.")
    if not request.concentration_slices:
        warnings.append("No cross-symbol or cross-interval slices were supplied; concentration is unknown.")
    elif max(concentration["max_symbol_share"], concentration["max_interval_share"]) >= 0.80:
        warnings.append("At least 80% of absolute PnL is concentrated in one symbol/interval slice.")
    if len(neighbor_pnls) < 2:
        warnings.append("At least two neighboring parameter results are required for parameter-stability evidence.")

    components = {
        "fold_consistency": round(30 * (profitable_rate + coverage + regime_positive_rate) / 3, 4),
        "cost_resilience": round(25 * statistics.mean(cost_positive_rates.values()), 4),
        "drawdown_stability": round(20 * max(0.0, 1 - worst_drawdown / request.max_allowed_drawdown), 4),
        "parameter_stability": round(15 * neighbor_positive_rate, 4),
        "concentration": round(
            10 * (1 - max(concentration["max_symbol_share"], concentration["max_interval_share"])),
            4,
        ),
    }
    score = round(sum(components.values()), 4)
    return {
        "outcome": "research_finalist" if all(gates.values()) else "rejected",
        "robustness_score": score,
        "score_components": components,
        "gates": gates,
        "rejection_reasons": rejection_reasons,
        "warnings": warnings,
        "diagnostics": {
            "fold_coverage": round(coverage, 4),
            "profitable_fold_rate": round(profitable_rate, 4),
            "median_fold_pnl": median_pnl,
            "worst_fold_pnl": worst_pnl,
            "worst_fold_drawdown": worst_drawdown,
            "median_pnl_by_cost": {str(key): float(statistics.median(value)) for key, value in pnl_by_cost.items()},
            "cost_positive_rates": cost_positive_rates,
            "parameter_sensitivity": {
                "neighbor_count": len(neighbor_pnls),
                "neighbor_median_pnl": neighbor_median,
                "neighbor_positive_rate": round(neighbor_positive_rate, 4),
                "parameter_cliff": parameter_cliff,
            },
            "regime_stability": regime,
            "regime_positive_rate": round(regime_positive_rate, 4),
            "concentration": concentration,
            "campaign_trial_count": request.campaign_trial_count,
        },
    }


def _stress(fold, multiplier):
    return next(item.metrics for item in fold.cost_stresses if item.cost_multiplier == multiplier)


def _regime_diagnostics(request: ResearchValidationRequest) -> dict:
    groups = defaultdict(list)
    for fold in request.folds:
        groups[fold.regime].append(_stress(fold, 1.0).total_pnl)
    return {
        regime: {"fold_count": len(values), "median_pnl": float(statistics.median(values)), "worst_pnl": float(min(values))}
        for regime, values in sorted(groups.items())
    }


def _concentration(request: ResearchValidationRequest) -> dict:
    slices = request.concentration_slices
    total_abs_pnl = sum(abs(item.total_pnl) for item in slices)
    shares = [abs(item.total_pnl) / total_abs_pnl for item in slices] if total_abs_pnl else []
    symbol_totals = defaultdict(float)
    interval_totals = defaultdict(float)
    for item in slices:
        symbol_totals[item.symbol] += abs(item.total_pnl)
        interval_totals[item.interval] += abs(item.total_pnl)
    symbol_shares = {key: value / total_abs_pnl for key, value in symbol_totals.items()} if total_abs_pnl else {}
    interval_shares = {key: value / total_abs_pnl for key, value in interval_totals.items()} if total_abs_pnl else {}
    return {
        "max_share": round(max(shares), 4) if shares else 0.5,
        "max_symbol_share": round(max(symbol_shares.values()), 4) if symbol_shares else 0.5,
        "max_interval_share": round(max(interval_shares.values()), 4) if interval_shares else 0.5,
        "symbol_shares": {key: round(value, 4) for key, value in sorted(symbol_shares.items())},
        "interval_shares": {key: round(value, 4) for key, value in sorted(interval_shares.items())},
        "slices": [item.model_dump(mode="json") | {"absolute_pnl_share": round(share, 4)} for item, share in zip(slices, shares)],
    }


def _validate_neighbors(base_params: dict, request: ResearchValidationRequest) -> None:
    seen = set()
    canonical_base = json.dumps(base_params, sort_keys=True, separators=(",", ":"))
    for neighbor in request.neighbors:
        canonical = json.dumps(neighbor.strategy_params, sort_keys=True, separators=(",", ":"))
        if canonical == canonical_base:
            raise ValueError("Neighbor evidence cannot repeat the trial's exact parameters.")
        if canonical in seen:
            raise ValueError("Neighbor parameter evidence must be unique.")
        seen.add(canonical)


def _fingerprint(value: dict) -> str:
    payload = json.dumps(value, sort_keys=True, separators=(",", ":"), allow_nan=False).encode()
    return hashlib.sha256(payload).hexdigest()


def _utc(value) -> datetime:
    if isinstance(value, str):
        value = datetime.fromisoformat(value.replace("Z", "+00:00"))
    if value.tzinfo is None or value.utcoffset() is None:
        raise ValueError("Walk-forward and partition timestamps must include a timezone.")
    return value.astimezone(timezone.utc)
