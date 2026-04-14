import uuid
from datetime import datetime

from schemas import CandidateLifecycleStatus, PaperBotStatus
from services.candidate_repo import (
    get_candidate as get_candidate_db,
    get_candidate_by_run as get_candidate_by_run_db,
    list_candidates as list_candidates_db,
    save_candidate as save_candidate_db,
)
from services.candidate_store import (
    get_candidate as get_candidate_mem,
    get_candidate_by_run as get_candidate_by_run_mem,
    list_candidates as list_candidates_mem,
    upsert_candidate as upsert_candidate_mem,
)
from services.experiment_service import (
    get_experiment_any,
    get_experiment_run,
    update_experiment_run_candidate_state,
)

APPROVEDISH_STATUSES = {
    CandidateLifecycleStatus.APPROVED.value,
    CandidateLifecycleStatus.PAPER_READY.value,
    CandidateLifecycleStatus.PAPER_RUNNING.value,
    CandidateLifecycleStatus.PAPER_PAUSED.value,
}
PAPER_STAGE_STATUSES = {
    CandidateLifecycleStatus.PAPER_READY.value,
    CandidateLifecycleStatus.PAPER_RUNNING.value,
    CandidateLifecycleStatus.PAPER_PAUSED.value,
}
CANDIDATE_TRANSITIONS = {
    CandidateLifecycleStatus.CANDIDATE.value: {
        CandidateLifecycleStatus.APPROVED.value,
        CandidateLifecycleStatus.REJECTED.value,
    },
    CandidateLifecycleStatus.APPROVED.value: {
        CandidateLifecycleStatus.PAPER_READY.value,
        CandidateLifecycleStatus.REJECTED.value,
    },
    CandidateLifecycleStatus.PAPER_READY.value: {
        CandidateLifecycleStatus.PAPER_RUNNING.value,
        CandidateLifecycleStatus.PAPER_PAUSED.value,
        CandidateLifecycleStatus.REJECTED.value,
    },
    CandidateLifecycleStatus.PAPER_RUNNING.value: {
        CandidateLifecycleStatus.PAPER_PAUSED.value,
        CandidateLifecycleStatus.REJECTED.value,
    },
    CandidateLifecycleStatus.PAPER_PAUSED.value: {
        CandidateLifecycleStatus.PAPER_RUNNING.value,
        CandidateLifecycleStatus.REJECTED.value,
    },
    CandidateLifecycleStatus.REJECTED.value: set(),
}
PAPER_BOT_TRANSITIONS = {
    PaperBotStatus.DRAFT.value: {PaperBotStatus.READY.value},
    PaperBotStatus.READY.value: {PaperBotStatus.PAPER_RUNNING.value, PaperBotStatus.STOPPED.value},
    PaperBotStatus.PAPER_RUNNING.value: {PaperBotStatus.STOPPED.value},
    PaperBotStatus.STOPPED.value: {PaperBotStatus.READY.value, PaperBotStatus.PAPER_RUNNING.value},
}


def list_candidates_any() -> list[dict]:
    source = list_candidates_db() if _db_required() else list_candidates_mem()
    return sorted(source, key=lambda candidate: candidate.get("updated_at", ""), reverse=True)


def get_candidate_any(candidate_id: str) -> dict | None:
    if _db_required():
        return get_candidate_db(candidate_id)
    return get_candidate_mem(candidate_id)


def get_candidate_by_run_any(experiment_run_id: str) -> dict | None:
    if _db_required():
        return get_candidate_by_run_db(experiment_run_id)
    return get_candidate_by_run_mem(experiment_run_id)


