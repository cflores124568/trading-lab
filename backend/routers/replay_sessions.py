import uuid
from datetime import datetime

from fastapi import APIRouter, HTTPException

from schemas import (
    ReplaySessionCreate,
    ReplaySessionResult,
    ReplaySessionSummary,
    ReplaySessionUpdate,
)
from services.replay_session_repo import (
    get_replay_session as get_replay_session_db,
    list_replay_sessions as list_replay_sessions_db,
    save_replay_session,
)
from services.replay_session_store import (
    get_replay_session as get_replay_session_mem,
    list_replay_sessions as list_replay_sessions_mem,
    upsert_replay_session,
)

router = APIRouter()


def _load_replay_session_any(replay_session_id: str) -> dict | None:
    try:
        session = get_replay_session_db(replay_session_id)
    except Exception:
        session = None

    if session is None:
        session = get_replay_session_mem(replay_session_id)

    return session


@router.post("/", response_model=ReplaySessionResult)
async def create_replay_session(request: ReplaySessionCreate):
    now = datetime.utcnow().isoformat()
    replay_session_id = str(uuid.uuid4())
    result = {
        "replay_session_id": replay_session_id,
        **request.model_dump(),
        "created_at": now,
        "updated_at": now,
    }

    upsert_replay_session(replay_session_id, result)

    try:
        save_replay_session(result)
    except Exception:
        pass

    return result


@router.put("/{replay_session_id}", response_model=ReplaySessionResult)
async def update_replay_session(replay_session_id: str, request: ReplaySessionUpdate):
    existing = _load_replay_session_any(replay_session_id)
    if existing is None:
        raise HTTPException(status_code=404, detail=f"Replay session '{replay_session_id}' not found.")

    result = {
        "replay_session_id": replay_session_id,
        **request.model_dump(),
        "created_at": existing["created_at"],
        "updated_at": datetime.utcnow().isoformat(),
    }

    upsert_replay_session(replay_session_id, result)

    try:
        save_replay_session(result)
    except Exception:
        pass

    return result


@router.get("/", response_model=list[ReplaySessionSummary])
async def list_replay_sessions():
    try:
        source = list_replay_sessions_db()
    except Exception:
        source = list_replay_sessions_mem()

    summaries = []
    for session in source:
        metrics = session.get("metrics", {})
        summaries.append({
            "replay_session_id": session["replay_session_id"],
            "name": session["name"],
            "symbol": session["symbol"],
            "interval": session["interval"],
            "start_date": session.get("start_date"),
            "end_date": session.get("end_date"),
            "source_backtest": session.get("source_backtest"),
            "status": session["status"],
            "current_bar_index": session.get("current_bar_index", 0),
            "total_pnl": metrics.get("total_pnl", 0),
            "total_trades": metrics.get("total_trades", 0),
            "created_at": session["created_at"],
            "updated_at": session["updated_at"],
        })
    return summaries


@router.get("/{replay_session_id}", response_model=ReplaySessionResult)
async def get_replay_session(replay_session_id: str):
    session = _load_replay_session_any(replay_session_id)

    if session is None:
        raise HTTPException(status_code=404, detail=f"Replay session '{replay_session_id}' not found.")

    return session
