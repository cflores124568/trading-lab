import uuid
from datetime import datetime

from fastapi import HTTPException

from schemas import BacktestRequest
from services.backtest_engine import run_backtest
from services.backtest_repo import save_backtest
from services.backtest_store import add_backtest, delete_backtest
from services.indicators import add_all_indicators
from services.metrics import calculate_metrics
from services.prop_firm_eval import evaluate_prop_firm
from services.serialization import to_plain_data
from services.strategy import generate_signals


def build_backtest_result(
    dataset: dict,
    request: BacktestRequest,
    *,
    backtest_id: str | None = None,
    created_at: str | None = None,
) -> dict:
    """Run one backtest from an already-loaded dataset and return the API shape.

    This keeps the actual backtest pipeline in one place, so normal backtests
    and experiment batches use the exact same indicator, signal, metrics, and
    prop-eval path instead of drifting apart later.
    """
    df = dataset["df"].copy()

    if request.start_date:
        df = df.loc[request.start_date:]
    if request.end_date:
        df = df.loc[:request.end_date]

    if df.empty:
        raise ValueError("Date range produced an empty dataset.")

    df = add_all_indicators(df, request.strategy.params, strategy_type=request.strategy.type)
    df = generate_signals(df, request.strategy.type, request.strategy.params)

    engine_result = run_backtest(
        df,
        initial_balance=request.initial_balance,
        position_size=request.position_size,
        commission=request.commission,
        tick_size=request.tick_size,
        tick_value=request.tick_value,
        slippage_ticks=request.slippage_ticks,
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

    return to_plain_data({
        "backtest_id": backtest_id or str(uuid.uuid4()),
        "dataset_id": request.dataset_id,
        "symbol": dataset["info"].get("symbol", ""),
        "replay_context": build_replay_context(dataset),
        "strategy": request.strategy.model_dump(),
        "prop_firm_rules": request.prop_firm_rules.model_dump(),
        "run_config": {
            "initial_balance": request.initial_balance,
            "position_size": request.position_size,
            "commission": request.commission,
            "tick_size": request.tick_size,
            "tick_value": request.tick_value,
            "slippage_ticks": request.slippage_ticks,
        },
        "status": "completed",
        "created_at": created_at or datetime.utcnow().isoformat(),
        "trades": trades,
        "metrics": metrics,
        "prop_firm_eval": prop_eval,
        "equity_curve": equity_curve,
    })


def persist_backtest_result(result: dict) -> None:
    """Persist a completed backtest with memory-first fallback behavior.

    I keep the in-memory copy fast for local reads, then mirror it into Postgres
    when the DB is configured. If that DB save blows up, the memory copy gets
    rolled back so callers don't think the run is durable when it isn't.
    """
    add_backtest(result["backtest_id"], result)

    if not _db_required():
        return

    try:
        save_backtest(result)
    except Exception as exc:
        delete_backtest(result["backtest_id"])
        raise HTTPException(status_code=503, detail=f"Backtest save failed: {exc}") from exc


def build_replay_context(dataset: dict) -> dict | None:
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


def _db_required() -> bool:
    from services.db import db_configured

    return db_configured()
