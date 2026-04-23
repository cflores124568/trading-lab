from typing import List
from collections import defaultdict
from datetime import datetime

import numpy as np
from services.serialization import to_plain_data

def evaluate_prop_firm(
    rules: dict,
    trades: List[dict],
    equity_curve: List[float],
    initial_balance: float,
) -> dict:
    """Score a run against the prop-firm rules we actually enforce.

    This keeps the evaluator honest for both backtests and replay saves. It
    still uses a simplified internal rule model, but it now counts distinct
    trading days too so presets with a day minimum stop passing early.
    """
    account_size = rules.get("account_size", initial_balance)
    daily_loss_limit = rules.get("daily_loss_limit", 0.04)
    max_drawdown_limit = rules.get("max_drawdown", 0.08)
    profit_target = rules.get("profit_target", 0.10)
    consistency_rule = rules.get("consistency_rule", True)
    consistency_threshold = rules.get("consistency_threshold", 0.30)
    min_trading_days = rules.get("min_trading_days")

    # Daily loss limit
    daily_loss_breached, daily_pnls = _check_daily_loss(trades, account_size, daily_loss_limit)
    trading_days_completed = len(daily_pnls)
    min_trading_days_passed = (
        min_trading_days is None or trading_days_completed >= min_trading_days
    )

    # Max drawdown
    drawdown_type = rules.get("drawdown_type", "intraday")
    drawdown_breached, actual_drawdown = _check_drawdown(equity_curve, account_size, max_drawdown_limit, drawdown_type)

    # Profit target
    if len(equity_curve) > 0:
        final_balance = equity_curve[-1]
    else:
        final_balance = initial_balance

    total_profit_pct = (final_balance - account_size) / account_size
    profit_target_hit = total_profit_pct >= profit_target

    # Consistency rule
    consistency_passed = True
    best_day_pct       = 0.0
    if consistency_rule and daily_pnls:
        total_profit = final_balance - account_size
        if total_profit > 0:
            best_day = max(daily_pnls.values())
            best_day_pct = best_day / total_profit
            consistency_passed = best_day_pct <= consistency_threshold

    #Aggregate
    passed = (
    not daily_loss_breached
    and not drawdown_breached
    and profit_target_hit
    and consistency_passed
    and min_trading_days_passed
    )

    return to_plain_data({
        "passed":              passed,
        "daily_loss_breached": daily_loss_breached,
        "drawdown_breached":   drawdown_breached,
        "profit_target_hit":   profit_target_hit,
        "consistency_passed":  consistency_passed,
        "min_trading_days_passed": min_trading_days_passed,
        "details": {
            "account_size":           account_size,
            "daily_loss_limit_pct":   daily_loss_limit,
            "drawdown_type": drawdown_type,
            "max_drawdown_limit_pct": max_drawdown_limit,
            "actual_drawdown_pct":    round(actual_drawdown, 4),
            "profit_target_pct":      profit_target,
            "actual_profit_pct":      round(total_profit_pct, 4),
            "best_day_profit_pct":    round(best_day_pct, 4),
            "consistency_threshold":  consistency_threshold,
            "min_trading_days_required": min_trading_days,
            "trading_days_completed": trading_days_completed,
            "daily_pnls":             {k: round(v, 2) for k, v in daily_pnls.items()},
        },
    })

def _check_daily_loss(trades: List[dict], account_size: float, limit_pct: float):
    daily_pnls: dict = defaultdict(float)
    for t in trades:
        try:
            exit_date = datetime.fromisoformat(t["exit_time"]).strftime("%Y-%m-%d")
            daily_pnls[exit_date] += t["pnl"]
        except (TypeError, ValueError):
            continue

    daily_loss_limit = account_size * limit_pct
    breached = False
    for pnl in daily_pnls.values():
        if pnl < -daily_loss_limit:
            breached = True
            break
    return breached, dict(daily_pnls)

def _check_drawdown(equity_curve: List[float], account_size: float, limit_pct: float, drawdown_type: str="intraday"):
    if len(equity_curve) < 2:
        return False, 0.0
    
    eq = np.array(equity_curve)

    if drawdown_type == "eod":
        dd = (account_size - eq) / account_size
    else:
        peak = np.maximum.accumulate(eq)
        dd = (peak - eq) / peak

    max_dd = float(np.max(dd))
    return max_dd > limit_pct, max_dd