def promote_experiment_run_candidate(
    experiment_id: str,
    experiment_run_id: str,
    *,
    actor: str = "local-user",
) -> dict:
    """Turn one ranked experiment result into a durable Phase 2 candidate.

    The candidate keeps a frozen snapshot of the experiment/run/backtest context
    so later review, approval, and paper-bot work doesn't disappear the next
    time somebody reruns the sweep.
    """
    experiment = get_experiment_any(experiment_id)
    if experiment is None:
        raise LookupError(f"Experiment '{experiment_id}' not found.")

    run = get_experiment_run(experiment_id, experiment_run_id)
    if run is None:
        raise LookupError(
            f"Experiment run '{experiment_run_id}' was not found in experiment '{experiment_id}'."
        )
    if run["status"] != "completed" or not run.get("backtest_id"):
        raise ValueError("Only completed runs with saved backtests can become candidates.")

    now = _now()
    existing = get_candidate_by_run_any(experiment_run_id)
    if existing is None:
        candidate = _build_candidate_payload(experiment, run, actor=actor, now=now)
        candidate["audit_log"] = [
            _make_event(
                event_type="promoted",
                actor=actor,
                summary=f"Promoted run #{run.get('rank') or 'n/a'} into the candidate registry.",
                created_at=now,
                changes={
                    "lifecycle_status": {
                        "from": None,
                        "to": candidate["lifecycle_status"],
                    },
                    "backtest_id": candidate["backtest_id"],
                },
            )
        ]
    else:
        candidate = {
            **existing,
            **_candidate_snapshot_fields(experiment, run),
            "promotion_reason": _build_promotion_reason(experiment, run),
            "updated_at": now,
        }
        previous_status = existing["lifecycle_status"]
        if previous_status == CandidateLifecycleStatus.REJECTED.value:
            candidate["lifecycle_status"] = CandidateLifecycleStatus.CANDIDATE.value
            candidate["promoted_by"] = actor
            candidate["promoted_at"] = now
            summary = "Re-promoted a previously rejected candidate."
            changes = {
                "lifecycle_status": {
                    "from": previous_status,
                    "to": candidate["lifecycle_status"],
                }
            }
        else:
            summary = "Refreshed the saved candidate snapshot from the ranked experiment run."
            changes = {
                "score": candidate.get("score"),
                "rank": candidate.get("rank"),
                "backtest_id": candidate["backtest_id"],
            }
        candidate["audit_log"] = _append_audit(
            candidate,
            _make_event(
                event_type="promoted",
                actor=actor,
                summary=summary,
                created_at=now,
                changes=changes,
            ),
        )

    saved = _save_candidate_any(candidate)
    updated_run = update_experiment_run_candidate_state(
        experiment_id,
        experiment_run_id,
        candidate_id=saved["candidate_id"],
        is_candidate=True,
        promoted_at=saved["promoted_at"],
        strict=True,
    )
    if updated_run is None:
        raise LookupError(
            f"Experiment run '{experiment_run_id}' was not found in experiment '{experiment_id}'."
        )
    return updated_run


def reject_experiment_run_candidate(
    experiment_id: str,
    experiment_run_id: str,
    *,
    actor: str = "local-user",
) -> dict:
    candidate = get_candidate_by_run_any(experiment_run_id)
    if candidate is None:
        updated_run = update_experiment_run_candidate_state(
            experiment_id,
            experiment_run_id,
            candidate_id=None,
            is_candidate=False,
            promoted_at=None,
            strict=True,
        )
        if updated_run is None:
            raise LookupError(
                f"Experiment run '{experiment_run_id}' was not found in experiment '{experiment_id}'."
            )
        return updated_run

    update_candidate_status(
        candidate["candidate_id"],
        CandidateLifecycleStatus.REJECTED.value,
        actor=actor,
    )
    updated_run = get_experiment_run(experiment_id, experiment_run_id)
    if updated_run is None:
        raise LookupError(
            f"Experiment run '{experiment_run_id}' was not found in experiment '{experiment_id}'."
        )
    return updated_run


