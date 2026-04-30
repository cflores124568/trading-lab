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
    equity_timestamps = list(df.index)
    prop_rules = request.prop_firm_rules.model_dump()
    prop_eval = evaluate_prop_firm(
        rules=request.prop_firm_rules.model_dump(),
        trades=trades,
        equity_curve=equity_curve,
        initial_balance=request.initial_balance,
        equity_timestamps=equity_timestamps,
    )
    trades, equity_curve, prop_eval = _stop_backtest_at_first_breach(
        trades=trades,
        equity_curve=equity_curve,
        equity_timestamps=equity_timestamps,
        prop_eval=prop_eval,
        prop_rules=prop_rules,
        initial_balance=request.initial_balance,
    )
    metrics = calculate_metrics(trades, equity_curve, request.initial_balance)

    return to_plain_data({
        "backtest_id": backtest_id or str(uuid.uuid4()),
        "dataset_id": request.dataset_id,
        "symbol": dataset["info"].get("symbol", ""),
        "replay_context": build_replay_context(dataset),
        "strategy": request.strategy.model_dump(),
        "prop_firm_rules": prop_rules,
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


def _stop_backtest_at_first_breach(
    *,
    trades: list[dict],
    equity_curve: list[float],
    equity_timestamps: list,
    prop_eval: dict,
    prop_rules: dict,
    initial_balance: float,
) -> tuple[list[dict], list[float], dict]:
    """Freeze the saved run at the first prop breach instead of drifting past it.

    I still use the full run once to discover the first breach honestly. After
    that I slice the equity path there, drop any later closed trades from the
    saved report, and recalc prop-eval on the stopped view so the result shows
    what the account looked like when it actually failed.
    """
    stopped = _build_stopped_run(
        trades=trades,
        equity_curve=equity_curve,
        equity_timestamps=equity_timestamps,
        prop_eval=prop_eval,
        initial_balance=initial_balance,
    )
    if stopped is None:
        return trades, equity_curve, prop_eval

    stopped_prop_eval = evaluate_prop_firm(
        rules=prop_rules,
        trades=stopped["trades"],
        equity_curve=stopped["equity_curve"],
        initial_balance=initial_balance,
        equity_timestamps=stopped["equity_timestamps"],
    )
    stopped_prop_eval["details"].update(stopped["snapshot"])
    return stopped["trades"], stopped["equity_curve"], stopped_prop_eval


def _build_stopped_run(
    *,
    trades: list[dict],
    equity_curve: list[float],
    equity_timestamps: list,
    prop_eval: dict,
    initial_balance: float,
) -> dict | None:
    """Cut the run at the first breach and keep a snapshot of that moment.

    This is intentionally mark-to-market, not a fake liquidation. If the run
    blows through a rule while a trade is still open, I keep the equity exactly
    where the breach happened and stash the floating PnL separately so the
    report doesn't quietly smuggle in post-failure candles.
    """
    details = prop_eval.get("details") or {}
    breach_time = details.get("first_breach_time")
    if not breach_time:
        return None

    breach_index = _find_time_index(equity_timestamps, breach_time)
    if breach_index is None:
        return None

    stopped_equity_curve = equity_curve[: breach_index + 1]
    stopped_timestamps = equity_timestamps[: breach_index + 1]
    stopped_trades = [
        trade for trade in trades if _trade_happened_by(breach_time, trade.get("exit_time"))
    ]

    breach_equity = float(stopped_equity_curve[-1]) if stopped_equity_curve else float(initial_balance)
    closed_balance = float(initial_balance) + sum(float(trade.get("pnl") or 0.0) for trade in stopped_trades)
    open_pnl = breach_equity - closed_balance

    return {
        "trades": stopped_trades,
        "equity_curve": stopped_equity_curve,
        "equity_timestamps": stopped_timestamps,
        "snapshot": {
            "stopped_at_first_breach": True,
            "first_breach_equity": round(breach_equity, 2),
            "first_breach_balance": round(closed_balance, 2),
            "first_breach_open_pnl": round(open_pnl, 2),
            "stopped_trade_count": len(stopped_trades),
            "trades_after_breach_ignored": max(0, len(trades) - len(stopped_trades)),
        },
    }


def _find_time_index(equity_timestamps: list, target_time: str) -> int | None:
    normalized_target = _normalize_time(target_time)
    for index, timestamp in enumerate(equity_timestamps):
        if _normalize_time(timestamp) == normalized_target:
            return index
    return None


def _trade_happened_by(target_time: str, exit_time: str | None) -> bool:
    if not exit_time:
        return False
    return _normalize_time(exit_time) <= _normalize_time(target_time)


def _normalize_time(value) -> str:
    if hasattr(value, "isoformat"):
        value = value.isoformat()

    try:
        return datetime.fromisoformat(str(value)).isoformat()
    except ValueError:
        return str(value)


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
