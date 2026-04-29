from typing import Any, List
from collections import defaultdict
from datetime import datetime

import numpy as np
from services.serialization import to_plain_data

def evaluate_prop_firm(
    rules: dict,
    trades: List[dict],
    equity_curve: List[float],
    initial_balance: float,
    equity_timestamps: List[Any] | None = None,
) -> dict:
    """Score a run against the prop-firm rules bar by bar when we can.

    This keeps the evaluator honest for both backtests and replay saves. It
    watches the equity path for daily loss and drawdown breaches when candle
    timestamps are available, while still using closed trades for consistency
    and minimum trading-day counts. If older callers don't pass timestamps, it
    falls back to the old trade-date daily loss check instead of blowing up.
    """
    account_size = rules.get("account_size", initial_balance)
    daily_loss_limit = rules.get("daily_loss_limit", 0.04)
    max_drawdown_limit = rules.get("max_drawdown", 0.08)
    profit_target = rules.get("profit_target", 0.10)
    consistency_rule = rules.get("consistency_rule", True)
    consistency_threshold = rules.get("consistency_threshold", 0.30)
    min_trading_days = rules.get("min_trading_days")

    daily_pnls = _daily_pnls_from_trades(trades)
    trading_days_completed = len(daily_pnls)
    min_trading_days_passed = (
        min_trading_days is None or trading_days_completed >= min_trading_days
    )

    timeline = _build_equity_timeline(equity_curve, equity_timestamps)
    daily_loss_report = (
        _check_daily_loss_path(timeline, account_size, daily_loss_limit)
        if timeline
        else _check_daily_loss_legacy(daily_pnls, account_size, daily_loss_limit)
    )
    daily_loss_breached = daily_loss_report["breached"]

    drawdown_type = rules.get("drawdown_type", "intraday")
    drawdown_report = _check_drawdown_path(
        equity_curve,
        account_size,
        max_drawdown_limit,
        drawdown_type,
        timeline,
    )
    drawdown_breached = drawdown_report["breached"]
    actual_drawdown = drawdown_report["actual_drawdown_pct"]

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
    first_breach = _first_breach(daily_loss_report, drawdown_report)

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
            "daily_loss_limit_amount": round(account_size * daily_loss_limit, 2),
            "daily_loss_actual_loss":  round(daily_loss_report["actual_loss_amount"], 2),
            "daily_loss_actual_loss_pct": round(daily_loss_report["actual_loss_pct"], 4),
            "daily_loss_breach_time": daily_loss_report["breach_time"],
            "daily_loss_breach_equity": daily_loss_report["breach_equity"],
            "drawdown_type": drawdown_type,
            "max_drawdown_limit_pct": max_drawdown_limit,
            "actual_drawdown_pct":    round(actual_drawdown, 4),
            "drawdown_breach_time": drawdown_report["breach_time"],
            "drawdown_breach_equity": drawdown_report["breach_equity"],
            "drawdown_peak_equity": drawdown_report["peak_equity"],
            "drawdown_peak_time": drawdown_report["peak_time"],
            "profit_target_pct":      profit_target,
            "actual_profit_pct":      round(total_profit_pct, 4),
            "best_day_profit_pct":    round(best_day_pct, 4),
            "consistency_threshold":  consistency_threshold,
            "min_trading_days_required": min_trading_days,
            "trading_days_completed": trading_days_completed,
            "daily_pnls":             {k: round(v, 2) for k, v in daily_pnls.items()},
            "daily_equity":           daily_loss_report["daily_equity"],
            "first_breach_rule":      first_breach["rule"],
            "first_breach_time":      first_breach["time"],
        },
    })

def _daily_pnls_from_trades(trades: List[dict]) -> dict:
    daily_pnls: dict = defaultdict(float)
    for t in trades:
        try:
            exit_date = datetime.fromisoformat(t["exit_time"]).strftime("%Y-%m-%d")
            daily_pnls[exit_date] += t["pnl"]
        except (TypeError, ValueError):
            continue

    return dict(daily_pnls)


def _check_daily_loss_legacy(daily_pnls: dict, account_size: float, limit_pct: float):
    daily_loss_limit = account_size * limit_pct
    breached = False
    breach_day = None
    actual_loss = 0.0
    for pnl in daily_pnls.values():
        actual_loss = max(actual_loss, -float(pnl))
        if pnl < -daily_loss_limit:
            breached = True
            if breach_day is None:
                breach_day = next((day for day, value in daily_pnls.items() if value == pnl), None)
            break
    return {
        "breached": breached,
        "breach_time": breach_day,
        "breach_equity": None,
        "actual_loss_amount": actual_loss,
        "actual_loss_pct": actual_loss / account_size if account_size else 0.0,
        "daily_equity": [],
    }