def update_candidate_status(candidate_id: str, status: str, *, actor: str = "local-user") -> dict:
    candidate = _require_candidate(candidate_id)
    next_status = status.strip()

    if next_status == candidate["lifecycle_status"]:
        return candidate

    allowed = CANDIDATE_TRANSITIONS.get(candidate["lifecycle_status"], set())
    if next_status not in allowed:
        raise ValueError(
            f"Can't move candidate from '{candidate['lifecycle_status']}' to '{next_status}'."
        )
    if next_status in PAPER_STAGE_STATUSES and not candidate.get("paper_bot"):
        raise ValueError("Create the paper bot draft first so the paper-ready stage has somewhere to land.")

    now = _now()
    previous_status = candidate["lifecycle_status"]
    candidate["lifecycle_status"] = next_status
    if next_status in APPROVEDISH_STATUSES and not candidate.get("approved_at"):
        candidate["approved_at"] = now
        candidate["approved_by"] = actor

    if candidate.get("paper_bot"):
        synced_status = _candidate_status_to_paper_bot_status(next_status)
        if synced_status is not None:
            candidate["paper_bot"]["status"] = synced_status
            candidate["paper_bot"]["updated_at"] = now

    candidate["updated_at"] = now
    candidate["audit_log"] = _append_audit(
        candidate,
        _make_event(
            event_type="status_changed",
            actor=actor,
            summary=f"Moved candidate from `{previous_status}` to `{next_status}`.",
            created_at=now,
            changes={"lifecycle_status": {"from": previous_status, "to": next_status}},
        ),
    )

    saved = _save_candidate_any(candidate)
    update_experiment_run_candidate_state(
        saved["experiment_id"],
        saved["experiment_run_id"],
        candidate_id=saved["candidate_id"],
        is_candidate=next_status != CandidateLifecycleStatus.REJECTED.value,
        promoted_at=saved["promoted_at"] if next_status != CandidateLifecycleStatus.REJECTED.value else None,
        strict=False,
    )
    return saved


def add_candidate_note(candidate_id: str, body: str, *, author: str = "local-user") -> dict:
    candidate = _require_candidate(candidate_id)
    note_body = body.strip()
    if not note_body:
        raise ValueError("Notes can't be empty.")

    now = _now()
    note = {
        "note_id": str(uuid.uuid4()),
        "body": note_body,
        "author": author,
        "created_at": now,
    }

    candidate["notes"] = [*(candidate.get("notes") or []), note]
    candidate["updated_at"] = now
    candidate["audit_log"] = _append_audit(
        candidate,
        _make_event(
            event_type="note_added",
            actor=author,
            summary="Added a review note.",
            created_at=now,
            changes={"note_id": note["note_id"]},
        ),
    )
    return _save_candidate_any(candidate)


def create_paper_bot_from_candidate(candidate_id: str, *, actor: str = "local-user") -> dict:
    candidate = _require_candidate(candidate_id)
    if candidate["lifecycle_status"] == CandidateLifecycleStatus.REJECTED.value:
        raise ValueError("Rejected candidates can't spawn paper bot drafts.")
    if candidate.get("paper_bot"):
        return candidate

    now = _now()
    candidate["paper_bot"] = {
        "paper_bot_id": str(uuid.uuid4()),
        "candidate_id": candidate["candidate_id"],
        "symbol": candidate["symbol"],
        "interval": candidate["interval"],
        "strategy_type": candidate["strategy_type"],
        "strategy_params": candidate.get("strategy_params") or {},
        "guardrails": {
            "prop_firm_rules": candidate.get("prop_firm_rules") or {},
            "required_prop_pass": bool(candidate.get("passed")),
            "max_drawdown_seen": candidate.get("max_drawdown"),
            "profit_factor_seen": candidate.get("profit_factor"),
        },
        "status": PaperBotStatus.DRAFT.value,
        "created_at": now,
        "updated_at": now,
    }
    candidate["updated_at"] = now
    candidate["audit_log"] = _append_audit(
        candidate,
        _make_event(
            event_type="paper_bot_created",
            actor=actor,
            summary="Created the paper bot draft from this candidate.",
            created_at=now,
            changes={"paper_bot_status": PaperBotStatus.DRAFT.value},
        ),
    )
    return _save_candidate_any(candidate)


