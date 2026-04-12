import uuid
from datetime import datetime
from fastapi import APIRouter, HTTPException, Query
from schemas import BacktestRequest, BacktestResult, BacktestSummary, BacktestCompare
from services.backtest_repo import (
    get_backtest as get_backtest_db, list_backtests as list_backtests_db, save_backtest,
)
from services.backtest_store import (
    add_backtest, delete_backtest, get_backtest as get_backtest_mem, list_backtests as list_backtests_mem,
)
from services.data_loader import get_candles, get_dataset
from services.indicators import add_all_indicators
from services.strategy import generate_signals
from services.backtest_engine import run_backtest
from services.metrics import calculate_metrics
from services.prop_firm_eval import evaluate_prop_firm

router = APIRouter()


def _db_required() -> bool:
    from services.db import db_configured
    return db_configured()

def _load_backtest_any(backtest_id: str) -> dict | None:
    """Load a backtest from DB first, then fall back to memory.

    This keeps the read path simple while we straddle both storage modes. If
    Postgres is down or the row isn't there yet, the in-memory copy still works.
    """
    if _db_required():
        try:
            bt = get_backtest_db(backtest_id)
        except Exception as exc:
            raise HTTPException(status_code=503, detail=f"Backtest storage unavailable: {exc}")
    else:
        bt = get_backtest_mem(backtest_id)

    return _ensure_backtest_replay_context(bt)


def _ensure_backtest_replay_context(backtest: dict | None) -> dict | None:
    """Backfill `replay_context` from a still-loaded dataset when we can.

    Older saved backtests predate durable replay metadata, so the cleanest
    upgrade path is to rebuild that context from the original in-memory dataset
    if it's still around. When that works we persist the richer payload back to
    storage so the next read doesn't have to guess again.
    """
    if backtest is None or backtest.get("replay_context"):
        return backtest

    dataset_id = backtest.get("dataset_id")
    if not dataset_id:
        return backtest

    try:
        dataset = get_dataset(dataset_id)
    except Exception:
        return backtest

    replay_context = _build_replay_context(dataset)
    if not replay_context:
        return backtest

    next_backtest = {**backtest, "replay_context": replay_context}

    try:
        save_backtest(next_backtest)
    except Exception:
        pass

    return next_backtest


def _build_replay_context(dataset: dict) -> dict | None:
    """Persist enough source metadata to rebuild replay candles later."""
    info = dataset.get("info", {})
    source = info.get("source")
    symbol = info.get("symbol")
    interval = info.get("interval")

    if source == "timescaledb" and symbol and interval:
        return {
            "source": source,
            "symbol": symbol,
            "interval": interval,
            "start_date": info.get("start_date"),
            "end_date": info.get("end_date"),
        }

    return None


def _df_to_candles(df) -> list[dict]:
    if df.empty:
        return []

    df = df.reset_index()
    time_col = df.columns[0]
    df[time_col] = df[time_col].apply(
        lambda value: value.to_pydatetime() if hasattr(value, "to_pydatetime") else value
    )

    candles = []
    for row in df.itertuples(index=False):
        ts = getattr(row, time_col)
        candles.append({
            "time": int(ts.timestamp()),
            "open": round(float(row.open), 2),
            "high": round(float(row.high), 2),
            "low": round(float(row.low), 2),
            "close": round(float(row.close), 2),
            "volume": int(float(row.volume)),
        })

    return candles

@router.post("/", response_model=BacktestResult)
async def create_backtest(request: BacktestRequest):
    """
    Full pipeline:
      1. Load dataset
      2. Slice by date range
      3. Attach indicators
      4. Generate signals
      5. Run bar-by-bar engine
      6. Calculate metrics
      7. Evaluate prop-firm rules
      8. Store & return result
    """
    try:
        dataset = get_dataset(request.dataset_id)
    except KeyError:
        raise HTTPException(status_code=404, detail=f"Dataset '{request.dataset_id}' not found.")
    except RuntimeError as exc:
        raise HTTPException(status_code=503, detail=str(exc))

    df = dataset["df"].copy() #isolate from in-memory store to avoid mutating cached data

    if request.start_date:
        df = df.loc[request.start_date:]
    if request.end_date:
        df = df.loc[:request.end_date]

    if df.empty:
        raise HTTPException(status_code=400, detail="Date range produced an empty dataset.")

    df = add_all_indicators(df, request.strategy.params, strategy_type=request.strategy.type)
    df = generate_signals(df, request.strategy.type, request.strategy.params)

    engine_result = run_backtest(
        df,
        initial_balance=request.initial_balance,
        position_size=request.position_size,
        commission=request.commission,
    )

    trades = engine_result["trades"]
    equity_curve = engine_result["equity_curve"]

    metrics = calculate_metrics(trades, equity_curve, request.initial_balance)
    prop_eval = evaluate_prop_firm(
        rules=request.prop_firm_rules.model_dump(),
        trades=trades,
        equity_curve=equity_curve,
        initial_balance=request.initial_balance,
    )

    backtest_id = str(uuid.uuid4())
    result = {
        "backtest_id": backtest_id,
        "dataset_id": request.dataset_id,
        "symbol": dataset["info"].get("symbol", ""),
        "replay_context": _build_replay_context(dataset),
        "strategy": request.strategy.model_dump(),
        "prop_firm_rules": request.prop_firm_rules.model_dump(),
        "status": "completed",
        "created_at": datetime.utcnow().isoformat(),
        "trades": trades,
        "metrics": metrics,
        "prop_firm_eval": prop_eval,
        "equity_curve": equity_curve,
    }

    add_backtest(backtest_id, result)

    if _db_required():
        try:
            save_backtest(result)
        except Exception as exc:
            delete_backtest(backtest_id)
            raise HTTPException(status_code=503, detail=f"Backtest save failed: {exc}")

    return result