def _check_daily_loss_path(timeline: list[dict], account_size: float, limit_pct: float) -> dict:
    daily_loss_limit = account_size * limit_pct
    by_day: dict[str, dict] = {}
    breached = False
    breach_time = None
    breach_equity = None
    actual_loss = 0.0

    for point in timeline:
        day = point["day"]
        equity = point["equity"]
        report = by_day.setdefault(
            day,
            {
                "date": day,
                "start_equity": equity,
                "low_equity": equity,
                "end_equity": equity,
                "max_loss": 0.0,
                "breach_time": None,
            },
        )
        report["end_equity"] = equity
        report["low_equity"] = min(report["low_equity"], equity)

        day_loss = max(0.0, report["start_equity"] - equity)
        report["max_loss"] = max(report["max_loss"], day_loss)
        actual_loss = max(actual_loss, day_loss)

        if not breached and day_loss > daily_loss_limit:
            breached = True
            breach_time = point["time"]
            breach_equity = equity
            report["breach_time"] = breach_time

    daily_equity = [
        {
            **report,
            "start_equity": round(report["start_equity"], 2),
            "low_equity": round(report["low_equity"], 2),
            "end_equity": round(report["end_equity"], 2),
            "max_loss": round(report["max_loss"], 2),
        }
        for report in by_day.values()
    ]

    return {
        "breached": breached,
        "breach_time": breach_time,
        "breach_equity": round(breach_equity, 2) if breach_equity is not None else None,
        "actual_loss_amount": actual_loss,
        "actual_loss_pct": actual_loss / account_size if account_size else 0.0,
        "daily_equity": daily_equity,
    }


def _check_drawdown_path(
    equity_curve: List[float],
    account_size: float,
    limit_pct: float,
    drawdown_type: str = "intraday",
    timeline: list[dict] | None = None,
):
    if len(equity_curve) < 2:
        return _empty_drawdown_report()

    values = np.array(equity_curve, dtype=float)
    times = [point["time"] for point in timeline] if timeline else [None] * len(values)
    actual_drawdown = 0.0
    breach_time = None
    breach_equity = None
    peak_equity = account_size
    peak_time = None
    running_peak = values[0]

    for index, equity in enumerate(values):
        time = times[index] if index < len(times) else None

        if drawdown_type == "eod":
            current_peak = account_size
            current_peak_time = None
            drawdown = max(0.0, (account_size - equity) / account_size) if account_size else 0.0
        else:
            if equity > running_peak:
                running_peak = equity
                peak_time = time
            current_peak = running_peak
            current_peak_time = peak_time
            drawdown = max(0.0, (running_peak - equity) / running_peak) if running_peak else 0.0

        if drawdown > actual_drawdown:
            actual_drawdown = float(drawdown)
            peak_equity = float(current_peak)
            peak_time = current_peak_time

        if breach_time is None and drawdown > limit_pct:
            breach_time = time
            breach_equity = float(equity)

    return {
        "breached": breach_time is not None,
        "actual_drawdown_pct": actual_drawdown,
        "breach_time": breach_time,
        "breach_equity": round(breach_equity, 2) if breach_equity is not None else None,
        "peak_equity": round(peak_equity, 2),
        "peak_time": peak_time,
    }


def _empty_drawdown_report() -> dict:
    return {
        "breached": False,
        "actual_drawdown_pct": 0.0,
        "breach_time": None,
        "breach_equity": None,
        "peak_equity": None,
        "peak_time": None,
    }


def _build_equity_timeline(equity_curve: List[float], equity_timestamps: List[Any] | None) -> list[dict]:
    if not equity_timestamps:
        return []

    limit = min(len(equity_curve), len(equity_timestamps))
    timeline = []
    for index in range(limit):
        timestamp = equity_timestamps[index]
        iso_time = _iso(timestamp)
        timeline.append({
            "time": iso_time,
            "day": _day_from_time(iso_time),
            "equity": float(equity_curve[index]),
        })
    return timeline


def _first_breach(daily_loss_report: dict, drawdown_report: dict) -> dict:
    candidates = [
        ("daily_loss", daily_loss_report.get("breach_time")),
        ("drawdown", drawdown_report.get("breach_time")),
    ]
    candidates = [(rule, time) for rule, time in candidates if time]
    if not candidates:
        return {"rule": None, "time": None}

    candidates.sort(key=lambda item: item[1])
    return {"rule": candidates[0][0], "time": candidates[0][1]}


def _iso(value: Any) -> str:
    return value.isoformat() if hasattr(value, "isoformat") else str(value)


def _day_from_time(value: str) -> str:
    try:
        return datetime.fromisoformat(value).strftime("%Y-%m-%d")
    except ValueError:
        return value[:10]