def update_candidate_paper_bot_status(
    candidate_id: str,
    status: str,
    *,
    actor: str = "local-user",
) -> dict:
    candidate = _require_candidate(candidate_id)
    if candidate["lifecycle_status"] == CandidateLifecycleStatus.REJECTED.value:
        raise ValueError("Rejected candidates can't move paper bot state.")

    paper_bot = candidate.get("paper_bot")
    if paper_bot is None:
        raise ValueError("Create the paper bot draft first.")

    next_status = status.strip()
    previous_status = paper_bot["status"]
    if next_status == previous_status:
        return candidate

    allowed = PAPER_BOT_TRANSITIONS.get(previous_status, set())
    if next_status not in allowed:
        raise ValueError(f"Can't move paper bot from '{previous_status}' to '{next_status}'.")

    now = _now()
    paper_bot["status"] = next_status
    paper_bot["updated_at"] = now
    candidate["paper_bot"] = paper_bot

    next_candidate_status = _paper_bot_status_to_candidate_status(
        candidate["lifecycle_status"],
        next_status,
    )
    if next_candidate_status in APPROVEDISH_STATUSES and not candidate.get("approved_at"):
        candidate["approved_at"] = now
        candidate["approved_by"] = actor
    candidate["lifecycle_status"] = next_candidate_status
    candidate["updated_at"] = now
    candidate["audit_log"] = _append_audit(
        candidate,
        _make_event(
            event_type="paper_bot_status_changed",
            actor=actor,
            summary=f"Moved paper bot from `{previous_status}` to `{next_status}`.",
            created_at=now,
            changes={
                "paper_bot_status": {"from": previous_status, "to": next_status},
                "candidate_status": next_candidate_status,
            },
        ),
    )

    saved = _save_candidate_any(candidate)
    update_experiment_run_candidate_state(
        saved["experiment_id"],
        saved["experiment_run_id"],
        candidate_id=saved["candidate_id"],
        is_candidate=saved["lifecycle_status"] != CandidateLifecycleStatus.REJECTED.value,
        promoted_at=saved["promoted_at"],
        strict=False,
    )
    return saved


def _build_candidate_payload(experiment: dict, run: dict, *, actor: str, now: str) -> dict:
    return {
        "candidate_id": str(uuid.uuid4()),
        "experiment_id": experiment["experiment_id"],
        "experiment_name": experiment["name"],
        "experiment_run_id": run["experiment_run_id"],
        "backtest_id": run["backtest_id"],
        "symbol": run["symbol"],
        "interval": run["interval"],
        "strategy_type": run["strategy_type"],
        "strategy_params": run.get("strategy_params") or {},
        "prop_firm_rules": experiment.get("prop_firm_rules") or {},
        "experiment_snapshot": {
            "name": experiment["name"],
            "symbols": experiment.get("symbols") or [],
            "intervals": experiment.get("intervals") or [],
            "start_date": experiment.get("start_date"),
            "end_date": experiment.get("end_date"),
            "scoring_rule": experiment.get("scoring_rule"),
            "status": experiment.get("status"),
            "created_at": experiment.get("created_at"),
            "last_run_at": experiment.get("last_run_at"),
        },
        "score": run.get("score"),
        "rank": run.get("rank"),
        "total_pnl": run.get("total_pnl"),
        "win_rate": run.get("win_rate"),
        "max_drawdown": run.get("max_drawdown"),
        "profit_factor": run.get("profit_factor"),
        "passed": run.get("passed"),
        "metrics": run.get("metrics"),
        "prop_firm_eval": run.get("prop_firm_eval"),
        "lifecycle_status": CandidateLifecycleStatus.CANDIDATE.value,
        "promotion_reason": _build_promotion_reason(experiment, run),
        "promoted_by": actor,
        "promoted_at": now,
        "approved_by": None,
        "approved_at": None,
        "paper_bot": None,
        "notes": [],
        "audit_log": [],
        "created_at": now,
        "updated_at": now,
    }


