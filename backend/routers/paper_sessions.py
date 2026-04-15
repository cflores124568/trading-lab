from fastapi import APIRouter, HTTPException

from schemas import (
    PaperEventCreate,
    PaperEventResult,
    PaperSessionResult,
    PaperSessionStatusUpdate,
    PaperSessionSummary,
)
from services.paper_session_service import (
    add_paper_session_event,
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

    return [
        {
            "paper_session_id": session["paper_session_id"],
            "candidate_id": session["candidate_id"],
            "name": session["name"],
            "symbol": session["symbol"],
            "interval": session["interval"],
            "status": session["status"],
            "last_event_at": session.get("last_event_at"),
            "created_at": session["created_at"],
            "updated_at": session["updated_at"],
        }
        for session in source
    ]


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
