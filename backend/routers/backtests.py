import uuid
from datetime import datetime
from fastapi import APIRouter, HTTPException
from schemas import BacktestRequest, BacktestResult, BacktestSummary, BacktestCompare
from services.backtest_repo import (
    get_backtest as get_backtest_db, list_backtests as list_backtests_db, save_backtest,
)
from services.backtest_store import (
    add_backtest, get_backtest as get_backtest_mem, list_backtests as list_backtests_mem,
)
from services.data_loader import get_dataset
from services.indicators import add_all_indicators
from services.strategy import generate_signals
from services.backtest_engine import run_backtest
from services.metrics import calculate_metrics
from services.prop_firm_eval import evaluate_prop_firm

router = APIRouter()

def _load_backtest_any(backtest_id: str) -> dict | None:
    """Load a backtest from DB first, then fall back to memory.

    This keeps the read path simple while we straddle both storage modes. If
    Postgres is down or the row isn't there yet, the in-memory copy still works.
    """
    try:
        bt = get_backtest_db(backtest_id)
    except Exception:
        bt = None

    if bt is None:
        bt = get_backtest_mem(backtest_id)

    return bt

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

    try:
        save_backtest(result)
    except Exception:
        # DB persistence is best-effort for now; in-memory result still works
        pass

    return result

@router.get("/", response_model=list[BacktestSummary])
async def list_backtests():
    try:
        source = list_backtests_db()
    except Exception:
        source = list_backtests_mem()

    summaries = []
    for bt in source:
        summaries.append({
            "backtest_id": bt["backtest_id"],
            "dataset_id": bt["dataset_id"],
            "symbol": bt.get("symbol", ""),
            "strategy_type": bt["strategy"]["type"],
            "status": bt["status"],
            "total_pnl": bt["metrics"]["total_pnl"],
            "win_rate": bt["metrics"]["win_rate"],
            "created_at": bt["created_at"],
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

@router.get("/{backtest_id}", response_model=BacktestResult)
async def get_backtest(backtest_id: str):
    bt = _load_backtest_any(backtest_id)

    if bt is None:
        raise HTTPException(status_code=404, detail=f"Backtest '{backtest_id}' not found.")

    return bt