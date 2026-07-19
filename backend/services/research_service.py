import hashlib
import json
import uuid
from datetime import datetime, timezone
from itertools import product
from typing import Any

from schemas import ResearchCampaignControlRequest, ResearchCampaignCreate, ResearchCampaignQueueRequest, ResearchTrialCreate
from services.data_loader import normalise_interval
from services.research_partition_service import calculate_chronological_partitions
from services import research_repo
from services import research_campaign_runtime_repo


MAX_TRIAL_SPEC_BYTES = 64 * 1024


def create_campaign(request: ResearchCampaignCreate) -> dict:
    start_time = _aware_utc(request.start_time, "start_time")
    end_time = _aware_utc(request.end_time, "end_time")
    if start_time > end_time:
        raise ValueError("start_time must be earlier than or equal to end_time.")

    symbol = request.symbol.strip().upper()
    interval = normalise_interval(request.interval)
    timestamps = research_repo.list_research_bar_timestamps(
        symbol=symbol,
        interval=interval,
        start_time=start_time,
        end_time=end_time,
    )
    partitions = calculate_chronological_partitions(
        timestamps,
        development_pct=request.development_pct,
        validation_pct=request.validation_pct,
        holdout_pct=request.holdout_pct,
    )

    now = datetime.now(timezone.utc)
    campaign_id = str(uuid.uuid4())
    campaign = {
        "campaign_id": campaign_id,
        "name": request.name.strip(),
        "symbol": symbol,
        "interval": interval,
        "start_time": start_time,
        "end_time": end_time,
        "development_pct": request.development_pct,
        "validation_pct": request.validation_pct,
        "holdout_pct": request.holdout_pct,
        "status": "draft",
        "total_bar_count": len(timestamps),
        "created_by": request.created_by.strip(),
        "created_at": now,
        "updated_at": now,
    }
    event = _event(
        campaign_id=campaign_id,
        event_type="campaign_created",
        actor=campaign["created_by"],
        summary="Created a draft Alpha Lab research campaign with sealed chronological partitions.",
        payload={
            "symbol": symbol,
            "interval": interval,
            "total_bar_count": len(timestamps),
            "partitions": [_json_partition(partition) for partition in partitions],
        },
        created_at=now,
    )
    return research_repo.create_research_campaign(campaign, partitions, event)


def list_campaigns(*, limit: int, offset: int, status: str | None = None) -> list[dict]:
    return research_repo.list_research_campaigns(limit=limit, offset=offset, status=status)


def get_campaign(campaign_id: str) -> dict | None:
    return research_repo.get_research_campaign(campaign_id)


def register_trial(campaign_id: str, request: ResearchTrialCreate) -> dict:
    campaign = research_repo.get_research_campaign(campaign_id, event_limit=1)
    if campaign is None:
        raise LookupError(f"Research campaign '{campaign_id}' not found.")

    spec = {
        "campaign_id": campaign_id,
        "strategy_type": request.strategy_type.value,
        "strategy_params": request.strategy_params,
        "execution_config": request.execution_config,
        "random_seed": request.random_seed,
    }
    encoded = _canonical_json(spec)
    if len(encoded) > MAX_TRIAL_SPEC_BYTES:
        raise ValueError(f"Trial specification exceeds the {MAX_TRIAL_SPEC_BYTES}-byte limit.")

    now = datetime.now(timezone.utc)
    fingerprint = hashlib.sha256(encoded).hexdigest()
    trial = {
        "trial_id": str(uuid.uuid4()),
        "campaign_id": campaign_id,
        "fingerprint": fingerprint,
        "strategy_type": request.strategy_type.value,
        "strategy_params": request.strategy_params,
        "execution_config": request.execution_config,
        "random_seed": request.random_seed,
        "status": request.status.value,
        "result": request.result,
        "error": request.error,
        "created_by": request.created_by.strip(),
        "created_at": now,
        "completed_at": now,
    }
    event = _event(
        campaign_id=campaign_id,
        event_type="trial_recorded",
        actor=trial["created_by"],
        summary=f"Recorded {trial['status']} research trial {trial['trial_id']}.",
        payload={
            "trial_id": trial["trial_id"],
            "fingerprint": fingerprint,
            "status": trial["status"],
        },
        created_at=now,
    )
    result, _ = research_repo.create_research_trial(trial, event)
    return result


def list_trials(
    campaign_id: str,
    *,
    limit: int,
    offset: int,
    status: str | None = None,
) -> list[dict]:
    if research_repo.get_research_campaign(campaign_id, event_limit=1) is None:
        raise LookupError(f"Research campaign '{campaign_id}' not found.")
    return research_repo.list_research_trials(
        campaign_id,
        limit=limit,
        offset=offset,
        status=status,
    )


def get_trial(campaign_id: str, trial_id: str) -> dict | None:
    return research_repo.get_research_trial(campaign_id, trial_id)