@router.get("/", response_model=list[BacktestSummary])
async def list_backtests():
    if _db_required():
        try:
            source = list_backtests_db()
        except Exception as exc:
            raise HTTPException(status_code=503, detail=f"Backtest storage unavailable: {exc}")
    else:
        source = list_backtests_mem()

    summaries = []
    for bt in source:
        hydrated = _ensure_backtest_replay_context(bt) or bt
        summaries.append({
            "backtest_id": hydrated["backtest_id"],
            "dataset_id": hydrated["dataset_id"],
            "symbol": hydrated.get("symbol", ""),
            "replay_context": hydrated.get("replay_context"),
            "strategy_type": hydrated["strategy"]["type"],
            "status": hydrated["status"],
            "total_pnl": hydrated["metrics"]["total_pnl"],
            "win_rate": hydrated["metrics"]["win_rate"],
            "created_at": hydrated["created_at"],
        })
    return summaries

@router.get("/compare", response_model=BacktestCompare)
async def compare_backtests(a: str, b: str):
    bt_a = _load_backtest_any(a)
    bt_b = _load_backtest_any(b)

    if bt_a is None:
        raise HTTPException(status_code=404, detail=f"Backtest A '{a}' not found.")
    if bt_b is None:
        raise HTTPException(status_code=404, detail=f"Backtest B '{b}' not found.")

    comparison = {}
    for key in ["total_pnl", "win_rate", "profit_factor", "max_drawdown", "sharpe_ratio", "sortino_ratio", "total_trades"]:
        val_a = bt_a["metrics"].get(key, 0)
        val_b = bt_b["metrics"].get(key, 0)
        comparison[key] = {
            "a": val_a,
            "b": val_b,
            "diff": round(val_b - val_a, 4),
            "winner": "a" if val_a > val_b else ("b" if val_b > val_a else "tie"),
        }

    return {
        "backtest_a": bt_a,
        "backtest_b": bt_b,
        "comparison": comparison,
    }


@router.get("/{backtest_id}/candles")
async def get_backtest_candles(
    backtest_id: str,
    limit: int | None = Query(default=None, ge=1, le=50_000),
):
    bt = _load_backtest_any(backtest_id)
    if bt is None:
        raise HTTPException(status_code=404, detail=f"Backtest '{backtest_id}' not found.")

    replay_context = bt.get("replay_context") or {}
    if replay_context.get("source") == "timescaledb" and replay_context.get("symbol"):
        try:
            from services.db import get_ohlcv

            df = get_ohlcv(
                symbol=replay_context["symbol"],
                interval=replay_context.get("interval") or "1min",
                start_date=replay_context.get("start_date"),
                end_date=replay_context.get("end_date"),
                limit=limit,
            )
        except Exception as exc:
            raise HTTPException(status_code=503, detail=f"Database error: {exc}")

        return _df_to_candles(df)

    dataset_id = bt.get("dataset_id")
    if not dataset_id:
        raise HTTPException(status_code=404, detail="Replay candles are unavailable for this backtest.")

    try:
        return get_candles(dataset_id, limit=limit)
    except KeyError:
        raise HTTPException(
            status_code=404,
            detail="Replay candles are unavailable because the original dataset is no longer loaded.",
        )
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))

@router.get("/{backtest_id}", response_model=BacktestResult)
async def get_backtest(backtest_id: str):
    bt = _load_backtest_any(backtest_id)

    if bt is None:
        raise HTTPException(status_code=404, detail=f"Backtest '{backtest_id}' not found.")

    return bt