def _candidate_snapshot_fields(experiment: dict, run: dict) -> dict:
    return {
        "experiment_id": experiment["experiment_id"],
        "experiment_name": experiment["name"],
        "experiment_run_id": run["experiment_run_id"],
        "backtest_id": run["backtest_id"],
        "symbol": run["symbol"],
        "interval": run["interval"],
        "strategy_type": run["strategy_type"],
        "strategy_params": run.get("strategy_params") or {},
        "prop_firm_rules": experiment.get("prop_firm_rules") or {},
        "experiment_snapshot": {
            "name": experiment["name"],
            "symbols": experiment.get("symbols") or [],
            "intervals": experiment.get("intervals") or [],
            "start_date": experiment.get("start_date"),
            "end_date": experiment.get("end_date"),
            "scoring_rule": experiment.get("scoring_rule"),
            "status": experiment.get("status"),
            "created_at": experiment.get("created_at"),
            "last_run_at": experiment.get("last_run_at"),
        },
        "score": run.get("score"),
        "rank": run.get("rank"),
        "total_pnl": run.get("total_pnl"),
        "win_rate": run.get("win_rate"),
        "max_drawdown": run.get("max_drawdown"),
        "profit_factor": run.get("profit_factor"),
        "passed": run.get("passed"),
        "metrics": run.get("metrics"),
        "prop_firm_eval": run.get("prop_firm_eval"),
    }


def _build_promotion_reason(experiment: dict, run: dict) -> str:
    score = run.get("score")
    rank = run.get("rank")
    total_pnl = run.get("total_pnl")
    prop_pass = "passed" if run.get("passed") else "failed"
    rank_text = f"rank #{rank}" if rank is not None else "an unranked finished run"
    score_text = f"{score:.2f}" if isinstance(score, (int, float)) else "n/a"
    if isinstance(total_pnl, (int, float)):
        pnl_text = f"{'+' if total_pnl >= 0 else '-'}${abs(total_pnl):.2f}"
    else:
        pnl_text = "n/a"

    return (
        f"Promoted from `{experiment['name']}` as {rank_text}. "
        f"It {prop_pass} the prop check with score {score_text} and {pnl_text} total PnL."
    )


def _paper_bot_status_to_candidate_status(current_candidate_status: str, next_paper_status: str) -> str:
    if next_paper_status == PaperBotStatus.READY.value:
        return CandidateLifecycleStatus.PAPER_READY.value
    if next_paper_status == PaperBotStatus.PAPER_RUNNING.value:
        return CandidateLifecycleStatus.PAPER_RUNNING.value
    if current_candidate_status in PAPER_STAGE_STATUSES:
        return CandidateLifecycleStatus.PAPER_PAUSED.value
    return CandidateLifecycleStatus.APPROVED.value


def _candidate_status_to_paper_bot_status(candidate_status: str) -> str | None:
    if candidate_status == CandidateLifecycleStatus.PAPER_READY.value:
        return PaperBotStatus.READY.value
    if candidate_status == CandidateLifecycleStatus.PAPER_RUNNING.value:
        return PaperBotStatus.PAPER_RUNNING.value
    if candidate_status == CandidateLifecycleStatus.PAPER_PAUSED.value:
        return PaperBotStatus.STOPPED.value
    return None


def _append_audit(candidate: dict, event: dict) -> list[dict]:
    return [*(candidate.get("audit_log") or []), event]


def _make_event(
    *,
    event_type: str,
    actor: str,
    summary: str,
    created_at: str,
    changes: dict | None = None,
) -> dict:
    return {
        "event_id": str(uuid.uuid4()),
        "event_type": event_type,
        "actor": actor,
        "summary": summary,
        "changes": changes or {},
        "created_at": created_at,
    }


def _require_candidate(candidate_id: str) -> dict:
    candidate = get_candidate_any(candidate_id)
    if candidate is None:
        raise LookupError(f"Candidate '{candidate_id}' not found.")
    return candidate


def _save_candidate_any(candidate: dict) -> dict:
    if _db_required():
        save_candidate_db(candidate)
    upsert_candidate_mem(candidate["candidate_id"], candidate)
    return candidate


def _now() -> str:
    return datetime.utcnow().isoformat()


def _db_required() -> bool:
    from services.db import db_configured

    return db_configured()
