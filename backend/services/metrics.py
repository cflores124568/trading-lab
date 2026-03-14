import numpy as np
from typing import List

def calculate_metrics(trades: List[dict], equity_curve: List[float], initial_balance: float) -> dict:
    #Compute every metric in one pass over the trade list.
    if not trades:
        return _empty_metrics()

    pnls = np.array([t["pnl"] for t in trades], dtype=float)
    total_trades   = len(trades)
    winning_trades = int(np.sum(pnls > 0))
    losing_trades  = int(np.sum(pnls < 0))
    win_rate       = round(winning_trades / total_trades, 4) if total_trades else 0.0
    total_pnl  = float(np.sum(pnls))
    average_pnl = round(total_pnl / total_trades, 2)
    gross_wins   = float(np.sum(pnls[pnls > 0]))
    gross_losses = float(np.abs(np.sum(pnls[pnls < 0])))
    profit_factor = round(gross_wins / gross_losses, 4) if gross_losses != 0 else float("inf")
    max_dd = _max_drawdown(equity_curve)
    sharpe  = _sharpe_ratio(pnls)
    sortino = _sortino_ratio(pnls)
    avg_duration = _avg_duration_minutes(trades)

    return {
        "total_trades":       total_trades,
        "winning_trades":     winning_trades,
        "losing_trades":      losing_trades,
        "win_rate":           win_rate,
        "total_pnl":          round(total_pnl, 2),
        "average_pnl":        average_pnl,
        "profit_factor":      profit_factor,
        "max_drawdown":       round(max_dd, 4),
        "sharpe_ratio":       sharpe,
        "sortino_ratio":      sortino,
        "avg_trade_duration": round(avg_duration, 2),
        "best_trade":         round(float(np.max(pnls)), 2),
        "worst_trade":        round(float(np.min(pnls)), 2),
    }

#Helpers
def _empty_metrics() -> dict:
    return {
        "total_trades": 0, "winning_trades": 0, "losing_trades": 0,
        "win_rate": 0.0, "total_pnl": 0.0, "average_pnl": 0.0,
        "profit_factor": 0.0, "max_drawdown": 0.0, "sharpe_ratio": 0.0,
        "sortino_ratio": 0.0, "avg_trade_duration": 0.0,
        "best_trade": 0.0, "worst_trade": 0.0,
    }

def _max_drawdown(equity_curve: List[float]) -> float:
    if len(equity_curve) < 2:
        return 0.0
    eq  = np.array(equity_curve)
    peak = np.maximum.accumulate(eq)
    dd   = (peak - eq) / peak
    return float(np.max(dd))

def _sharpe_ratio(pnls: np.ndarray, risk_free: float = 0.0) -> float:
    if len(pnls) < 2:
        return 0.0
    excess = pnls - risk_free
    std    = np.std(excess, ddof=1)
    if std == 0:
        return 0.0
    return round(float(np.mean(excess) / std * np.sqrt(252)), 4)

def _sortino_ratio(pnls: np.ndarray, risk_free: float = 0.0) -> float:
    if len(pnls) < 2:
        return 0.0
    excess      = pnls - risk_free
    downside    = excess[excess < 0]
    down_std    = np.std(downside, ddof=1) if len(downside) > 1 else 0.0
    if down_std == 0:
        return 0.0
    return round(float(np.mean(excess) / down_std * np.sqrt(252)), 4)

def _avg_duration_minutes(trades: List[dict]) -> float:
    from datetime import datetime

    durations = []
    for t in trades:
        try:
            entry = datetime.fromisoformat(t["entry_time"])
            exit_ = datetime.fromisoformat(t["exit_time"])
            durations.append((exit_ - entry).total_seconds() / 60)
        except (TypeError, ValueError):
            continue
    return float(np.mean(durations)) if durations else 0.0