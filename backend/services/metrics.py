import numpy as np
import pandas as pd
from typing import List, Optional, Sequence


ANNUALIZATION_DAYS = 252


def calculate_metrics(
    trades: List[dict],
    equity_curve: List[float],
    initial_balance: float,
    *,
    equity_timestamps: Optional[Sequence] = None,
) -> dict:
    """Compute the saved stats from closed trades and the visible equity path.

    Most runs end with every trade closed, so trade PnL and end equity tell the
    same story. When a prop-rule breach stops the report mid-trade though, I
    still want `total_pnl` and drawdown to reflect that frozen equity snapshot
    instead of pretending nothing happened just because the trade never got an
    exit fill.

    Risk ratios use end-of-day equity returns whenever timestamps are
    available. That matters because a strategy can take ten trades in one
    session; annualizing a per-trade series with sqrt(252) treats each of those
    ten trades as its own day and inflates the result. When there are no
    timestamps (for example a live paper session with only a marked equity
    list), the fallback is a per-trade ratio and `sharpe_basis` says so
    explicitly.
    """
    final_balance = float(equity_curve[-1]) if equity_curve else float(initial_balance)
    total_pnl = final_balance - float(initial_balance)
    max_dd = _max_drawdown(equity_curve)

    daily_returns = _daily_equity_returns(equity_curve, equity_timestamps)
    if len(daily_returns) >= 2:
        sharpe = _annualized_sharpe(daily_returns)
        sortino = _annualized_sortino(daily_returns)
        sharpe_basis = "daily"
    elif len(trades) >= 2:
        pnls = np.array([t["pnl"] for t in trades], dtype=float)
        sharpe = _trade_sharpe(pnls)
        sortino = _trade_sortino(pnls)
        sharpe_basis = "trade"
    else:
        sharpe = 0.0
        sortino = 0.0
        sharpe_basis = "insufficient"

    if not trades:
        return _empty_metrics(
            total_pnl=total_pnl,
            max_drawdown=max_dd,
            sharpe=sharpe,
            sortino=sortino,
            sharpe_basis=sharpe_basis,
        )

    pnls = np.array([t["pnl"] for t in trades], dtype=float)
    total_trades   = len(trades)
    winning_trades = int(np.sum(pnls > 0))
    losing_trades  = int(np.sum(pnls < 0))
    win_rate       = round(winning_trades / total_trades, 4) if total_trades else 0.0
    closed_trade_total = float(np.sum(pnls))
    average_pnl = round(closed_trade_total / total_trades, 2)
    gross_wins   = float(np.sum(pnls[pnls > 0]))
    gross_losses = float(np.abs(np.sum(pnls[pnls < 0])))
    if gross_losses == 0:
        # JSON responses can't safely carry Infinity, so for all-win samples we
        # return gross wins as a finite proxy instead of blowing up serialization.
        profit_factor = round(gross_wins, 4) if gross_wins > 0 else 0.0
    else:
        profit_factor = round(gross_wins / gross_losses, 4)
    avg_duration = _avg_duration_minutes(trades)
    avg_r, total_r, r_profit_factor = _r_metrics(trades)
    risk_budget_exceeded = sum(1 for t in trades if t.get("risk_exceeded"))

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
        "sharpe_basis":       sharpe_basis,
        "avg_r_multiple":     avg_r,
        "total_r":            total_r,
        "r_profit_factor":    r_profit_factor,
        "risk_budget_exceeded_trades": risk_budget_exceeded,
        "avg_trade_duration": round(avg_duration, 2),
        "best_trade":         round(float(np.max(pnls)), 2),
        "worst_trade":        round(float(np.min(pnls)), 2),
    }

#Helpers
def _empty_metrics(
    *,
    total_pnl: float = 0.0,
    max_drawdown: float = 0.0,
    sharpe: float = 0.0,
    sortino: float = 0.0,
    sharpe_basis: str = "insufficient",
) -> dict:
    return {
        "total_trades": 0, "winning_trades": 0, "losing_trades": 0,
        "win_rate": 0.0, "total_pnl": round(total_pnl, 2), "average_pnl": 0.0,
        "profit_factor": 0.0, "max_drawdown": round(max_drawdown, 4),
        "sharpe_ratio": sharpe, "sortino_ratio": sortino,
        "sharpe_basis": sharpe_basis,
        "avg_r_multiple": None, "total_r": None, "r_profit_factor": None,
        "risk_budget_exceeded_trades": 0,
        "avg_trade_duration": 0.0,
        "best_trade": 0.0, "worst_trade": 0.0,
    }


