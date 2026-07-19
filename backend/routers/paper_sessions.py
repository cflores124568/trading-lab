from fastapi import APIRouter, HTTPException

from schemas import (
    PaperDecisionResolutionRequest,
    PaperEventCreate,
    PaperEventResult,
    PaperKillSwitchRequest,
    PaperRunnerPauseRequest,
    PaperRunnerStartRequest,
    PaperRunnerStepRequest,
    PaperSessionExecutionRequest,
    PaperSessionResult,
    PaperSessionStatusUpdate,
    PaperSessionSummary,
)
from services.paper_runner_service import (
    pause_historical_runner,
    resolve_pending_policy_decision,
    set_runner_kill_switch,
    start_historical_runner,
    step_historical_runner,
)
from services.paper_session_service import (
    add_paper_session_event,
    execute_paper_session_action,
    get_paper_session_any,
    list_paper_events_any,
    list_paper_sessions_any,
    update_paper_session_status,
)

router = APIRouter()


@router.get("/", response_model=list[PaperSessionSummary])
async def list_paper_sessions():
    try:
        source = list_paper_sessions_any()
    except Exception as exc:
        raise HTTPException(status_code=503, detail=f"Paper session storage unavailable: {exc}")

    return source


@router.get("/{paper_session_id}", response_model=PaperSessionResult)
async def get_paper_session(paper_session_id: str):
    try:
        session = get_paper_session_any(paper_session_id)
    except Exception as exc:
        raise HTTPException(status_code=503, detail=f"Paper session storage unavailable: {exc}")

    if session is None:
        raise HTTPException(status_code=404, detail=f"Paper session '{paper_session_id}' not found.")

    return session


@router.get("/{paper_session_id}/events", response_model=list[PaperEventResult])
async def list_paper_session_events(paper_session_id: str):
    try:
        session = get_paper_session_any(paper_session_id)
        if session is None:
            raise HTTPException(status_code=404, detail=f"Paper session '{paper_session_id}' not found.")
        return list_paper_events_any(paper_session_id)
    except HTTPException:
        raise
    except Exception as exc:
        raise HTTPException(status_code=503, detail=f"Paper event storage unavailable: {exc}")


@router.patch("/{paper_session_id}/status", response_model=PaperSessionResult)
async def patch_paper_session_status(
    paper_session_id: str,
    request: PaperSessionStatusUpdate,
):
    try:
        return update_paper_session_status(
            paper_session_id,
            request.status.value,
            actor=request.actor,
            summary=request.summary,
        )
    except LookupError as exc:
        raise HTTPException(status_code=404, detail=str(exc))
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    except Exception as exc:
        raise HTTPException(status_code=503, detail=f"Paper session status update failed: {exc}")


@router.post("/{paper_session_id}/events", response_model=PaperEventResult)
async def create_paper_session_event(
    paper_session_id: str,
    request: PaperEventCreate,
):
    try:
        return add_paper_session_event(
            paper_session_id,
            event_type=request.event_type,
            summary=request.summary,
            actor=request.actor,
            payload=request.payload,
        )
    except LookupError as exc:
        raise HTTPException(status_code=404, detail=str(exc))
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    except Exception as exc:
        raise HTTPException(status_code=503, detail=f"Paper event append failed: {exc}")


@router.post("/{paper_session_id}/execute", response_model=PaperSessionResult)
async def execute_session_action(
    paper_session_id: str,
    request: PaperSessionExecutionRequest,
):
    try:
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
    except LookupError as exc:
        raise HTTPException(status_code=404, detail=str(exc))
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    except Exception as exc:
        raise HTTPException(status_code=503, detail=f"Paper session execution failed: {exc}")


@router.post("/{paper_session_id}/runner/start", response_model=PaperSessionResult)
async def start_session_runner(
    paper_session_id: str,
    request: PaperRunnerStartRequest,
):
    try:
        return start_historical_runner(
            paper_session_id,
            actor=request.actor,
            start_date=request.start_date,
            end_date=request.end_date,
            poll_interval_ms=request.poll_interval_ms,
            reset_cursor=request.reset_cursor,
            policy_mode=request.policy_mode,
        )
    except LookupError as exc:
        raise HTTPException(status_code=404, detail=str(exc))
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    except RuntimeError as exc:
        raise HTTPException(status_code=503, detail=str(exc))
    except Exception as exc:
        raise HTTPException(status_code=503, detail=f"Paper session runner start failed: {exc}")


@router.post("/{paper_session_id}/runner/pause", response_model=PaperSessionResult)
async def pause_session_runner(
    paper_session_id: str,
    request: PaperRunnerPauseRequest,
):
    try:
        return pause_historical_runner(
            paper_session_id,
            actor=request.actor,
            summary=request.summary,
        )
    except LookupError as exc:
        raise HTTPException(status_code=404, detail=str(exc))
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    except Exception as exc:
        raise HTTPException(status_code=503, detail=f"Paper session runner pause failed: {exc}")


@router.post("/{paper_session_id}/runner/step", response_model=PaperSessionResult)
async def step_session_runner(
    paper_session_id: str,
    request: PaperRunnerStepRequest,
):
    try:
        return step_historical_runner(
            paper_session_id,
            actor=request.actor,
            steps=request.steps,
        )
    except LookupError as exc:
        raise HTTPException(status_code=404, detail=str(exc))
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    except RuntimeError as exc:
        raise HTTPException(status_code=503, detail=str(exc))
    except Exception as exc:
        raise HTTPException(status_code=503, detail=f"Paper session runner step failed: {exc}")


@router.post("/{paper_session_id}/runner/decision/resolve", response_model=PaperSessionResult)
async def resolve_session_policy_decision(
    paper_session_id: str,
    request: PaperDecisionResolutionRequest,
):
    try:
        return resolve_pending_policy_decision(
            paper_session_id,
            approved=request.approved,
            actor=request.actor,
            note=request.note,
        )
    except LookupError as exc:
        raise HTTPException(status_code=404, detail=str(exc))
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    except Exception as exc:
        raise HTTPException(status_code=503, detail=f"Paper policy decision resolution failed: {exc}")


@router.post("/{paper_session_id}/runner/kill-switch", response_model=PaperSessionResult)
async def update_session_kill_switch(
    paper_session_id: str,
    request: PaperKillSwitchRequest,
):
    try:
        return set_runner_kill_switch(
            paper_session_id,
            engaged=request.engaged,
            actor=request.actor,
            reason=request.reason,
        )
    except LookupError as exc:
        raise HTTPException(status_code=404, detail=str(exc))
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    except Exception as exc:
        raise HTTPException(status_code=503, detail=f"Paper runner kill switch update failed: {exc}")
