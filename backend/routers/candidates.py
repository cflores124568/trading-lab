from fastapi import APIRouter, HTTPException

from schemas import (
    CandidateNoteCreate,
    CandidatePaperBotCreate,
    CandidatePaperBotStatusUpdate,
    CandidateResult,
    CandidateStatusUpdate,
)
from services.candidate_service import (
    add_candidate_note,
    create_paper_bot_from_candidate,
    get_candidate_any,
    list_candidates_any,
    update_candidate_paper_bot_status,
    update_candidate_status,
)

router = APIRouter()


@router.get("/", response_model=list[CandidateResult])
async def list_candidates():
    try:
        return list_candidates_any()
    except Exception as exc:
        raise HTTPException(status_code=503, detail=f"Candidate storage unavailable: {exc}")


@router.get("/{candidate_id}", response_model=CandidateResult)
async def get_candidate(candidate_id: str):
    try:
        candidate = get_candidate_any(candidate_id)
    except Exception as exc:
        raise HTTPException(status_code=503, detail=f"Candidate storage unavailable: {exc}")

    if candidate is None:
        raise HTTPException(status_code=404, detail=f"Candidate '{candidate_id}' not found.")

    return candidate


@router.patch("/{candidate_id}/status", response_model=CandidateResult)
async def patch_candidate_status(candidate_id: str, request: CandidateStatusUpdate):
    try:
        return update_candidate_status(candidate_id, request.status.value, actor=request.actor)
    except LookupError as exc:
        raise HTTPException(status_code=404, detail=str(exc))
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    except Exception as exc:
        raise HTTPException(status_code=503, detail=f"Candidate status update failed: {exc}")


@router.post("/{candidate_id}/notes", response_model=CandidateResult)
async def create_candidate_note(candidate_id: str, request: CandidateNoteCreate):
    try:
        return add_candidate_note(candidate_id, request.body, author=request.author)
    except LookupError as exc:
        raise HTTPException(status_code=404, detail=str(exc))
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    except Exception as exc:
        raise HTTPException(status_code=503, detail=f"Candidate note save failed: {exc}")


@router.post("/{candidate_id}/paper-bot", response_model=CandidateResult)
async def create_candidate_paper_bot(candidate_id: str, request: CandidatePaperBotCreate):
    try:
        return create_paper_bot_from_candidate(candidate_id, actor=request.actor)
    except LookupError as exc:
        raise HTTPException(status_code=404, detail=str(exc))
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    except Exception as exc:
        raise HTTPException(status_code=503, detail=f"Paper bot draft create failed: {exc}")


@router.patch("/{candidate_id}/paper-bot/status", response_model=CandidateResult)
async def patch_candidate_paper_bot_status(
    candidate_id: str,
    request: CandidatePaperBotStatusUpdate,
):
    try:
        return update_candidate_paper_bot_status(candidate_id, request.status.value, actor=request.actor)
    except LookupError as exc:
        raise HTTPException(status_code=404, detail=str(exc))
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    except Exception as exc:
        raise HTTPException(status_code=503, detail=f"Paper bot status update failed: {exc}")