def _r_metrics(trades: List[dict]) -> tuple[Optional[float], Optional[float], Optional[float]]:
    """Summarize R multiples only for trades that had a defined initial risk."""
    r_values = np.array(
        [
            value
            for value in (
                float(t["r_multiple"]) for t in trades if t.get("r_multiple") is not None
            )
            if np.isfinite(value)
        ],
        dtype=float,
    )
    if len(r_values) == 0:
        return None, None, None

    gross_r_wins = float(np.sum(r_values[r_values > 0]))
    gross_r_losses = float(np.abs(np.sum(r_values[r_values < 0])))
    if gross_r_losses == 0:
        r_profit_factor = round(gross_r_wins, 4) if gross_r_wins > 0 else 0.0
    else:
        r_profit_factor = round(gross_r_wins / gross_r_losses, 4)
    return (
        round(float(np.mean(r_values)), 4),
        round(float(np.sum(r_values)), 4),
        r_profit_factor,
    )

def _max_drawdown(equity_curve: List[float]) -> float:
    if len(equity_curve) < 2:
        return 0.0
    eq  = np.array(equity_curve)
    peak = np.maximum.accumulate(eq)
    dd   = (peak - eq) / peak
    return float(np.max(dd))

def _daily_equity_returns(
    equity_curve: List[float],
    equity_timestamps: Optional[Sequence],
) -> np.ndarray:
    """Collapse the equity path to one point per calendar day, then diff it."""
    if (
        equity_timestamps is None
        or len(equity_timestamps) == 0
        or len(equity_timestamps) != len(equity_curve)
        or len(equity_curve) < 2
    ):
        return np.array([], dtype=float)

    try:
        index = pd.to_datetime(list(equity_timestamps), errors="coerce")
    except (TypeError, ValueError, OverflowError):
        return np.array([], dtype=float)

    if not isinstance(index, pd.DatetimeIndex) or index.isna().any():
        return np.array([], dtype=float)

    # Aware timestamps are grouped by New York trading date so an evening UTC
    # bar does not land on the wrong day. Naive timestamps are taken as-is,
    # matching the rest of the backend's "naive means UTC" convention.
    if index.tz is not None:
        index = index.tz_convert("America/New_York")

    frame = pd.DataFrame(
        {"equity": np.asarray(equity_curve, dtype=float)},
        index=index,
    )
    end_of_day = frame.groupby(frame.index.date)["equity"].last().sort_index()
    values = end_of_day.to_numpy(dtype=float)

    if len(values) < 2:
        return np.array([], dtype=float)

    previous = values[:-1]
    with np.errstate(divide="ignore", invalid="ignore"):
        returns = np.where(previous != 0, (values[1:] - previous) / previous, np.nan)
    return returns[np.isfinite(returns)]

def _annualized_sharpe(returns: np.ndarray) -> float:
    if len(returns) < 2:
        return 0.0
    std = np.std(returns, ddof=1)
    if std == 0:
        return 0.0
    return round(float(np.mean(returns) / std * np.sqrt(ANNUALIZATION_DAYS)), 4)

def _annualized_sortino(returns: np.ndarray) -> float:
    if len(returns) < 2:
        return 0.0
    # Downside deviation across every observation; zero for returns that never
    # fall below the target. That ratio is undefined, so report 0.0 rather than
    # sending Infinity through JSON.
    downside = np.minimum(returns, 0.0)
    down_std = float(np.sqrt(np.mean(np.square(downside))))
    if down_std == 0:
        return 0.0
    return round(float(np.mean(returns) / down_std * np.sqrt(ANNUALIZATION_DAYS)), 4)

def _trade_sharpe(pnls: np.ndarray) -> float:
    """Fallback ratio, deliberately not annualized.

    Without timestamps there is no honest way to know how many trades make a
    year, so this stays a per-trade signal-to-noise number and the caller
    labels it as such.
    """
    if len(pnls) < 2:
        return 0.0
    std = np.std(pnls, ddof=1)
    if std == 0:
        return 0.0
    return round(float(np.mean(pnls) / std), 4)

def _trade_sortino(pnls: np.ndarray) -> float:
    if len(pnls) < 2:
        return 0.0
    downside = np.minimum(pnls, 0.0)
    down_std = float(np.sqrt(np.mean(np.square(downside))))
    if down_std == 0:
        return 0.0
    return round(float(np.mean(pnls) / down_std), 4)

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