def queue_campaign(campaign_id: str, request: ResearchCampaignQueueRequest) -> dict:
    campaign = research_repo.get_research_campaign(campaign_id, event_limit=1)
    if campaign is None:
        raise LookupError(f"Research campaign '{campaign_id}' not found.")
    plans = expand_search_plans(request.strategy_type.value, request.parameter_space)
    planned = min(len(plans), request.trial_budget)
    config = {
        "strategy_type": request.strategy_type.value,
        "parameter_space": _normalized_search_space(request.parameter_space),
        "execution_config": request.execution_config,
    }
    progress = {"next_plan_index": 0, "attempted_trials": 0, "completed_trials": 0, "failed_trials": 0,
                "planned_trials": planned, "total_search_space": len(plans), "terminal_reason": None}
    now = datetime.now(timezone.utc)
    event = _event(campaign_id=campaign_id, event_type="campaign_queued", actor=request.actor,
                   summary=f"Queued deterministic research search with a {planned}-trial budget.",
                   payload={"trial_budget": request.trial_budget, "wall_clock_budget_seconds": request.wall_clock_budget_seconds,
                            "planned_trials": planned, "total_search_space": len(plans)}, created_at=now)
    stored = research_campaign_runtime_repo.configure_and_queue(
        campaign_id, search_config=config, trial_budget=request.trial_budget,
        wall_seconds=request.wall_clock_budget_seconds, progress=progress, event=event)
    if stored is None: raise ValueError("Only draft or paused campaigns can be configured and queued.")
    return research_repo.get_research_campaign(campaign_id)


def pause_campaign(campaign_id: str, request: ResearchCampaignControlRequest) -> dict:
    now=datetime.now(timezone.utc); event=_event(campaign_id=campaign_id,event_type="campaign_paused",actor=request.actor,
        summary="Paused the durable research campaign and revoked its lease.",payload={},created_at=now)
    if research_repo.get_research_campaign(campaign_id,event_limit=1) is None: raise LookupError(f"Research campaign '{campaign_id}' not found.")
    stored=research_campaign_runtime_repo.pause_campaign(campaign_id,event)
    if stored is None: raise ValueError("Only queued or running campaigns can be paused.")
    return research_repo.get_research_campaign(campaign_id)


def resume_campaign(campaign_id: str, request: ResearchCampaignControlRequest) -> dict:
    now=datetime.now(timezone.utc); event=_event(campaign_id=campaign_id,event_type="campaign_resumed",actor=request.actor,
        summary="Re-queued the paused research campaign from its durable cursor.",payload={},created_at=now)
    if research_repo.get_research_campaign(campaign_id,event_limit=1) is None: raise LookupError(f"Research campaign '{campaign_id}' not found.")
    stored=research_campaign_runtime_repo.resume_campaign(campaign_id,event)
    if stored is None: raise ValueError("Only configured paused campaigns can be resumed.")
    return research_repo.get_research_campaign(campaign_id)


def expand_search_plans(strategy_type: str, parameter_space: dict[str, list[Any]]) -> list[dict]:
    normalized = _normalized_search_space(parameter_space)
    if not normalized: return [{"strategy_type": strategy_type, "strategy_params": {}}]
    keys=sorted(normalized)
    return [{"strategy_type": strategy_type, "strategy_params": dict(zip(keys, values))}
            for values in product(*(normalized[key] for key in keys))]


def _normalized_search_space(space: dict[str, list[Any]]) -> dict[str, list[Any]]:
    normalized={}
    for key in sorted(space):
        values=[]; seen=set()
        for value in space[key]:
            marker=json.dumps(value,sort_keys=True,separators=(",",":"),allow_nan=False)
            if marker not in seen: values.append(value); seen.add(marker)
        if not values: raise ValueError(f"parameter_space['{key}'] must contain at least one value.")
        normalized[key.strip()]=values
    return normalized


def trial_fingerprint(
    *,
    campaign_id: str,
    strategy_type: str,
    strategy_params: dict[str, Any],
    execution_config: dict[str, Any],
    random_seed: int,
) -> str:
    spec = {
        "campaign_id": campaign_id,
        "strategy_type": strategy_type,
        "strategy_params": strategy_params,
        "execution_config": execution_config,
        "random_seed": random_seed,
    }
    return hashlib.sha256(_canonical_json(spec)).hexdigest()


def _canonical_json(value: Any) -> bytes:
    try:
        return json.dumps(
            value,
            sort_keys=True,
            separators=(",", ":"),
            ensure_ascii=False,
            allow_nan=False,
        ).encode("utf-8")
    except (TypeError, ValueError) as exc:
        raise ValueError(f"Trial specification must be canonical JSON: {exc}") from exc


def _aware_utc(value: datetime, field_name: str) -> datetime:
    if value.tzinfo is None or value.utcoffset() is None:
        raise ValueError(f"{field_name} must include a timezone.")
    return value.astimezone(timezone.utc)


def _event(
    *,
    campaign_id: str,
    event_type: str,
    actor: str,
    summary: str,
    payload: dict,
    created_at: datetime,
) -> dict:
    return {
        "research_campaign_event_id": str(uuid.uuid4()),
        "campaign_id": campaign_id,
        "event_type": event_type,
        "actor": actor,
        "summary": summary,
        "payload": payload,
        "created_at": created_at,
    }


def _json_partition(partition: dict) -> dict:
    return {
        **partition,
        "start_time": partition["start_time"].isoformat(),
        "end_time": partition["end_time"].isoformat(),
    }
